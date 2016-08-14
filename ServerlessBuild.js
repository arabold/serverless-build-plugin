import Promise from 'bluebird'
import path from 'path'
import Yazl from 'yazl'
import fs from 'fs-extra'
import { typeOf } from 'lutils'
import isStream from 'is-stream'
import WebpackBuilder from './Webpack'
import Bundler from './Bundler'

Promise.promisifyAll(fs)

// FIXME:
console.inspect = (val, ...args) => console.log( require('util').inspect(val, { depth: 6, colors: true, ...args }) )


export default class ServerlessBuild {
    config = {
        tryFiles: [
            "webpack.config.js",
            "build.js",
        ],

        artifact: 'handler.js'
    }

    constructor(serverless, options = {}) {
        this.serverless = serverless
        this.config    = {
            ...this.config,
            ...(this.serverless.service.custom.build || {}),
            ...options
        }

        if ( ! this.serverless.getVersion().startsWith('1') )
            throw new this.serverless.classes.Error(
                'serverless-build-plugin requires serverless@1.x.x'
            )

        console.log({ options: this.config })

        this.hooks = {
            'before:deploy:createDeploymentPackage': (...args) => this.build(...args)
        }
    }

    /**
     *  Builds either from file or through the babel optimizer.
     */
    async build(...args) {
        console.log({ args }) // TODO: capture these

        if ( this.config.bundle )
            return this.bundle() // TODO: add our own optimizer to babel + minify/bundle non-dev node_modules
        else
            return this.buildFromFile()
    }

    /**
     *  Bundles the project, maintaining the same structure and minifying.
     *  Also includes all node_modules and their dependencies, also minified. No dev deps.
     */
    async bundle() {
        const slsTmpDir   = path.join(this.serverless.config.servicePath, './.serverless')
        const buildTmpDir = path.join(slsTmpDir, './build') // TODO: consolidate these paths in the constructor

        return new Bundler(this, buildTmpDir).bundle() // TODO: improve these params, too brittle
    }

    /**
     *  Handles building from a build file's output.
     */
    async buildFromFile() {
        const {
            service : { service },
            config  : { servicePath }
        } = this.serverless

        const slsTmpDir      = path.join(servicePath, './.serverless')
        const buildTmpDir    = path.join(slsTmpDir, './build')
        const artifactTmpDir = path.join(slsTmpDir, './artifacts')

        //
        // RESOLVE BUILD FILE
        //

        let builderFilePath = await this.tryBuildFiles()

        if ( ! builderFilePath )
            throw new Error("Unrecognized build file path")

        builderFilePath = path.resolve(servicePath, builderFilePath)

        let result = require(builderFilePath)

        // Resolve any functions...
        if ( typeOf.Function(result) )
            result = await Promise.try(() => result(this))

        // Ensure directories
        await fs.mkdirsAsync(buildTmpDir)
        await fs.mkdirsAsync(artifactTmpDir)

        // Prepare zip instance
        const zipPath    = path.resolve(artifactTmpDir, `./${service}-${new Date().getTime()}.zip`)
        const zip        = new Yazl.ZipFile()
        const zipOptions = { compress: true }

        //
        // HANDLE RESULT OUTPUT:
        // - String, Buffer or Stream:   piped as 'handler.js' into zip
        // - Webpack Config:             executed and output files are zipped
        //

        if ( typeOf.Object(result) ) {
            //
            // WEBPACK CONFIG
            //

            const logging = await this.buildWebpack(result, buildTmpDir)
            this.serverless.cli.log(logging)

            ;[ 'handler.js', `handler.js.map`].forEach((fileName) => {
                const filePath = path.resolve(buildTmpDir, fileName)

                zip.addFile(filePath, fileName, zipOptions)
            })

        } else
        if ( typeOf.String(result) || result instanceof Buffer ) {
            //
            // STRINGS, BUFFERS
            //

            if ( typeOf.String(result) ) result = new Buffer(result)

            zip.addBuffer(result, 'handler.js', zipOptions)

        } else
        if ( isStream(result) ) {
            //
            // STREAMS
            //

            zip.addReadStream(result, 'handler.js', zipOptions)

        } else {
            throw new Error("Unrecognized build output")
        }

        const output = new Promise((resolve, reject) =>
            zip.outputStream.pipe( fs.createWriteStream(zipPath) )
                .on("error", reject)
                .on("close", resolve)
        )

        zip.end()

        await output

        throw new Error("Debugging, dont continue!")

        return output
    }


    async tryBuildFiles() {
        for ( let fileName of this.config.tryFiles ) {
            const exists = await fs.statAsync(fileName).then((stat) => stat.isFile())

            if ( exists ) return fileName
        }

        return null
    }


    /**
     *  Uses and extends a webpack config and runs it.
     */
    async buildWebpack(config, buildTmpDir) {
        const {
            service: { functions = [] },
            config: { servicePath }
        } = this.serverless

        let entryPoints = []
        for ( let fnName in functions ) {
            const entry = functions[fnName].handler.split('.')[0]
            if ( entryPoints.indexOf(entry) < 0 ) entryPoints.push(entry)
        }

        entryPoints = entryPoints.map((filePath) => `./${filePath}.js`)

        config.context = servicePath
        config.entry = [ ...(config.entry || []), ...entryPoints ]
        config.output = {
            ...config.output,
            libraryTarget : 'commonjs',
            path          : buildTmpDir,
            filename      : 'handler.js'
        }

        return await new WebpackBuilder(config).build()
    }
}
