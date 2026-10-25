// SPDX-License-Identifier: MIT
// 2dog: this file is part of https://2dog.dev

// 2dog: escape URL delimiters such as # in .NET resource names before fetch interprets them.
const encodeDotnetResourceUrl = (defaultUri, name) => {
	const uriName = encodeURI(name);
	const matchedName = defaultUri.includes(name) ? name : uriName;
	const nameIndex = defaultUri.lastIndexOf(matchedName);
	if (nameIndex < 0) {
		return defaultUri;
	}
	const encodedName = name.split('/').map(encodeURIComponent).join('/');
	return `${defaultUri.slice(0, nameIndex)}${encodedName}${defaultUri.slice(nameIndex + matchedName.length)}`;
};

// 2dog: wrap the .NET runtime module as Godot's Emscripten module.
const Godot = async (moduleConfig) => { // eslint-disable-line no-unused-vars
	// 2dog: let .NET configure wasm instantiation for JS imports, exports, and threads.
	delete moduleConfig['instantiateWasm'];

	// Depends on "dotnet.native.wasm" being in place of "godot.wasm".
	const loadPath = moduleConfig['locateFile']('dotnet.native.wasm');
	// Get preloaded wasm.
	let preloadedWasm = moduleConfig['getPreloadedWasm']();

	const perfMark = (name) => {
		if (typeof performance !== 'undefined') {
			performance.mark(name);
		}
	};

	// 2dog: inflate precompressed binary resources and report _framework download progress.
	// 2dog: leave script resources as URLs for the runtime's import().
	const gzSuffix = moduleConfig['godotPrecompressedSuffix'] || '';
	const onDotnetBytes = moduleConfig['godotOnDotnetProgress'];
	let dotnetLoaded = 0;
	const countedResponse = (response) => {
		if (!onDotnetBytes || !response.body) {
			return response;
		}
		return new Response(response.body.pipeThrough(new TransformStream({
			transform(chunk, controller) {
				dotnetLoaded += chunk.byteLength;
				onDotnetBytes(dotnetLoaded);
				controller.enqueue(chunk);
			},
		})), { 'headers': response.headers });
	};
	const loadBinaryResource = (url) => {
		const plain = () => fetch(url).then(countedResponse);
		if (!gzSuffix || typeof DecompressionStream === 'undefined') {
			return plain();
		}
		return fetch(url + gzSuffix).then((response) => {
			if (!response.ok || !response.body) {
				return plain();
			}
			return countedResponse(new Response(response.body.pipeThrough(new DecompressionStream('gzip'))));
		}, plain);
	};

	// dynamic module import.
	perfMark('2dog:dotnet-import');
	const dotnetjs = await import('./_framework/dotnet.js');
	const dotnet = dotnetjs.dotnet;

	dotnet
		// Pass emscripten config.
		.withModuleConfig(moduleConfig)
		.withConfig({
			// 2dog: let .NET configure the initial thread-pool size.
			pthreadPoolInitialSize: moduleConfig['emscriptenPoolSize'] || 8,
			// 2dog: enable synchronous JS import and export calls with threads.
			jsThreadBlockingMode: 'ThrowWhenBlockingWait',
		})
		.withResourceLoader((_type, name, _defaultUri, _integrity, _behavior) => {
			if (name === 'dotnet.native.wasm') {
				if (preloadedWasm) {
					// 2dog: pass the preloaded wasm response to the Godot loader.
					const promise = Promise.resolve(preloadedWasm);
					preloadedWasm = null;
					return promise;
				}
				// 2dog: fall back to the resolved wasm path.
				return loadPath;
			}
			const resourceUrl = encodeDotnetResourceUrl(_defaultUri, name);
			if ((gzSuffix || onDotnetBytes) && /\.(wasm|dat|pdb)$/.test(name)) {
				return loadBinaryResource(resourceUrl);
			}
			// 2dog: preserve default resource URLs unless their names need escaping.
			return resourceUrl === _defaultUri ? null : resourceUrl;
		});

	await dotnet.download();
	perfMark('2dog:dotnet-downloaded');
	const { setModuleImports, getAssemblyExports, getConfig, runMain, Module } = await dotnet.create();
	perfMark('2dog:dotnet-created');

	const dotnetConfig = getConfig();

	if (moduleConfig['godotSharpImports']) {
		const moduleImports = moduleConfig['godotSharpImports'];
		for (const moduleName of Object.keys(moduleImports)) {
			setModuleImports(moduleName, moduleImports[moduleName]);
		}
	}
	Module['getGodotSharpExports'] = getAssemblyExports.bind(null, dotnetConfig.mainAssemblyName);

	// 2dog: provide callMain for Godot when Emscripten omits it.
	Module.callMain = (args) => runMain(dotnetConfig.mainAssemblyName, args);
	return Module;
};

const Features = {
	/**
	 * Check whether WebGL is available. Optionally, specify a particular version of WebGL to check for.
	 *
	 * @param {number=} [majorVersion=1] The major WebGL version to check for.
	 * @returns {boolean} If the given major version of WebGL is available.
	 * @function Engine.isWebGLAvailable
	 */
	isWebGLAvailable: function (majorVersion = 1) {
		try {
			return !!document.createElement('canvas').getContext(['webgl', 'webgl2'][majorVersion - 1]);
		} catch (e) { /* Not available */ }
		return false;
	},

	/**
	 * Check whether the Fetch API available and supports streaming responses.
	 *
	 * @returns {boolean} If the Fetch API is available and supports streaming responses.
	 * @function Engine.isFetchAvailable
	 */
	isFetchAvailable: function () {
		return 'fetch' in window && 'Response' in window && 'body' in window.Response.prototype;
	},

	/**
	 * Check whether the engine is running in a Secure Context.
	 *
	 * @returns {boolean} If the engine is running in a Secure Context.
	 * @function Engine.isSecureContext
	 */
	isSecureContext: function () {
		return window['isSecureContext'] === true;
	},

	/**
	 * Check whether the engine is cross origin isolated.
	 * This value is dependent on Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers sent by the server.
	 *
	 * @returns {boolean} If the engine is running in a Secure Context.
	 * @function Engine.isSecureContext
	 */
	isCrossOriginIsolated: function () {
		return window['crossOriginIsolated'] === true;
	},

	/**
	 * Check whether SharedBufferArray is available.
	 *
	 * Most browsers require the page to be running in a secure context, and the
	 * the server to provide specific CORS headers for SharedArrayBuffer to be available.
	 *
	 * @returns {boolean} If SharedArrayBuffer is available.
	 * @function Engine.isSharedArrayBufferAvailable
	 */
	isSharedArrayBufferAvailable: function () {
		return 'SharedArrayBuffer' in window;
	},

	/**
	 * Check whether the AudioContext supports AudioWorkletNodes.
	 *
	 * @returns {boolean} If AudioWorkletNode is available.
	 * @function Engine.isAudioWorkletAvailable
	 */
	isAudioWorkletAvailable: function () {
		return 'AudioContext' in window && 'audioWorklet' in AudioContext.prototype;
	},

	/**
	 * Return an array of missing required features (as string).
	 *
	 * @returns {Array<string>} A list of human-readable missing features.
	 * @function Engine.getMissingFeatures
	 * @param {{threads: (boolean|undefined)}} supportedFeatures
	 */
	getMissingFeatures: function (supportedFeatures = {}) {
		const {
			// Quotes are needed for the Closure compiler.
			'threads': supportsThreads = true,
		} = supportedFeatures;

		const missing = [];
		if (!Features.isWebGLAvailable(2)) {
			missing.push('WebGL2 - Check web browser configuration and hardware support');
		}
		if (!Features.isFetchAvailable()) {
			missing.push('Fetch - Check web browser version');
		}
		if (!Features.isSecureContext()) {
			missing.push('Secure Context - Check web server configuration (use HTTPS)');
		}

		if (supportsThreads) {
			if (!Features.isCrossOriginIsolated()) {
				missing.push('Cross-Origin Isolation - Check that the web server configuration sends the correct headers.');
			}
			if (!Features.isSharedArrayBufferAvailable()) {
				missing.push('SharedArrayBuffer - Check that the web server configuration sends the correct headers.');
			}
		}

		// Audio is normally optional since we have a dummy fallback.
		return missing;
	},
};

const Preloader = /** @constructor */ function () { // eslint-disable-line no-unused-vars
	function getTrackedResponse(response, load_status) {
		function onloadprogress(reader, controller) {
			return reader.read().then(function (result) {
				if (load_status.done) {
					return Promise.resolve();
				}
				if (result.value) {
					controller.enqueue(result.value);
					load_status.loaded += result.value.length;
				}
				if (!result.done) {
					return onloadprogress(reader, controller);
				}
				load_status.done = true;
				return Promise.resolve();
			});
		}
		const reader = response.body.getReader();
		return new Response(new ReadableStream({
			start: function (controller) {
				onloadprogress(reader, controller).then(function () {
					controller.close();
				});
			},
		}), { headers: response.headers });
	}

	function loadFetch(file, tracker, fileSize, raw, compressedSuffix) {
		tracker[file] = {
			total: fileSize || 0,
			loaded: 0,
			done: false,
		};
		function consume(response) {
			const tr = getTrackedResponse(response, tracker[file]);
			if (raw) {
				return Promise.resolve(tr);
			}
			return tr.arrayBuffer();
		}
		function plain() {
			return fetch(file).then(function (response) {
				if (!response.ok) {
					return Promise.reject(new Error(`Failed loading file '${file}'`));
				}
				return consume(response);
			});
		}
		// 2dog: try precompressed siblings for hosts without HTTP compression; fall back to plain files.
		// 2dog: count inflated bytes to match fileSizes.
		if (compressedSuffix && typeof DecompressionStream !== 'undefined') {
			return fetch(file + compressedSuffix).then(function (response) {
				if (!response.ok || !response.body) {
					return plain();
				}
				return consume(new Response(response.body.pipeThrough(new DecompressionStream('gzip'))));
			}, plain);
		}
		return plain();
	}

	function retry(func, attempts = 1) {
		function onerror(err) {
			if (attempts <= 1) {
				return Promise.reject(err);
			}
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					retry(func, attempts - 1).then(resolve).catch(reject);
				}, 1000);
			});
		}
		return func().catch(onerror);
	}

	const DOWNLOAD_ATTEMPTS_MAX = 4;
	const loadingFiles = {};
	const lastProgress = { loaded: 0, total: 0 };
	let progressFunc = null;

	const animateProgress = function () {
		let loaded = 0;
		let total = 0;
		let totalIsValid = true;
		let progressIsFinal = true;

		Object.keys(loadingFiles).forEach(function (file) {
			const stat = loadingFiles[file];
			if (!stat.done) {
				progressIsFinal = false;
			}
			if (!totalIsValid || stat.total === 0) {
				totalIsValid = false;
				total = 0;
			} else {
				total += stat.total;
			}
			loaded += stat.loaded;
		});
		if (loaded !== lastProgress.loaded || total !== lastProgress.total) {
			lastProgress.loaded = loaded;
			lastProgress.total = total;
			if (typeof progressFunc === 'function') {
				progressFunc(loaded, total);
			}
		}
		if (!progressIsFinal) {
			requestAnimationFrame(animateProgress);
		}
	};

	this.animateProgress = animateProgress;

	this.setProgressFunc = function (callback) {
		progressFunc = callback;
	};

	this.loadPromise = function (file, fileSize, raw = false, compressedSuffix = '') {
		return retry(loadFetch.bind(null, file, loadingFiles, fileSize, raw, compressedSuffix), DOWNLOAD_ATTEMPTS_MAX);
	};

	this.preloadedFiles = [];
	this.preload = function (pathOrBuffer, destPath, fileSize, compressedSuffix = '') {
		let buffer = null;
		if (typeof pathOrBuffer === 'string') {
			const me = this;
			return this.loadPromise(pathOrBuffer, fileSize, false, compressedSuffix).then(function (buf) {
				me.preloadedFiles.push({
					path: destPath || pathOrBuffer,
					buffer: buf,
				});
				return Promise.resolve();
			});
		} else if (pathOrBuffer instanceof ArrayBuffer) {
			buffer = new Uint8Array(pathOrBuffer);
		} else if (ArrayBuffer.isView(pathOrBuffer)) {
			buffer = new Uint8Array(pathOrBuffer.buffer);
		}
		if (buffer) {
			this.preloadedFiles.push({
				path: destPath,
				buffer: pathOrBuffer,
			});
			return Promise.resolve();
		}
		return Promise.reject(new Error('Invalid object for preloading'));
	};
};

/**
 * An object used to configure the Engine instance based on godot export options, and to override those in custom HTML
 * templates if needed.
 *
 * @header Engine configuration
 * @summary The Engine configuration object. This is just a typedef, create it like a regular object, e.g.:
 *
 * ``const MyConfig = { executable: 'godot', unloadAfterInit: false }``
 *
 * @typedef {Object} EngineConfig
 */
const EngineConfig = {}; // eslint-disable-line no-unused-vars

/**
 * @struct
 * @constructor
 * @ignore
 */
const InternalConfig = function (initConfig) { // eslint-disable-line no-unused-vars
	const cfg = /** @lends {InternalConfig.prototype} */ {
		/**
		 * Whether to unload the engine automatically after the instance is initialized.
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {boolean}
		 */
		unloadAfterInit: true,
		/**
		 * The HTML DOM Canvas object to use.
		 *
		 * By default, the first canvas element in the document will be used is none is specified.
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {?HTMLCanvasElement}
		 */
		canvas: null,
		/**
		 * The name of the WASM file without the extension. (Set by Godot Editor export process).
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {string}
		 */
		executable: '',
		/**
		 * An alternative name for the game pck to load. The executable name is used otherwise.
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {?string}
		 */
		mainPack: null,
		/**
		 * Specify a language code to select the proper localization for the game.
		 *
		 * The browser locale will be used if none is specified. See complete list of
		 * :ref:`supported locales <doc_locales>`.
		 *
		 * @memberof EngineConfig
		 * @type {?string}
		 * @default
		 */
		locale: null,
		/**
		 * The canvas resize policy determines how the canvas should be resized by Godot.
		 *
		 * ``0`` means Godot won't do any resizing. This is useful if you want to control the canvas size from
		 * javascript code in your template.
		 *
		 * ``1`` means Godot will resize the canvas on start, and when changing window size via engine functions.
		 *
		 * ``2`` means Godot will adapt the canvas size to match the whole browser window.
		 *
		 * @memberof EngineConfig
		 * @type {number}
		 * @default
		 */
		canvasResizePolicy: 2,
		/**
		 * The arguments to be passed as command line arguments on startup.
		 *
		 * See :ref:`command line tutorial <doc_command_line_tutorial>`.
		 *
		 * **Note**: :js:meth:`startGame <Engine.prototype.startGame>` will always add the ``--main-pack`` argument.
		 *
		 * @memberof EngineConfig
		 * @type {Array<string>}
		 * @default
		 */
		args: [],
		/**
		 * When enabled, the game canvas will automatically grab the focus when the engine starts.
		 *
		 * @memberof EngineConfig
		 * @type {boolean}
		 * @default
		 */
		focusCanvas: true,
		/**
		 * When enabled, this will turn on experimental virtual keyboard support on mobile.
		 *
		 * @memberof EngineConfig
		 * @type {boolean}
		 * @default
		 */
		experimentalVK: false,
		/**
		 * The progressive web app service worker to install.
		 * @memberof EngineConfig
		 * @default
		 * @type {string}
		 */
		serviceWorker: '',
		/**
		 * @ignore
		 * @type {Array.<string>}
		 */
		persistentPaths: ['/userfs'],
		/**
		 * @ignore
		 * @type {boolean}
		 */
		persistentDrops: false,
		/**
		 * @ignore
		 * @type {Array.<string>}
		 */
		gdextensionLibs: [],
		/**
		 * The rendering driver to use. Set by Godot export based on project settings.
		 *
		 * ``'webgpu'`` will automatically request a WebGPU device before engine init.
		 * If the browser cannot provide a device, startup falls back to WebGL 2.0
		 * with the Compatibility renderer. Builds without WebGPU support still reject it.
		 *
		 * ``'opengl3'`` (or empty) uses WebGL 2.0.
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {string}
		 */
		renderingDriver: 'opengl3',
		/**
		 * A pre-initialized WebGPU device to pass to the Emscripten module.
		 * Required for WebGPU rendering. Must be set before engine init.
		 * If not provided and ``renderingDriver`` is ``'webgpu'``, one will be
		 * requested automatically.
		 *
		 * @memberof EngineConfig
		 * @default
		 * @type {?GPUDevice}
		 */
		preinitializedWebGPUDevice: null,
		/**
		 * @ignore
		 * @type {Array.<string>}
		 */
		fileSizes: [],
		/**
		 * @ignore
		 * @type {number}
		 */
		emscriptenPoolSize: 8,
		/**
		 * @ignore
		 * @type {number}
		 */
		godotPoolSize: 4,
		/**
		 * Pass imports to dotnet.setModuleImports(key, value).
		 *
		 * @memberof EngineConfig
		 * @type {?Object}
		 * @default
		 */
		dotnetModuleImports: null,
		// 2dog: try precompressed siblings such as .gz and inflate them in-page; fall back to plain files.
		/**
		 * @memberof EngineConfig
		 * @type {string}
		 * @default
		 */
		precompressedSuffix: '',
		// 2dog: report cumulative .NET _framework download bytes separately from onProgress.
		/**
		 * @memberof EngineConfig
		 * @type {?function(number)}
		 * @default
		 */
		onDotnetProgress: null,
		/**
		 * A callback function for handling Godot's ``OS.execute`` calls.
		 *
		 * This is for example used in the Web Editor template to switch between project manager and editor, and for running the game.
		 *
		 * @callback EngineConfig.onExecute
		 * @param {string} path The path that Godot's wants executed.
		 * @param {Array.<string>} args The arguments of the "command" to execute.
		 */
		/**
		 * @ignore
		 * @type {?function(string, Array.<string>)}
		 */
		onExecute: null,
		/**
		 * A callback function for being notified when the Godot instance quits.
		 *
		 * **Note**: This function will not be called if the engine crashes or become unresponsive.
		 *
		 * @callback EngineConfig.onExit
		 * @param {number} status_code The status code returned by Godot on exit.
		 */
		/**
		 * @ignore
		 * @type {?function(number)}
		 */
		onExit: null,
		/**
		 * A callback function for displaying download progress.
		 *
		 * The function is called once per frame while downloading files, so the usage of ``requestAnimationFrame()``
		 * is not necessary.
		 *
		 * If the callback function receives a total amount of bytes as 0, this means that it is impossible to calculate.
		 * Possible reasons include:
		 *
		 * -  Files are delivered with server-side chunked compression
		 * -  Files are delivered with server-side compression on Chromium
		 * -  Not all file downloads have started yet (usually on servers without multi-threading)
		 *
		 * @callback EngineConfig.onProgress
		 * @param {number} current The current amount of downloaded bytes so far.
		 * @param {number} total The total amount of bytes to be downloaded.
		 */
		/**
		 * @ignore
		 * @type {?function(number, number)}
		 */
		onProgress: null,
		/**
		 * A callback function for handling the standard output stream. This method should usually only be used in debug pages.
		 *
		 * By default, ``console.log()`` is used.
		 *
		 * @callback EngineConfig.onPrint
		 * @param {...*} [var_args] A variadic number of arguments to be printed.
		 */
		/**
		 * @ignore
		 * @type {?function(...*)}
		 */
		onPrint: function () {
			console.log.apply(console, Array.from(arguments)); // eslint-disable-line no-console
		},
		/**
		 * A callback function for handling the standard error stream. This method should usually only be used in debug pages.
		 *
		 * By default, ``console.error()`` is used.
		 *
		 * @callback EngineConfig.onPrintError
		 * @param {...*} [var_args] A variadic number of arguments to be printed as errors.
		*/
		/**
		 * @ignore
		 * @type {?function(...*)}
		 */
		onPrintError: function (var_args) {
			console.error.apply(console, Array.from(arguments)); // eslint-disable-line no-console
		},
	};

	/**
	 * @ignore
	 * @struct
	 * @constructor
	 * @param {EngineConfig} opts
	 */
	function Config(opts) {
		this.update(opts);
	}

	Config.prototype = cfg;

	/**
	 * @ignore
	 * @param {EngineConfig} opts
	 */
	Config.prototype.update = function (opts) {
		const config = opts || {};
		// NOTE: We must explicitly pass the default, accessing it via
		// the key will fail due to closure compiler renames.
		function parse(key, def) {
			if (typeof (config[key]) === 'undefined') {
				return def;
			}
			return config[key];
		}
		// Module config
		this.unloadAfterInit = parse('unloadAfterInit', this.unloadAfterInit);
		this.onPrintError = parse('onPrintError', this.onPrintError);
		this.onPrint = parse('onPrint', this.onPrint);
		this.onProgress = parse('onProgress', this.onProgress);
		this.dotnetModuleImports = parse('dotnetModuleImports', this.dotnetModuleImports);
		this.precompressedSuffix = parse('precompressedSuffix', this.precompressedSuffix);
		this.onDotnetProgress = parse('onDotnetProgress', this.onDotnetProgress);

		// Godot config
		this.canvas = parse('canvas', this.canvas);
		this.executable = parse('executable', this.executable);
		this.mainPack = parse('mainPack', this.mainPack);
		this.locale = parse('locale', this.locale);
		this.canvasResizePolicy = parse('canvasResizePolicy', this.canvasResizePolicy);
		this.persistentPaths = parse('persistentPaths', this.persistentPaths);
		this.persistentDrops = parse('persistentDrops', this.persistentDrops);
		this.experimentalVK = parse('experimentalVK', this.experimentalVK);
		this.focusCanvas = parse('focusCanvas', this.focusCanvas);
		this.serviceWorker = parse('serviceWorker', this.serviceWorker);
		this.gdextensionLibs = parse('gdextensionLibs', this.gdextensionLibs);
		this.renderingDriver = parse('renderingDriver', this.renderingDriver);
		this.preinitializedWebGPUDevice = parse('preinitializedWebGPUDevice', this.preinitializedWebGPUDevice);
		this.fileSizes = parse('fileSizes', this.fileSizes);
		this.emscriptenPoolSize = parse('emscriptenPoolSize', this.emscriptenPoolSize);
		this.godotPoolSize = parse('godotPoolSize', this.godotPoolSize);
		this.args = parse('args', this.args);
		this.onExecute = parse('onExecute', this.onExecute);
		this.onExit = parse('onExit', this.onExit);
	};

	/**
	 * @ignore
	 * @param {string} loadPath
	 * @param {Response} response
	 */
	Config.prototype.getModuleConfig = function (loadPath, response) {
		const dirPath = loadPath.split('/').slice(0, -1).join('/');

		let r = response;
		const gdext = this.gdextensionLibs;
		return {
			'print': this.onPrint,
			'printErr': this.onPrintError,
			'thisProgram': this.executable,
			'noExitRuntime': false,
			'dynamicLibraries': [`${loadPath}.side.wasm`].concat(this.gdextensionLibs),
			'emscriptenPoolSize': this.emscriptenPoolSize,
			// WebGPU: pass pre-initialized device if provided (for emscripten_webgpu_get_device()).
			...(this.preinitializedWebGPUDevice ? { 'preinitializedWebGPUDevice': this.preinitializedWebGPUDevice } : {}),
			'instantiateWasm': function (imports, onSuccess) {
				function done(result) {
					onSuccess(result['instance'], result['module']);
				}
				if (typeof (WebAssembly.instantiateStreaming) !== 'undefined') {
					WebAssembly.instantiateStreaming(Promise.resolve(r), imports).then(done);
				} else {
					r.arrayBuffer().then(function (buffer) {
						WebAssembly.instantiate(buffer, imports).then(done);
					});
				}
				r = null;
				return {};
			},
			'locateFile': function (path) {
				if (path.startsWith('godot.')) {
					if (path.endsWith('.audio.worklet.js')) {
						return `${loadPath}.audio.worklet.js`;
					} else if (path.endsWith('.audio.position.worklet.js')) {
						return `${loadPath}.audio.position.worklet.js`;
					} else if (path.endsWith('.js')) {
						return `${loadPath}.js`;
					} else if (path in gdext) {
						return path;
					} else if (path.endsWith('.side.wasm')) {
						return `${loadPath}.side.wasm`;
					} else if (path.endsWith('.wasm')) {
						return `${loadPath}.wasm`;
					}
				}
				if (path.startsWith('dotnet.')) {
					if (path === 'dotnet.native.wasm') {
						return `${loadPath}.wasm`;
					}
					return `${dirPath}/_framework/${path}`;
				}
				return path;
			},
			'getPreloadedWasm': function () {
				const tempResponse = r;
				r = null;
				return tempResponse;
			},
			'godotSharpImports': this.dotnetModuleImports,
			'godotPrecompressedSuffix': this.precompressedSuffix,
			'godotOnDotnetProgress': this.onDotnetProgress,
		};
	};

	/**
	 * @ignore
	 * @param {function()} cleanup
	 */
	Config.prototype.getGodotConfig = function (cleanup) {
		// Try to find a canvas
		if (!(this.canvas instanceof HTMLCanvasElement)) {
			const nodes = document.getElementsByTagName('canvas');
			if (nodes.length && nodes[0] instanceof HTMLCanvasElement) {
				const first = nodes[0];
				this.canvas = /** @type {!HTMLCanvasElement} */ (first);
			}
			if (!this.canvas) {
				throw new Error('No canvas found in page');
			}
		}
		// Canvas can grab focus on click, or key events won't work.
		if (this.canvas.tabIndex < 0) {
			this.canvas.tabIndex = 0;
		}

		// Browser locale, or custom one if defined.
		let locale = this.locale;
		if (!locale) {
			locale = navigator.languages ? navigator.languages[0] : navigator.language;
			locale = locale.split('.')[0];
		}
		locale = locale.replace('-', '_');
		const onExit = this.onExit;

		// Godot configuration.
		return {
			'canvas': this.canvas,
			'canvasResizePolicy': this.canvasResizePolicy,
			'locale': locale,
			'persistentDrops': this.persistentDrops,
			'virtualKeyboard': this.experimentalVK,
			'godotPoolSize': this.godotPoolSize,
			'focusCanvas': this.focusCanvas,
			'onExecute': this.onExecute,
			'onExit': function (p_code) {
				cleanup(); // We always need to call the cleanup callback to free memory.
				if (typeof (onExit) === 'function') {
					onExit(p_code);
				}
			},
		};
	};
	return new Config(initConfig);
};

/**
 * Projects exported for the Web expose the :js:class:`Engine` class to the JavaScript environment, that allows
 * fine control over the engine's start-up process.
 *
 * This API is built in an asynchronous manner and requires basic understanding
 * of `Promises <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises>`__.
 *
 * @module Engine
 * @header Web export JavaScript reference
 */
const Engine = (function () {
	const webgpuUnavailableReason = "";
	const preloader = new Preloader();

	let loadPromise = null;
	let loadPath = '';
	let initPromise = null;

	/**
	 * @classdesc The ``Engine`` class provides methods for loading and starting exported projects on the Web. For default export
	 * settings, this is already part of the exported HTML page. To understand practical use of the ``Engine`` class,
	 * see :ref:`Custom HTML page for Web export <doc_customizing_html5_shell>`.
	 *
	 * @description Create a new Engine instance with the given configuration.
	 *
	 * @global
	 * @constructor
	 * @param {EngineConfig} initConfig The initial config for this instance.
	 */
	function Engine(initConfig) { // eslint-disable-line no-shadow
		this.config = new InternalConfig(initConfig);
		this.rtenv = null;
	}

	/**
	 * Load the engine from the specified base path.
	 *
	 * @param {string} basePath Base path of the engine to load.
	 * @param {number=} [size=0] The file size if known.
	 * @returns {Promise} A Promise that resolves once the engine is loaded.
	 *
	 * @function Engine.load
	 */
	Engine.load = function (basePath, size, compressedSuffix) {
		if (loadPromise == null) {
			loadPath = basePath;
			if (typeof performance !== 'undefined') {
				performance.mark('2dog:wasm-fetch');
			}
			loadPromise = preloader.loadPromise(`${loadPath}.wasm`, size, true, compressedSuffix || '');
			requestAnimationFrame(preloader.animateProgress);
		}
		return loadPromise;
	};

	/**
	 * Unload the engine to free memory.
	 *
	 * This method will be called automatically depending on the configuration. See :js:attr:`unloadAfterInit`.
	 *
	 * @function Engine.unload
	 */
	Engine.unload = function () {
		loadPromise = null;
	};

	/**
	 * Safe Engine constructor, creates a new prototype for every new instance to avoid prototype pollution.
	 * @ignore
	 * @constructor
	 */
	function SafeEngine(initConfig) {
		let webgpuFallback = false;
		const proto = /** @lends Engine.prototype */ {
			/**
			 * Initialize the engine instance. Optionally, pass the base path to the engine to load it,
			 * if it hasn't been loaded yet. See :js:meth:`Engine.load`.
			 *
			 * @param {string=} basePath Base path of the engine to load.
			 * @return {Promise} A ``Promise`` that resolves once the engine is loaded and initialized.
			 */
			init: function (basePath) {
				if (initPromise) {
					return initPromise;
				}
				const args = this.config.args;
				for (let i = 0; i + 1 < args.length; i++) {
					if (args[i] === '--' || args[i] === '++') {
						break;
					}
					if (args[i] === '--rendering-driver') {
						this.config.renderingDriver = args[++i];
					}
				}
				if (this.config.renderingDriver === 'webgpu' && webgpuUnavailableReason) {
					return Promise.reject(new Error(webgpuUnavailableReason));
				}
				if (loadPromise == null) {
					if (!basePath) {
						initPromise = Promise.reject(new Error('A base path must be provided when calling `init` and the engine is not loaded.'));
						return initPromise;
					}
					Engine.load(basePath, this.config.fileSizes[`${basePath}.wasm`], this.config.precompressedSuffix);
				}
				const me = this;
				function doInit(promise) {
					// Care! Promise chaining is bogus with old emscripten versions.
					// This caused a regression with the Mono build (which uses an older emscripten version).
					// Make sure to test that when refactoring.
					return new Promise(function (resolve, reject) {
						promise.then(function (response) {
							const cloned = new Response(response.clone().body, { 'headers': [['content-type', 'application/wasm']] });
							Godot(me.config.getModuleConfig(loadPath, cloned)).then(function (module) {
								if (typeof performance !== 'undefined') {
									performance.mark('2dog:runtime-created');
								}
								const paths = me.config.persistentPaths;
								module['initFS'](paths).then(function (err) {
									if (typeof performance !== 'undefined') {
										performance.mark('2dog:fs-ready');
									}
									me.rtenv = module;
									if (me.config.unloadAfterInit) {
										Engine.unload();
									}
									resolve();
								});
							});
						});
					});
				}
				preloader.setProgressFunc(this.config.onProgress);
				if (me.config.renderingDriver === 'webgpu' && !me.config.preinitializedWebGPUDevice) {
					initPromise = Engine.requestWebGPUDevice().then(function (device) {
						me.config.preinitializedWebGPUDevice = device;
						return doInit(loadPromise);
					}, function (err) {
						console.warn('WebGPU device unavailable; falling back to WebGL 2 Compatibility.', err); // eslint-disable-line no-console
						webgpuFallback = true;
						me.config.renderingDriver = 'opengl3';
						return doInit(loadPromise);
					});
				} else {
					initPromise = doInit(loadPromise);
				}
				return initPromise;
			},

			/**
			 * Load a file so it is available in the instance's file system once it runs. Must be called **before** starting the
			 * instance.
			 *
			 * If not provided, the ``path`` is derived from the URL of the loaded file.
			 *
			 * @param {string|ArrayBuffer} file The file to preload.
			 *
			 * If a ``string`` the file will be loaded from that path.
			 *
			 * If an ``ArrayBuffer`` or a view on one, the buffer will used as the content of the file.
			 *
			 * @param {string=} path Path by which the file will be accessible. Required, if ``file`` is not a string.
			 *
			 * @returns {Promise} A Promise that resolves once the file is loaded.
			 */
			preloadFile: function (file, path) {
				return preloader.preload(file, path, this.config.fileSizes[file], this.config.precompressedSuffix);
			},

			/**
			 * Start the engine instance using the given override configuration (if any).
			 * :js:meth:`startGame <Engine.prototype.startGame>` can be used in typical cases instead.
			 *
			 * This will initialize the instance if it is not initialized. For manual initialization, see :js:meth:`init <Engine.prototype.init>`.
			 * The engine must be loaded beforehand.
			 *
			 * Fails if a canvas cannot be found on the page, or not specified in the configuration.
			 *
			 * @param {EngineConfig} override An optional configuration override.
			 * @return {Promise} Promise that resolves once the engine started.
			 */
			start: function (override) {
				this.config.update(override);
				const me = this;
				return me.init().then(function () {
					if (!me.rtenv) {
						return Promise.reject(new Error('The engine must be initialized before it can be started'));
					}
					if (webgpuFallback) {
						// Apply after start overrides too (e.g. the separate init/preload/start path).
						const args = me.config.args;
						const fallbackArgs = [];
						for (let i = 0; i < args.length; i++) {
							if (args[i] === '--' || args[i] === '++') {
								fallbackArgs.push.apply(fallbackArgs, args.slice(i));
								break;
							}
							if (args[i] === '--rendering-driver' || args[i] === '--rendering-method') {
								i++;
							} else {
								fallbackArgs.push(args[i]);
							}
						}
						me.config.args = ['--rendering-driver', 'opengl3', '--rendering-method', 'gl_compatibility'].concat(fallbackArgs);
					}

					let config = {};
					try {
						config = me.config.getGodotConfig(function () {
							me.rtenv = null;
						});
					} catch (e) {
						return Promise.reject(e);
					}
					// Godot configuration.
					me.rtenv['initConfig'](config);

					// Preload GDExtension libraries.
					if (me.config.gdextensionLibs.length > 0 && !me.rtenv['loadDynamicLibrary']) {
						return Promise.reject(new Error('GDExtension libraries are not supported by this engine version. '
							+ 'Enable "Extensions Support" for your export preset and/or build your custom template with "dlink_enabled=yes".'));
					}
					return new Promise(function (resolve, reject) {
						for (const file of preloader.preloadedFiles) {
							me.rtenv['copyToFS'](file.path, file.buffer);
						}
						preloader.preloadedFiles.length = 0; // Clear memory

						// 2dog: support custom asynchronous callMain implementations.
						if (typeof performance !== 'undefined') {
							performance.mark('2dog:call-main');
						}
						Promise.resolve().then(function () {
							return me.rtenv['callMain'](me.config.args);
						}).then(function () {
							initPromise = null;
							me.installServiceWorker();
							resolve();
						}, function (err) {
							initPromise = null;
							reject(err);
						});
					});
				});
			},

			/**
			 * Start the game instance using the given configuration override (if any).
			 *
			 * This will initialize the instance if it is not initialized. For manual initialization, see :js:meth:`init <Engine.prototype.init>`.
			 *
			 * This will load the engine if it is not loaded, and preload the main pck.
			 *
			 * This method expects the initial config (or the override) to have both the :js:attr:`executable` and :js:attr:`mainPack`
			 * properties set (normally done by the editor during export).
			 *
			 * @param {EngineConfig} override An optional configuration override.
			 * @return {Promise} Promise that resolves once the game started.
			 */
			startGame: function (override) {
				this.config.update(override);
				// Add main-pack argument.
				const exe = this.config.executable;
				const pack = this.config.mainPack || `${exe}.pck`;
				this.config.args = ['--main-pack', pack].concat(this.config.args);
				// Start and init with execName as loadPath if not inited.
				const me = this;

				return Promise.all([
					me.init(exe),
					me.preloadFile(pack, pack),
				]).then(function () {
					return me.start.apply(me);
				});
			},

			/**
			 * Create a file at the specified ``path`` with the passed as ``buffer`` in the instance's file system.
			 *
			 * @param {string} path The location where the file will be created.
			 * @param {ArrayBuffer} buffer The content of the file.
			 */
			copyToFS: function (path, buffer) {
				if (this.rtenv == null) {
					throw new Error('Engine must be inited before copying files');
				}
				this.rtenv['copyToFS'](path, buffer);
			},

			/**
			 * Request that the current instance quit.
			 *
			 * This is akin the user pressing the close button in the window manager, and will
			 * have no effect if the engine has crashed, or is stuck in a loop.
			 *
			 */
			requestQuit: function () {
				if (this.rtenv) {
					this.rtenv['request_quit']();
				}
			},

			/**
			 * Install the progressive-web app service worker.
			 * @returns {Promise} The service worker registration promise.
			 */
			installServiceWorker: function () {
				if (this.config.serviceWorker && 'serviceWorker' in navigator) {
					try {
						return navigator.serviceWorker.register(this.config.serviceWorker);
					} catch (e) {
						return Promise.reject(e);
					}
				}
				return Promise.resolve();
			},

			/**
			 * Get [JsExport] methods.
			 *
			 * @returns {Promise} The exports promise.
			 */
			getDotnetExports: function () {
				if (this.rtenv && this.rtenv['getGodotSharpExports']) {
					return this.rtenv['getGodotSharpExports']();
				}
				return Promise.resolve();
			},
		};

		Engine.prototype = proto;
		// Closure compiler exported instance methods.
		Engine.prototype['init'] = Engine.prototype.init;
		Engine.prototype['preloadFile'] = Engine.prototype.preloadFile;
		Engine.prototype['start'] = Engine.prototype.start;
		Engine.prototype['startGame'] = Engine.prototype.startGame;
		Engine.prototype['copyToFS'] = Engine.prototype.copyToFS;
		Engine.prototype['requestQuit'] = Engine.prototype.requestQuit;
		Engine.prototype['installServiceWorker'] = Engine.prototype.installServiceWorker;
		Engine.prototype['getDotnetExports'] = Engine.prototype.getDotnetExports;
		// Also expose static methods as instance methods
		Engine.prototype['load'] = Engine.load;
		Engine.prototype['unload'] = Engine.unload;
		return new Engine(initConfig);
	}

	/**
	 * Request a WebGPU device from the browser. Returns a Promise that resolves
	 * to a ``GPUDevice``, or rejects if WebGPU is not available.
	 *
	 * This is called automatically by :js:meth:`startGame <Engine.prototype.startGame>`
	 * when ``renderingDriver`` is ``'webgpu'``.
	 *
	 * @param {Object=} adapterOptions Optional ``GPURequestAdapterOptions``.
	 * @param {Object=} deviceDescriptor Optional ``GPUDeviceDescriptor``.
	 * @returns {Promise<GPUDevice>} A promise resolving to the GPU device.
	 *
	 * @function Engine.requestWebGPUDevice
	 */
	Engine.requestWebGPUDevice = function (adapterOptions, deviceDescriptor) {
		if (webgpuUnavailableReason) {
			return Promise.reject(new Error(webgpuUnavailableReason));
		}
		if (typeof navigator === 'undefined' || !navigator.gpu) {
			return Promise.reject(new Error(
				'WebGPU is not supported in this browser.\n'
				+ 'Try using a recent version of Chrome, Edge, or Firefox.'
			));
		}
		return navigator.gpu.requestAdapter(adapterOptions || {
			powerPreference: 'high-performance',
		}).then(function (adapter) {
			if (!adapter) {
				return Promise.reject(new Error(
					'WebGPU adapter not found. Your GPU may not support WebGPU.'
				));
			}
			const desc = deviceDescriptor || {
				requiredFeatures: [],
			};
			// Keep in sync with the native list in rendering_context_driver_webgpu_native.cpp.
			// Without the compression features, compressed textures are decompressed to RGBA8 on the CPU.
			const optionalFeatures = [
				'depth32float-stencil8',
				'float32-filterable',
				'float32-blendable',
				'texture-formats-tier1',
				'texture-formats-tier2',
				'rg11b10ufloat-renderable',
				'clip-distances',
				'dual-source-blending',
				'indirect-first-instance',
				'texture-compression-bc',
				'texture-compression-etc2',
				'texture-compression-astc',
			];
			desc.requiredFeatures = (desc.requiredFeatures || []).concat(optionalFeatures.filter((feature) => adapter.features.has(feature)));
			// Like the native backend, request every limit the adapter supports.
			desc.requiredLimits ||= {};
			for (const key in adapter.limits) {
				if (adapter.limits[key] !== undefined) {
					desc.requiredLimits[key] = adapter.limits[key];
				}
			}
			return adapter.requestDevice(desc).then(function (device) {
				device['godotAdapterInfo'] = adapter.info || {};
				// Monitor device loss (non-blocking — just log).
				device.lost.then(function (info) {
					const reason = info.reason || 'unknown';
					const msg = info.message || '';
					console.error(`[Godot] WebGPU device lost (reason: ${reason}): ${msg}`); // eslint-disable-line no-console
				});
				device.addEventListener('uncapturederror', function (event) {
					// Include the full error message — `event.error` alone only
					// serializes to the constructor name ("GPUValidationError"),
					// hiding the detail. `.message` contains the Dawn error text.
					const err = event.error;
					const kind = (err && err.constructor && err.constructor.name) || 'UnknownError';
					const msg = (err && err.message) ? err.message : String(err);
					console.error(`[Godot] WebGPU uncaptured error: ${kind}: ${msg}`); // eslint-disable-line no-console
				});
				return device;
			});
		});
	};

	// Closure compiler exported static methods.
	SafeEngine['load'] = Engine.load;
	SafeEngine['unload'] = Engine.unload;
	SafeEngine['requestWebGPUDevice'] = Engine.requestWebGPUDevice;

	// Feature-detection utilities.
	SafeEngine['isWebGLAvailable'] = Features.isWebGLAvailable;
	SafeEngine['isFetchAvailable'] = Features.isFetchAvailable;
	SafeEngine['isSecureContext'] = Features.isSecureContext;
	SafeEngine['isCrossOriginIsolated'] = Features.isCrossOriginIsolated;
	SafeEngine['isSharedArrayBufferAvailable'] = Features.isSharedArrayBufferAvailable;
	SafeEngine['isAudioWorkletAvailable'] = Features.isAudioWorkletAvailable;
	SafeEngine['getMissingFeatures'] = Features.getMissingFeatures;

	return SafeEngine;
}());
if (typeof window !== 'undefined') {
	window['Engine'] = Engine;
}
