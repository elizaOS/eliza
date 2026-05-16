import { createRequire } from "node:module";

//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* @__PURE__ */ createRequire(import.meta.url);

//#endregion
//#region node_modules/.bun/react@19.2.6/node_modules/react/cjs/react-jsx-runtime.production.js
/**
* @license React
* react-jsx-runtime.production.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_react_jsx_runtime_production = /* @__PURE__ */ __commonJSMin(((exports) => {
	var REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element"), REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
	function jsxProd(type, config, maybeKey) {
		var key = null;
		void 0 !== maybeKey && (key = "" + maybeKey);
		void 0 !== config.key && (key = "" + config.key);
		if ("key" in config) {
			maybeKey = {};
			for (var propName in config) "key" !== propName && (maybeKey[propName] = config[propName]);
		} else maybeKey = config;
		config = maybeKey.ref;
		return {
			$$typeof: REACT_ELEMENT_TYPE,
			type,
			key,
			ref: void 0 !== config ? config : null,
			props: maybeKey
		};
	}
	exports.Fragment = REACT_FRAGMENT_TYPE;
	exports.jsx = jsxProd;
	exports.jsxs = jsxProd;
}));

//#endregion
//#region node_modules/.bun/react@19.2.6/node_modules/react/jsx-runtime.js
var require_jsx_runtime = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_react_jsx_runtime_production();
}));

//#endregion
//#region node_modules/.bun/@capacitor+core@8.3.1/node_modules/@capacitor/core/dist/index.cjs.js
/*! Capacitor: https://capacitorjs.com/ - MIT License */
var require_index_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExceptionCode = void 0;
	(function(ExceptionCode) {
		/**
		* API is not implemented.
		*
		* This usually means the API can't be used because it is not implemented for
		* the current platform.
		*/
		ExceptionCode["Unimplemented"] = "UNIMPLEMENTED";
		/**
		* API is not available.
		*
		* This means the API can't be used right now because:
		*   - it is currently missing a prerequisite, such as network connectivity
		*   - it requires a particular platform or browser version
		*/
		ExceptionCode["Unavailable"] = "UNAVAILABLE";
	})(exports.ExceptionCode || (exports.ExceptionCode = {}));
	var CapacitorException = class extends Error {
		constructor(message, code, data) {
			super(message);
			this.message = message;
			this.code = code;
			this.data = data;
		}
	};
	const getPlatformId = (win) => {
		var _a, _b;
		if (win === null || win === void 0 ? void 0 : win.androidBridge) return "android";
		else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) return "ios";
		else return "web";
	};
	const createCapacitor = (win) => {
		const capCustomPlatform = win.CapacitorCustomPlatform || null;
		const cap = win.Capacitor || {};
		const Plugins = cap.Plugins = cap.Plugins || {};
		const getPlatform = () => {
			return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
		};
		const isNativePlatform = () => getPlatform() !== "web";
		const isPluginAvailable = (pluginName) => {
			const plugin = registeredPlugins.get(pluginName);
			if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) return true;
			if (getPluginHeader(pluginName)) return true;
			return false;
		};
		const getPluginHeader = (pluginName) => {
			var _a;
			return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
		};
		const handleError = (err) => win.console.error(err);
		const registeredPlugins = /* @__PURE__ */ new Map();
		const registerPlugin = (pluginName, jsImplementations = {}) => {
			const registeredPlugin = registeredPlugins.get(pluginName);
			if (registeredPlugin) {
				console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
				return registeredPlugin.proxy;
			}
			const platform = getPlatform();
			const pluginHeader = getPluginHeader(pluginName);
			let jsImplementation;
			const loadPluginImplementation = async () => {
				if (!jsImplementation && platform in jsImplementations) jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
				else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
				return jsImplementation;
			};
			const createPluginMethod = (impl, prop) => {
				var _a, _b;
				if (pluginHeader) {
					const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
					if (methodHeader) if (methodHeader.rtype === "promise") return (options) => cap.nativePromise(pluginName, prop.toString(), options);
					else return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
					else if (impl) return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
				} else if (impl) return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
				else throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
			};
			const createPluginMethodWrapper = (prop) => {
				let remove;
				const wrapper = (...args) => {
					const p = loadPluginImplementation().then((impl) => {
						const fn = createPluginMethod(impl, prop);
						if (fn) {
							const p = fn(...args);
							remove = p === null || p === void 0 ? void 0 : p.remove;
							return p;
						} else throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, exports.ExceptionCode.Unimplemented);
					});
					if (prop === "addListener") p.remove = async () => remove();
					return p;
				};
				wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
				Object.defineProperty(wrapper, "name", {
					value: prop,
					writable: false,
					configurable: false
				});
				return wrapper;
			};
			const addListener = createPluginMethodWrapper("addListener");
			const removeListener = createPluginMethodWrapper("removeListener");
			const addListenerNative = (eventName, callback) => {
				const call = addListener({ eventName }, callback);
				const remove = async () => {
					removeListener({
						eventName,
						callbackId: await call
					}, callback);
				};
				const p = new Promise((resolve) => call.then(() => resolve({ remove })));
				p.remove = async () => {
					console.warn(`Using addListener() without 'await' is deprecated.`);
					await remove();
				};
				return p;
			};
			const proxy = new Proxy({}, { get(_, prop) {
				switch (prop) {
					case "$$typeof": return;
					case "toJSON": return () => ({});
					case "addListener": return pluginHeader ? addListenerNative : addListener;
					case "removeListener": return removeListener;
					default: return createPluginMethodWrapper(prop);
				}
			} });
			Plugins[pluginName] = proxy;
			registeredPlugins.set(pluginName, {
				name: pluginName,
				proxy,
				platforms: new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
			});
			return proxy;
		};
		if (!cap.convertFileSrc) cap.convertFileSrc = (filePath) => filePath;
		cap.getPlatform = getPlatform;
		cap.handleError = handleError;
		cap.isNativePlatform = isNativePlatform;
		cap.isPluginAvailable = isPluginAvailable;
		cap.registerPlugin = registerPlugin;
		cap.Exception = CapacitorException;
		cap.DEBUG = !!cap.DEBUG;
		cap.isLoggingEnabled = !!cap.isLoggingEnabled;
		return cap;
	};
	const initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
	const Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
	const registerPlugin = Capacitor.registerPlugin;
	/**
	* Base class web plugins should extend.
	*/
	var WebPlugin = class {
		constructor() {
			this.listeners = {};
			this.retainedEventArguments = {};
			this.windowListeners = {};
		}
		addListener(eventName, listenerFunc) {
			let firstListener = false;
			if (!this.listeners[eventName]) {
				this.listeners[eventName] = [];
				firstListener = true;
			}
			this.listeners[eventName].push(listenerFunc);
			const windowListener = this.windowListeners[eventName];
			if (windowListener && !windowListener.registered) this.addWindowListener(windowListener);
			if (firstListener) this.sendRetainedArgumentsForEvent(eventName);
			const remove = async () => this.removeListener(eventName, listenerFunc);
			return Promise.resolve({ remove });
		}
		async removeAllListeners() {
			this.listeners = {};
			for (const listener in this.windowListeners) this.removeWindowListener(this.windowListeners[listener]);
			this.windowListeners = {};
		}
		notifyListeners(eventName, data, retainUntilConsumed) {
			const listeners = this.listeners[eventName];
			if (!listeners) {
				if (retainUntilConsumed) {
					let args = this.retainedEventArguments[eventName];
					if (!args) args = [];
					args.push(data);
					this.retainedEventArguments[eventName] = args;
				}
				return;
			}
			listeners.forEach((listener) => listener(data));
		}
		hasListeners(eventName) {
			var _a;
			return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
		}
		registerWindowListener(windowEventName, pluginEventName) {
			this.windowListeners[pluginEventName] = {
				registered: false,
				windowEventName,
				pluginEventName,
				handler: (event) => {
					this.notifyListeners(pluginEventName, event);
				}
			};
		}
		unimplemented(msg = "not implemented") {
			return new Capacitor.Exception(msg, exports.ExceptionCode.Unimplemented);
		}
		unavailable(msg = "not available") {
			return new Capacitor.Exception(msg, exports.ExceptionCode.Unavailable);
		}
		async removeListener(eventName, listenerFunc) {
			const listeners = this.listeners[eventName];
			if (!listeners) return;
			const index = listeners.indexOf(listenerFunc);
			this.listeners[eventName].splice(index, 1);
			if (!this.listeners[eventName].length) this.removeWindowListener(this.windowListeners[eventName]);
		}
		addWindowListener(handle) {
			window.addEventListener(handle.windowEventName, handle.handler);
			handle.registered = true;
		}
		removeWindowListener(handle) {
			if (!handle) return;
			window.removeEventListener(handle.windowEventName, handle.handler);
			handle.registered = false;
		}
		sendRetainedArgumentsForEvent(eventName) {
			const args = this.retainedEventArguments[eventName];
			if (!args) return;
			delete this.retainedEventArguments[eventName];
			args.forEach((arg) => {
				this.notifyListeners(eventName, arg);
			});
		}
	};
	const WebView = /* @__PURE__ */ registerPlugin("WebView");
	/******** END WEB VIEW PLUGIN ********/
	/******** COOKIES PLUGIN ********/
	/**
	* Safely web encode a string value (inspired by js-cookie)
	* @param str The string value to encode
	*/
	const encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
	/**
	* Safely web decode a string value (inspired by js-cookie)
	* @param str The string value to decode
	*/
	const decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
	var CapacitorCookiesPluginWeb = class extends WebPlugin {
		async getCookies() {
			const cookies = document.cookie;
			const cookieMap = {};
			cookies.split(";").forEach((cookie) => {
				if (cookie.length <= 0) return;
				let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
				key = decode(key).trim();
				value = decode(value).trim();
				cookieMap[key] = value;
			});
			return cookieMap;
		}
		async setCookie(options) {
			try {
				const encodedKey = encode(options.key);
				const encodedValue = encode(options.value);
				const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
				const path = (options.path || "/").replace("path=", "");
				const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
				document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async deleteCookie(options) {
			try {
				document.cookie = `${options.key}=; Max-Age=0`;
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async clearCookies() {
			try {
				const cookies = document.cookie.split(";") || [];
				for (const cookie of cookies) document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
			} catch (error) {
				return Promise.reject(error);
			}
		}
		async clearAllCookies() {
			try {
				await this.clearCookies();
			} catch (error) {
				return Promise.reject(error);
			}
		}
	};
	const CapacitorCookies = registerPlugin("CapacitorCookies", { web: () => new CapacitorCookiesPluginWeb() });
	/**
	* Read in a Blob value and return it as a base64 string
	* @param blob The blob value to convert to a base64 string
	*/
	const readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const base64String = reader.result;
			resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
		};
		reader.onerror = (error) => reject(error);
		reader.readAsDataURL(blob);
	});
	/**
	* Normalize an HttpHeaders map by lowercasing all of the values
	* @param headers The HttpHeaders object to normalize
	*/
	const normalizeHttpHeaders = (headers = {}) => {
		const originalKeys = Object.keys(headers);
		return Object.keys(headers).map((k) => k.toLocaleLowerCase()).reduce((acc, key, index) => {
			acc[key] = headers[originalKeys[index]];
			return acc;
		}, {});
	};
	/**
	* Builds a string of url parameters that
	* @param params A map of url parameters
	* @param shouldEncode true if you should encodeURIComponent() the values (true by default)
	*/
	const buildUrlParams = (params, shouldEncode = true) => {
		if (!params) return null;
		return Object.entries(params).reduce((accumulator, entry) => {
			const [key, value] = entry;
			let encodedValue;
			let item;
			if (Array.isArray(value)) {
				item = "";
				value.forEach((str) => {
					encodedValue = shouldEncode ? encodeURIComponent(str) : str;
					item += `${key}=${encodedValue}&`;
				});
				item.slice(0, -1);
			} else {
				encodedValue = shouldEncode ? encodeURIComponent(value) : value;
				item = `${key}=${encodedValue}`;
			}
			return `${accumulator}&${item}`;
		}, "").substr(1);
	};
	/**
	* Build the RequestInit object based on the options passed into the initial request
	* @param options The Http plugin options
	* @param extra Any extra RequestInit values
	*/
	const buildRequestInit = (options, extra = {}) => {
		const output = Object.assign({
			method: options.method || "GET",
			headers: options.headers
		}, extra);
		const type = normalizeHttpHeaders(options.headers)["content-type"] || "";
		if (typeof options.data === "string") output.body = options.data;
		else if (type.includes("application/x-www-form-urlencoded")) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(options.data || {})) params.set(key, value);
			output.body = params.toString();
		} else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
			const form = new FormData();
			if (options.data instanceof FormData) options.data.forEach((value, key) => {
				form.append(key, value);
			});
			else for (const key of Object.keys(options.data)) form.append(key, options.data[key]);
			output.body = form;
			const headers = new Headers(output.headers);
			headers.delete("content-type");
			output.headers = headers;
		} else if (type.includes("application/json") || typeof options.data === "object") output.body = JSON.stringify(options.data);
		return output;
	};
	var CapacitorHttpPluginWeb = class extends WebPlugin {
		/**
		* Perform an Http request given a set of options
		* @param options Options to build the HTTP request
		*/
		async request(options) {
			const requestInit = buildRequestInit(options, options.webFetchExtra);
			const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
			const url = urlParams ? `${options.url}?${urlParams}` : options.url;
			const response = await fetch(url, requestInit);
			const contentType = response.headers.get("content-type") || "";
			let { responseType = "text" } = response.ok ? options : {};
			if (contentType.includes("application/json")) responseType = "json";
			let data;
			let blob;
			switch (responseType) {
				case "arraybuffer":
				case "blob":
					blob = await response.blob();
					data = await readBlobAsBase64(blob);
					break;
				case "json":
					data = await response.json();
					break;
				default: data = await response.text();
			}
			const headers = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			return {
				data,
				headers,
				status: response.status,
				url: response.url
			};
		}
		/**
		* Perform an Http GET request given a set of options
		* @param options Options to build the HTTP request
		*/
		async get(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
		}
		/**
		* Perform an Http POST request given a set of options
		* @param options Options to build the HTTP request
		*/
		async post(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
		}
		/**
		* Perform an Http PUT request given a set of options
		* @param options Options to build the HTTP request
		*/
		async put(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
		}
		/**
		* Perform an Http PATCH request given a set of options
		* @param options Options to build the HTTP request
		*/
		async patch(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
		}
		/**
		* Perform an Http DELETE request given a set of options
		* @param options Options to build the HTTP request
		*/
		async delete(options) {
			return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
		}
	};
	const CapacitorHttp = registerPlugin("CapacitorHttp", { web: () => new CapacitorHttpPluginWeb() });
	/******** END HTTP PLUGIN ********/
	/******** SYSTEM BARS PLUGIN ********/
	/**
	* Available status bar styles.
	*/
	exports.SystemBarsStyle = void 0;
	(function(SystemBarsStyle) {
		/**
		* Light system bar content on a dark background.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Dark"] = "DARK";
		/**
		* For dark system bar content on a light background.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Light"] = "LIGHT";
		/**
		* The style is based on the device appearance or the underlying content.
		* If the device is using Dark mode, the system bars content will be light.
		* If the device is using Light mode, the system bars content will be dark.
		*
		* @since 8.0.0
		*/
		SystemBarsStyle["Default"] = "DEFAULT";
	})(exports.SystemBarsStyle || (exports.SystemBarsStyle = {}));
	/**
	* Available system bar types.
	*/
	exports.SystemBarType = void 0;
	(function(SystemBarType) {
		/**
		* The top status bar on both Android and iOS.
		*
		* @since 8.0.0
		*/
		SystemBarType["StatusBar"] = "StatusBar";
		/**
		* The navigation bar (or gesture bar on iOS) on both Android and iOS.
		*
		* @since 8.0.0
		*/
		SystemBarType["NavigationBar"] = "NavigationBar";
	})(exports.SystemBarType || (exports.SystemBarType = {}));
	var SystemBarsPluginWeb = class extends WebPlugin {
		async setStyle() {
			this.unavailable("not available for web");
		}
		async setAnimation() {
			this.unavailable("not available for web");
		}
		async show() {
			this.unavailable("not available for web");
		}
		async hide() {
			this.unavailable("not available for web");
		}
	};
	const SystemBars = registerPlugin("SystemBars", { web: () => new SystemBarsPluginWeb() });
	/******** END SYSTEM BARS PLUGIN ********/
	exports.Capacitor = Capacitor;
	exports.CapacitorCookies = CapacitorCookies;
	exports.CapacitorException = CapacitorException;
	exports.CapacitorHttp = CapacitorHttp;
	exports.SystemBars = SystemBars;
	exports.WebPlugin = WebPlugin;
	exports.WebView = WebView;
	exports.buildRequestInit = buildRequestInit;
	exports.registerPlugin = registerPlugin;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/bridge/electrobun-rpc.js
function getDesktopBridgeWindow() {
	const g = globalThis;
	if (typeof g.window !== "undefined") return g.window;
	if (typeof window !== "undefined") return window;
	return null;
}
function getElectrobunRendererRpc() {
	return getDesktopBridgeWindow()?.__ELIZA_ELECTROBUN_RPC__;
}
async function invokeDesktopBridgeRequest(options) {
	const rpc = getElectrobunRendererRpc();
	const request = rpc?.request?.[options.rpcMethod];
	if (request && rpc?.request) return await request.call(rpc.request, options.params);
	return null;
}
/**
* Same as `invokeDesktopBridgeRequest`, but never hangs past `timeoutMs`.
* Use after native dialogs when a missing or wedged RPC would freeze the UI.
*/
async function invokeDesktopBridgeRequestWithTimeout(options) {
	const rpc = getElectrobunRendererRpc();
	const request = rpc?.request?.[options.rpcMethod];
	if (!request || !rpc?.request) return { status: "missing" };
	const call = request.call(rpc.request, options.params);
	let tid;
	const timeoutPromise = new Promise((resolve) => {
		tid = setTimeout(() => resolve({ tag: "timeout" }), options.timeoutMs);
	});
	const settledPromise = call.then((value) => ({
		tag: "done",
		value
	}), (error) => ({
		tag: "reject",
		error
	}));
	try {
		const winner = await Promise.race([settledPromise, timeoutPromise]);
		if (tid !== void 0) clearTimeout(tid);
		if (winner.tag === "timeout") return { status: "timeout" };
		if (winner.tag === "reject") return {
			status: "rejected",
			error: winner.error
		};
		return {
			status: "ok",
			value: winner.value
		};
	} catch (error) {
		if (tid !== void 0) clearTimeout(tid);
		return {
			status: "rejected",
			error
		};
	}
}
async function scanProviderCredentials() {
	return (await invokeDesktopBridgeRequest({
		rpcMethod: "credentialsScanProviders",
		ipcChannel: "credentials:scanProviders",
		params: { context: "onboarding" }
	}))?.providers ?? [];
}
async function inspectExistingElizaInstall() {
	return invokeDesktopBridgeRequest({
		rpcMethod: "agentInspectExistingInstall",
		ipcChannel: "agent:inspectExistingInstall"
	});
}
async function getDesktopRuntimeMode() {
	return invokeDesktopBridgeRequest({
		rpcMethod: "desktopGetRuntimeMode",
		ipcChannel: "desktop:getRuntimeMode"
	});
}
function subscribeDesktopBridgeEvent(options) {
	const rpc = getElectrobunRendererRpc();
	if (rpc) {
		rpc.onMessage(options.rpcMessage, options.listener);
		return () => {
			rpc.offMessage(options.rpcMessage, options.listener);
		};
	}
	return () => {};
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/bridge/native-plugins.js
var import_index_cjs = require_index_cjs();
function getCapacitorPlugins() {
	const capacitor = import_index_cjs.Capacitor;
	if (capacitor.Plugins) return capacitor.Plugins;
	if (typeof window !== "undefined") return window.Capacitor?.Plugins ?? {};
	return {};
}
function getNativePlugin(name) {
	return getCapacitorPlugins()[name] ?? {};
}
function getGatewayPlugin() {
	return getNativePlugin("Gateway");
}
function getSwabblePlugin() {
	return getNativePlugin("Swabble");
}
function getTalkModePlugin() {
	return getNativePlugin("TalkMode");
}
function getMobileSignalsPlugin() {
	return getNativePlugin("MobileSignals");
}
function getAppBlockerPlugin() {
	const plugins = getCapacitorPlugins();
	return plugins.ElizaAppBlocker ?? plugins.AppBlocker ?? {};
}
function getCameraPlugin() {
	const plugins = getCapacitorPlugins();
	return plugins.AppCamera ?? plugins.Camera ?? {};
}
function getLocationPlugin() {
	return getNativePlugin("Location");
}
function getScreenCapturePlugin() {
	return getNativePlugin("ScreenCapture");
}
function getCanvasPlugin() {
	return getNativePlugin("Canvas");
}
function getDesktopPlugin() {
	return getNativePlugin("Desktop");
}
function getWebsiteBlockerPlugin() {
	const plugins = getCapacitorPlugins();
	return plugins.ElizaWebsiteBlocker ?? plugins.WebsiteBlocker ?? {};
}
function getPhonePlugin() {
	return getNativePlugin("ElizaPhone");
}
function getContactsPlugin() {
	return getNativePlugin("ElizaContacts");
}
function getMessagesPlugin() {
	return getNativePlugin("ElizaMessages");
}
function getSystemPlugin() {
	return getNativePlugin("ElizaSystem");
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/bridge/electrobun-runtime.js
function getRuntimeWindow() {
	const g = globalThis;
	if (typeof g.window !== "undefined") return g.window;
	if (typeof window !== "undefined") return window;
	return null;
}
function hasElectrobunRendererBridge() {
	const rpc = getElectrobunRendererRpc();
	return Boolean(rpc && typeof rpc.onMessage === "function" && rpc.request && typeof rpc.request === "object");
}
function isElectrobunRuntime() {
	const runtimeWindow = getRuntimeWindow();
	if (!runtimeWindow) return false;
	if (typeof runtimeWindow.__electrobunWindowId === "number" || typeof runtimeWindow.__electrobunWebviewId === "number") return true;
	return hasElectrobunRendererBridge();
}
function getBackendStartupTimeoutMs() {
	if (isElectrobunRuntime()) return 18e4;
	if (typeof navigator !== "undefined" && /\bElizaOS\//.test(navigator.userAgent ?? "")) return 18e4;
	return 3e4;
}

//#endregion
export { __require as A, invokeDesktopBridgeRequestWithTimeout as C, require_jsx_runtime as D, require_index_cjs as E, __commonJSMin as O, invokeDesktopBridgeRequest as S, subscribeDesktopBridgeEvent as T, getTalkModePlugin as _, getCanvasPlugin as a, getElectrobunRendererRpc as b, getGatewayPlugin as c, getMobileSignalsPlugin as d, getNativePlugin as f, getSystemPlugin as g, getSwabblePlugin as h, getCameraPlugin as i, __toESM as j, __exportAll as k, getLocationPlugin as l, getScreenCapturePlugin as m, isElectrobunRuntime as n, getContactsPlugin as o, getPhonePlugin as p, getAppBlockerPlugin as r, getDesktopPlugin as s, getBackendStartupTimeoutMs as t, getMessagesPlugin as u, getWebsiteBlockerPlugin as v, scanProviderCredentials as w, inspectExistingElizaInstall as x, getDesktopRuntimeMode as y };