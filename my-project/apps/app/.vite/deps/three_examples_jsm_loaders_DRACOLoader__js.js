import { Br as LinearSRGBColorSpace, J as BufferGeometry, To as SRGBColorSpace, Ur as Loader, ir as InterleavedBufferAttribute, lt as ColorManagement, q as BufferAttribute, rr as InterleavedBuffer, st as Color, vn as FileLoader } from "./three.module-DGMucbGR.js";
//#region ../../node_modules/three/examples/jsm/loaders/DRACOLoader.js
var _taskCache = /* @__PURE__ */ new WeakMap();
/**
* A loader for the Draco format.
*
* [Draco](https://google.github.io/draco/) is an open source library for compressing
* and decompressing 3D meshes and point clouds. Compressed geometry can be significantly smaller,
* at the cost of additional decoding time on the client device.
*
* Standalone Draco files have a `.drc` extension, and contain vertex positions, normals, colors,
* and other attributes. Draco files do not contain materials, textures, animation, or node hierarchies –
* to use these features, embed Draco geometry inside of a glTF file. A normal glTF file can be converted
* to a Draco-compressed glTF file using [glTF-Pipeline](https://github.com/CesiumGS/gltf-pipeline).
* When using Draco with glTF, an instance of `DRACOLoader` will be used internally by {@link GLTFLoader}.
*
* It is recommended to create one DRACOLoader instance and reuse it to avoid loading and creating
* multiple decoder instances.
*
* `DRACOLoader` will automatically use either the JS or the WASM decoding library, based on
* browser capabilities.
*
* ```js
* const loader = new DRACOLoader();
* loader.setDecoderPath( '/examples/jsm/libs/draco/' );
*
* const geometry = await dracoLoader.loadAsync( 'models/draco/bunny.drc' );
* geometry.computeVertexNormals(); // optional
*
* dracoLoader.dispose();
* ```
*
* @augments Loader
* @three_import import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
*/
var DRACOLoader = class extends Loader {
	/**
	* Constructs a new Draco loader.
	*
	* @param {LoadingManager} [manager] - The loading manager.
	*/
	constructor(manager) {
		super(manager);
		this.decoderPath = "";
		this.decoderConfig = {};
		this.decoderBinary = null;
		this.decoderPending = null;
		this.workerLimit = 4;
		this.workerPool = [];
		this.workerNextTaskID = 1;
		this.workerSourceURL = "";
		this.defaultAttributeIDs = {
			position: "POSITION",
			normal: "NORMAL",
			color: "COLOR",
			uv: "TEX_COORD"
		};
		this.defaultAttributeTypes = {
			position: "Float32Array",
			normal: "Float32Array",
			color: "Float32Array",
			uv: "Float32Array"
		};
	}
	/**
	* Provides configuration for the decoder libraries. Configuration cannot be changed after decoding begins.
	*
	* @param {string} path - The decoder path.
	* @return {DRACOLoader} A reference to this loader.
	*/
	setDecoderPath(path) {
		this.decoderPath = path;
		return this;
	}
	/**
	* Provides configuration for the decoder libraries. Configuration cannot be changed after decoding begins.
	*
	* @param {{type:('js'|'wasm')}} config - The decoder config.
	* @return {DRACOLoader} A reference to this loader.
	*/
	setDecoderConfig(config) {
		this.decoderConfig = config;
		return this;
	}
	/**
	* Sets the maximum number of Web Workers to be used during decoding.
	* A lower limit may be preferable if workers are also for other tasks in the application.
	*
	* @param {number} workerLimit - The worker limit.
	* @return {DRACOLoader} A reference to this loader.
	*/
	setWorkerLimit(workerLimit) {
		this.workerLimit = workerLimit;
		return this;
	}
	/**
	* Starts loading from the given URL and passes the loaded Draco asset
	* to the `onLoad()` callback.
	*
	* @param {string} url - The path/URL of the file to be loaded. This can also be a data URI.
	* @param {function(BufferGeometry)} onLoad - Executed when the loading process has been finished.
	* @param {onProgressCallback} onProgress - Executed while the loading is in progress.
	* @param {onErrorCallback} onError - Executed when errors occur.
	*/
	load(url, onLoad, onProgress, onError) {
		const loader = new FileLoader(this.manager);
		loader.setPath(this.path);
		loader.setResponseType("arraybuffer");
		loader.setRequestHeader(this.requestHeader);
		loader.setWithCredentials(this.withCredentials);
		loader.load(url, (buffer) => {
			this.parse(buffer, onLoad, onError);
		}, onProgress, onError);
	}
	/**
	* Parses the given Draco data.
	*
	* @param {ArrayBuffer} buffer - The raw Draco data as an array buffer.
	* @param {function(BufferGeometry)} onLoad - Executed when the loading/parsing process has been finished.
	* @param {onErrorCallback} onError - Executed when errors occur.
	*/
	parse(buffer, onLoad, onError = () => {}) {
		this.decodeDracoFile(buffer, onLoad, null, null, SRGBColorSpace, onError).catch(onError);
	}
	decodeDracoFile(buffer, callback, attributeIDs, attributeTypes, vertexColorSpace = LinearSRGBColorSpace, onError = () => {}) {
		const taskConfig = {
			attributeIDs: attributeIDs || this.defaultAttributeIDs,
			attributeTypes: attributeTypes || this.defaultAttributeTypes,
			useUniqueIDs: !!attributeIDs,
			vertexColorSpace
		};
		return this.decodeGeometry(buffer, taskConfig).then(callback).catch(onError);
	}
	decodeGeometry(buffer, taskConfig) {
		const taskKey = JSON.stringify(taskConfig);
		if (_taskCache.has(buffer)) {
			const cachedTask = _taskCache.get(buffer);
			if (cachedTask.key === taskKey) return cachedTask.promise;
			else if (buffer.byteLength === 0) throw new Error("THREE.DRACOLoader: Unable to re-decode a buffer with different settings. Buffer has already been transferred.");
		}
		let worker;
		const taskID = this.workerNextTaskID++;
		const taskCost = buffer.byteLength;
		const geometryPending = this._getWorker(taskID, taskCost).then((_worker) => {
			worker = _worker;
			return new Promise((resolve, reject) => {
				worker._callbacks[taskID] = {
					resolve,
					reject
				};
				worker.postMessage({
					type: "decode",
					id: taskID,
					taskConfig,
					buffer
				}, [buffer]);
			});
		}).then((message) => this._createGeometry(message.geometry));
		geometryPending.catch(() => true).then(() => {
			if (worker && taskID) this._releaseTask(worker, taskID);
		});
		_taskCache.set(buffer, {
			key: taskKey,
			promise: geometryPending
		});
		return geometryPending;
	}
	_createGeometry(geometryData) {
		const geometry = new BufferGeometry();
		if (geometryData.index) geometry.setIndex(new BufferAttribute(geometryData.index.array, 1));
		for (let i = 0; i < geometryData.attributes.length; i++) {
			const { name, array, itemSize, stride, vertexColorSpace } = geometryData.attributes[i];
			let attribute;
			if (itemSize === stride) attribute = new BufferAttribute(array, itemSize);
			else {
				const buffer = new InterleavedBuffer(array, stride);
				attribute = new InterleavedBufferAttribute(buffer, itemSize, 0);
			}
			if (name === "color") {
				this._assignVertexColorSpace(attribute, vertexColorSpace);
				attribute.normalized = array instanceof Float32Array === false;
			}
			geometry.setAttribute(name, attribute);
		}
		return geometry;
	}
	_assignVertexColorSpace(attribute, inputColorSpace) {
		if (inputColorSpace !== "srgb") return;
		const _color = new Color();
		for (let i = 0, il = attribute.count; i < il; i++) {
			_color.fromBufferAttribute(attribute, i);
			ColorManagement.colorSpaceToWorking(_color, SRGBColorSpace);
			attribute.setXYZ(i, _color.r, _color.g, _color.b);
		}
	}
	_loadLibrary(url, responseType) {
		const loader = new FileLoader(this.manager);
		loader.setPath(this.decoderPath);
		loader.setResponseType(responseType);
		loader.setWithCredentials(this.withCredentials);
		return new Promise((resolve, reject) => {
			loader.load(url, resolve, void 0, reject);
		});
	}
	preload() {
		this._initDecoder();
		return this;
	}
	_initDecoder() {
		if (this.decoderPending) return this.decoderPending;
		const useJS = typeof WebAssembly !== "object" || this.decoderConfig.type === "js";
		const librariesPending = [];
		if (useJS) librariesPending.push(this._loadLibrary("draco_decoder.js", "text"));
		else {
			librariesPending.push(this._loadLibrary("draco_wasm_wrapper.js", "text"));
			librariesPending.push(this._loadLibrary("draco_decoder.wasm", "arraybuffer"));
		}
		this.decoderPending = Promise.all(librariesPending).then((libraries) => {
			const jsContent = libraries[0];
			if (!useJS) this.decoderConfig.wasmBinary = libraries[1];
			const fn = DRACOWorker.toString();
			const body = [
				"/* draco decoder */",
				jsContent,
				"",
				"/* worker */",
				fn.substring(fn.indexOf("{") + 1, fn.lastIndexOf("}"))
			].join("\n");
			this.workerSourceURL = URL.createObjectURL(new Blob([body]));
		});
		return this.decoderPending;
	}
	_getWorker(taskID, taskCost) {
		return this._initDecoder().then(() => {
			if (this.workerPool.length < this.workerLimit) {
				const worker = new Worker(this.workerSourceURL);
				worker._callbacks = {};
				worker._taskCosts = {};
				worker._taskLoad = 0;
				worker.postMessage({
					type: "init",
					decoderConfig: this.decoderConfig
				});
				worker.onmessage = function(e) {
					const message = e.data;
					switch (message.type) {
						case "decode":
							worker._callbacks[message.id].resolve(message);
							break;
						case "error":
							worker._callbacks[message.id].reject(message);
							break;
						default: console.error("THREE.DRACOLoader: Unexpected message, \"" + message.type + "\"");
					}
				};
				this.workerPool.push(worker);
			} else this.workerPool.sort(function(a, b) {
				return a._taskLoad > b._taskLoad ? -1 : 1;
			});
			const worker = this.workerPool[this.workerPool.length - 1];
			worker._taskCosts[taskID] = taskCost;
			worker._taskLoad += taskCost;
			return worker;
		});
	}
	_releaseTask(worker, taskID) {
		worker._taskLoad -= worker._taskCosts[taskID];
		delete worker._callbacks[taskID];
		delete worker._taskCosts[taskID];
	}
	debug() {
		console.log("Task load: ", this.workerPool.map((worker) => worker._taskLoad));
	}
	dispose() {
		for (let i = 0; i < this.workerPool.length; ++i) this.workerPool[i].terminate();
		this.workerPool.length = 0;
		if (this.workerSourceURL !== "") URL.revokeObjectURL(this.workerSourceURL);
		return this;
	}
};
function DRACOWorker() {
	let decoderConfig;
	let decoderPending;
	onmessage = function(e) {
		const message = e.data;
		switch (message.type) {
			case "init":
				decoderConfig = message.decoderConfig;
				decoderPending = new Promise(function(resolve) {
					decoderConfig.onModuleLoaded = function(draco) {
						resolve({ draco });
					};
					DracoDecoderModule(decoderConfig);
				});
				break;
			case "decode":
				const buffer = message.buffer;
				const taskConfig = message.taskConfig;
				decoderPending.then((module) => {
					const draco = module.draco;
					const decoder = new draco.Decoder();
					try {
						const geometry = decodeGeometry(draco, decoder, new Int8Array(buffer), taskConfig);
						const buffers = geometry.attributes.map((attr) => attr.array.buffer);
						if (geometry.index) buffers.push(geometry.index.array.buffer);
						self.postMessage({
							type: "decode",
							id: message.id,
							geometry
						}, buffers);
					} catch (error) {
						console.error(error);
						self.postMessage({
							type: "error",
							id: message.id,
							error: error.message
						});
					} finally {
						draco.destroy(decoder);
					}
				});
		}
	};
	function decodeGeometry(draco, decoder, array, taskConfig) {
		const attributeIDs = taskConfig.attributeIDs;
		const attributeTypes = taskConfig.attributeTypes;
		let dracoGeometry;
		let decodingStatus;
		const geometryType = decoder.GetEncodedGeometryType(array);
		if (geometryType === draco.TRIANGULAR_MESH) {
			dracoGeometry = new draco.Mesh();
			decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
		} else if (geometryType === draco.POINT_CLOUD) {
			dracoGeometry = new draco.PointCloud();
			decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
		} else throw new Error("THREE.DRACOLoader: Unexpected geometry type.");
		if (!decodingStatus.ok() || dracoGeometry.ptr === 0) throw new Error("THREE.DRACOLoader: Decoding failed: " + decodingStatus.error_msg());
		const geometry = {
			index: null,
			attributes: []
		};
		for (const attributeName in attributeIDs) {
			const attributeType = self[attributeTypes[attributeName]];
			let attribute;
			let attributeID;
			if (taskConfig.useUniqueIDs) {
				attributeID = attributeIDs[attributeName];
				attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeID);
			} else {
				attributeID = decoder.GetAttributeId(dracoGeometry, draco[attributeIDs[attributeName]]);
				if (attributeID === -1) continue;
				attribute = decoder.GetAttribute(dracoGeometry, attributeID);
			}
			const attributeResult = decodeAttribute(draco, decoder, dracoGeometry, attributeName, attributeType, attribute);
			if (attributeName === "color") attributeResult.vertexColorSpace = taskConfig.vertexColorSpace;
			geometry.attributes.push(attributeResult);
		}
		if (geometryType === draco.TRIANGULAR_MESH) geometry.index = decodeIndex(draco, decoder, dracoGeometry);
		draco.destroy(dracoGeometry);
		return geometry;
	}
	function decodeIndex(draco, decoder, dracoGeometry) {
		const numIndices = dracoGeometry.num_faces() * 3;
		const byteLength = numIndices * 4;
		const ptr = draco._malloc(byteLength);
		decoder.GetTrianglesUInt32Array(dracoGeometry, byteLength, ptr);
		const index = new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice();
		draco._free(ptr);
		return {
			array: index,
			itemSize: 1
		};
	}
	function decodeAttribute(draco, decoder, dracoGeometry, attributeName, TypedArray, attribute) {
		const count = dracoGeometry.num_points();
		const itemSize = attribute.num_components();
		const dracoDataType = getDracoDataType(draco, TypedArray);
		const srcByteStride = itemSize * TypedArray.BYTES_PER_ELEMENT;
		const dstByteStride = Math.ceil(srcByteStride / 4) * 4;
		const dstStride = dstByteStride / TypedArray.BYTES_PER_ELEMENT;
		const srcByteLength = count * srcByteStride;
		const dstByteLength = count * dstByteStride;
		const ptr = draco._malloc(srcByteLength);
		decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dracoDataType, srcByteLength, ptr);
		const srcArray = new TypedArray(draco.HEAPF32.buffer, ptr, srcByteLength / TypedArray.BYTES_PER_ELEMENT);
		let dstArray;
		if (srcByteStride === dstByteStride) dstArray = srcArray.slice();
		else {
			dstArray = new TypedArray(dstByteLength / TypedArray.BYTES_PER_ELEMENT);
			let dstOffset = 0;
			for (let i = 0, il = srcArray.length; i < il; i++) {
				for (let j = 0; j < itemSize; j++) dstArray[dstOffset + j] = srcArray[i * itemSize + j];
				dstOffset += dstStride;
			}
		}
		draco._free(ptr);
		return {
			name: attributeName,
			count,
			itemSize,
			array: dstArray,
			stride: dstStride
		};
	}
	function getDracoDataType(draco, TypedArray) {
		switch (TypedArray) {
			case Float32Array: return draco.DT_FLOAT32;
			case Int8Array: return draco.DT_INT8;
			case Int16Array: return draco.DT_INT16;
			case Int32Array: return draco.DT_INT32;
			case Uint8Array: return draco.DT_UINT8;
			case Uint16Array: return draco.DT_UINT16;
			case Uint32Array: return draco.DT_UINT32;
		}
	}
}
//#endregion
export { DRACOLoader };
