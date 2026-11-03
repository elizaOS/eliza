var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../../node_modules/.bun/eventemitter3@5.0.1/node_modules/eventemitter3/index.js
var require_eventemitter3 = __commonJS(function(exports, module) {
  var has = Object.prototype.hasOwnProperty;
  var prefix = "~";
  function Events() {}
  if (Object.create) {
    Events.prototype = Object.create(null);
    if (!new Events().__proto__)
      prefix = false;
  }
  function EE(fn, context, once) {
    this.fn = fn;
    this.context = context;
    this.once = once || false;
  }
  function addListener(emitter, event, fn, context, once) {
    if (typeof fn !== "function") {
      throw new TypeError("The listener must be a function");
    }
    var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
    if (!emitter._events[evt])
      emitter._events[evt] = listener, emitter._eventsCount++;
    else if (!emitter._events[evt].fn)
      emitter._events[evt].push(listener);
    else
      emitter._events[evt] = [emitter._events[evt], listener];
    return emitter;
  }
  function clearEvent(emitter, evt) {
    if (--emitter._eventsCount === 0)
      emitter._events = new Events;
    else
      delete emitter._events[evt];
  }
  function EventEmitter() {
    this._events = new Events;
    this._eventsCount = 0;
  }
  EventEmitter.prototype.eventNames = function eventNames() {
    var names = [], events, name;
    if (this._eventsCount === 0)
      return names;
    for (name in events = this._events) {
      if (has.call(events, name))
        names.push(prefix ? name.slice(1) : name);
    }
    if (Object.getOwnPropertySymbols) {
      return names.concat(Object.getOwnPropertySymbols(events));
    }
    return names;
  };
  EventEmitter.prototype.listeners = function listeners(event) {
    var evt = prefix ? prefix + event : event, handlers = this._events[evt];
    if (!handlers)
      return [];
    if (handlers.fn)
      return [handlers.fn];
    for (var i = 0, l = handlers.length, ee = new Array(l);i < l; i++) {
      ee[i] = handlers[i].fn;
    }
    return ee;
  };
  EventEmitter.prototype.listenerCount = function listenerCount(event) {
    var evt = prefix ? prefix + event : event, listeners = this._events[evt];
    if (!listeners)
      return 0;
    if (listeners.fn)
      return 1;
    return listeners.length;
  };
  EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
    var evt = prefix ? prefix + event : event;
    if (!this._events[evt])
      return false;
    var listeners = this._events[evt], len = arguments.length, args, i;
    if (listeners.fn) {
      if (listeners.once)
        this.removeListener(event, listeners.fn, undefined, true);
      switch (len) {
        case 1:
          return listeners.fn.call(listeners.context), true;
        case 2:
          return listeners.fn.call(listeners.context, a1), true;
        case 3:
          return listeners.fn.call(listeners.context, a1, a2), true;
        case 4:
          return listeners.fn.call(listeners.context, a1, a2, a3), true;
        case 5:
          return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
        case 6:
          return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
      }
      for (i = 1, args = new Array(len - 1);i < len; i++) {
        args[i - 1] = arguments[i];
      }
      listeners.fn.apply(listeners.context, args);
    } else {
      var length = listeners.length, j;
      for (i = 0;i < length; i++) {
        if (listeners[i].once)
          this.removeListener(event, listeners[i].fn, undefined, true);
        switch (len) {
          case 1:
            listeners[i].fn.call(listeners[i].context);
            break;
          case 2:
            listeners[i].fn.call(listeners[i].context, a1);
            break;
          case 3:
            listeners[i].fn.call(listeners[i].context, a1, a2);
            break;
          case 4:
            listeners[i].fn.call(listeners[i].context, a1, a2, a3);
            break;
          default:
            if (!args)
              for (j = 1, args = new Array(len - 1);j < len; j++) {
                args[j - 1] = arguments[j];
              }
            listeners[i].fn.apply(listeners[i].context, args);
        }
      }
    }
    return true;
  };
  EventEmitter.prototype.on = function on(event, fn, context) {
    return addListener(this, event, fn, context, false);
  };
  EventEmitter.prototype.once = function once(event, fn, context) {
    return addListener(this, event, fn, context, true);
  };
  EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
    var evt = prefix ? prefix + event : event;
    if (!this._events[evt])
      return this;
    if (!fn) {
      clearEvent(this, evt);
      return this;
    }
    var listeners = this._events[evt];
    if (listeners.fn) {
      if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
        clearEvent(this, evt);
      }
    } else {
      for (var i = 0, events = [], length = listeners.length;i < length; i++) {
        if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
          events.push(listeners[i]);
        }
      }
      if (events.length)
        this._events[evt] = events.length === 1 ? events[0] : events;
      else
        clearEvent(this, evt);
    }
    return this;
  };
  EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
    var evt;
    if (event) {
      evt = prefix ? prefix + event : event;
      if (this._events[evt])
        clearEvent(this, evt);
    } else {
      this._events = new Events;
      this._eventsCount = 0;
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prefixed = prefix;
  EventEmitter.EventEmitter = EventEmitter;
  if (typeof module !== "undefined") {
    module.exports = EventEmitter;
  }
});

// ../../node_modules/.bun/eventemitter3@5.0.1/node_modules/eventemitter3/index.mjs
var import__, eventemitter3_default;
var init_eventemitter3 = __esm(() => {
  import__ = __toESM(require_eventemitter3(), 1);
  eventemitter3_default = import__.default;
});

// ../../node_modules/.bun/@solana+wallet-standard-features@1.5.0/node_modules/@solana/wallet-standard-features/lib/esm/signAndSendTransaction.js
var SolanaSignAndSendTransaction = "solana:signAndSendTransaction";

// ../../node_modules/.bun/@solana+wallet-standard-features@1.5.0/node_modules/@solana/wallet-standard-features/lib/esm/signMessage.js
var SolanaSignMessage = "solana:signMessage";

// ../../node_modules/.bun/@solana+wallet-standard-features@1.5.0/node_modules/@solana/wallet-standard-features/lib/esm/signTransaction.js
var SolanaSignTransaction = "solana:signTransaction";

// ../../node_modules/.bun/@solana+wallet-standard-features@1.5.0/node_modules/@solana/wallet-standard-features/lib/esm/index.js
var init_esm = () => {};

// node:buffer
var exports_buffer = {};
__export(exports_buffer, {
  Blob: () => Blob,
  Buffer: () => Buffer2,
  File: () => File,
  INSPECT_MAX_BYTES: () => INSPECT_MAX_BYTES,
  atob: () => atob,
  btoa: () => btoa2,
  constants: () => constants,
  default: () => buffer_default,
  isAscii: () => isAscii,
  isUtf8: () => isUtf8,
  kMaxLength: () => kMaxLength,
  kStringMaxLength: () => kStringMaxLength,
  resolveObjectURL: () => resolveObjectURL,
  transcode: () => transcode
});
function getLens(b64) {
  var len2 = b64.length;
  if (len2 % 4 > 0)
    throw Error("Invalid string. Length must be a multiple of 4");
  var validLen = b64.indexOf("=");
  if (validLen === -1)
    validLen = len2;
  var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
}
function _byteLength(validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}
function toByteArray(b64) {
  var tmp, lens = getLens(b64), validLen = lens[0], placeHoldersLen = lens[1], arr = new Uint8Array(_byteLength(validLen, placeHoldersLen)), curByte = 0, len2 = placeHoldersLen > 0 ? validLen - 4 : validLen, i2;
  for (i2 = 0;i2 < len2; i2 += 4)
    tmp = revLookup[b64.charCodeAt(i2)] << 18 | revLookup[b64.charCodeAt(i2 + 1)] << 12 | revLookup[b64.charCodeAt(i2 + 2)] << 6 | revLookup[b64.charCodeAt(i2 + 3)], arr[curByte++] = tmp >> 16 & 255, arr[curByte++] = tmp >> 8 & 255, arr[curByte++] = tmp & 255;
  if (placeHoldersLen === 2)
    tmp = revLookup[b64.charCodeAt(i2)] << 2 | revLookup[b64.charCodeAt(i2 + 1)] >> 4, arr[curByte++] = tmp & 255;
  if (placeHoldersLen === 1)
    tmp = revLookup[b64.charCodeAt(i2)] << 10 | revLookup[b64.charCodeAt(i2 + 1)] << 4 | revLookup[b64.charCodeAt(i2 + 2)] >> 2, arr[curByte++] = tmp >> 8 & 255, arr[curByte++] = tmp & 255;
  return arr;
}
function tripletToBase64(num) {
  return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
}
function encodeChunk(uint8, start, end) {
  var tmp, output = [];
  for (var i2 = start;i2 < end; i2 += 3)
    tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255), output.push(tripletToBase64(tmp));
  return output.join("");
}
function fromByteArray(uint8) {
  var tmp, len2 = uint8.length, extraBytes = len2 % 3, parts = [], maxChunkLength = 16383;
  for (var i2 = 0, len22 = len2 - extraBytes;i2 < len22; i2 += maxChunkLength)
    parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
  if (extraBytes === 1)
    tmp = uint8[len2 - 1], parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
  else if (extraBytes === 2)
    tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1], parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
  return parts.join("");
}
function read(buffer, offset, isLE, mLen, nBytes) {
  var e, m, eLen = nBytes * 8 - mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1, nBits = -7, i2 = isLE ? nBytes - 1 : 0, d = isLE ? -1 : 1, s = buffer[offset + i2];
  i2 += d, e = s & (1 << -nBits) - 1, s >>= -nBits, nBits += eLen;
  for (;nBits > 0; e = e * 256 + buffer[offset + i2], i2 += d, nBits -= 8)
    ;
  m = e & (1 << -nBits) - 1, e >>= -nBits, nBits += mLen;
  for (;nBits > 0; m = m * 256 + buffer[offset + i2], i2 += d, nBits -= 8)
    ;
  if (e === 0)
    e = 1 - eBias;
  else if (e === eMax)
    return m ? NaN : (s ? -1 : 1) * (1 / 0);
  else
    m = m + Math.pow(2, mLen), e = e - eBias;
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
}
function write(buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c, eLen = nBytes * 8 - mLen - 1, eMax = (1 << eLen) - 1, eBias = eMax >> 1, rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0, i2 = isLE ? 0 : nBytes - 1, d = isLE ? 1 : -1, s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
  if (value = Math.abs(value), isNaN(value) || value === 1 / 0)
    m = isNaN(value) ? 1 : 0, e = eMax;
  else {
    if (e = Math.floor(Math.log(value) / Math.LN2), value * (c = Math.pow(2, -e)) < 1)
      e--, c *= 2;
    if (e + eBias >= 1)
      value += rt / c;
    else
      value += rt * Math.pow(2, 1 - eBias);
    if (value * c >= 2)
      e++, c /= 2;
    if (e + eBias >= eMax)
      m = 0, e = eMax;
    else if (e + eBias >= 1)
      m = (value * c - 1) * Math.pow(2, mLen), e = e + eBias;
    else
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen), e = 0;
  }
  for (;mLen >= 8; buffer[offset + i2] = m & 255, i2 += d, m /= 256, mLen -= 8)
    ;
  e = e << mLen | m, eLen += mLen;
  for (;eLen > 0; buffer[offset + i2] = e & 255, i2 += d, e /= 256, eLen -= 8)
    ;
  buffer[offset + i2 - d] |= s * 128;
}
function createBuffer(length) {
  if (length > kMaxLength)
    throw RangeError('The value "' + length + '" is invalid for option "size"');
  let buf = new Uint8Array(length);
  return Object.setPrototypeOf(buf, Buffer2.prototype), buf;
}
function E(sym, getMessage, Base) {
  return class extends Base {
    constructor() {
      super();
      Object.defineProperty(this, "message", { value: getMessage.apply(this, arguments), writable: true, configurable: true }), this.name = `${this.name} [${sym}]`, this.stack, delete this.name;
    }
    get code() {
      return sym;
    }
    set code(value) {
      Object.defineProperty(this, "code", { configurable: true, enumerable: true, value, writable: true });
    }
    toString() {
      return `${this.name} [${sym}]: ${this.message}`;
    }
  };
}
function Buffer2(arg, encodingOrOffset, length) {
  if (typeof arg === "number") {
    if (typeof encodingOrOffset === "string")
      throw TypeError('The "string" argument must be of type string. Received type number');
    return allocUnsafe(arg);
  }
  return from(arg, encodingOrOffset, length);
}
function from(value, encodingOrOffset, length) {
  if (typeof value === "string")
    return fromString(value, encodingOrOffset);
  if (ArrayBuffer.isView(value))
    return fromArrayView(value);
  if (value == null)
    throw TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
  if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer))
    return fromArrayBuffer(value, encodingOrOffset, length);
  if (typeof SharedArrayBuffer < "u" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer)))
    return fromArrayBuffer(value, encodingOrOffset, length);
  if (typeof value === "number")
    throw TypeError('The "value" argument must not be of type number. Received type number');
  let valueOf = value.valueOf && value.valueOf();
  if (valueOf != null && valueOf !== value)
    return Buffer2.from(valueOf, encodingOrOffset, length);
  let b = fromObject(value);
  if (b)
    return b;
  if (typeof Symbol < "u" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function")
    return Buffer2.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
  throw TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
}
function assertSize(size) {
  if (typeof size !== "number")
    throw TypeError('"size" argument must be of type number');
  else if (size < 0)
    throw RangeError('The value "' + size + '" is invalid for option "size"');
}
function alloc(size, fill, encoding) {
  if (assertSize(size), size <= 0)
    return createBuffer(size);
  if (fill !== undefined)
    return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
  return createBuffer(size);
}
function allocUnsafe(size) {
  return assertSize(size), createBuffer(size < 0 ? 0 : checked(size) | 0);
}
function fromString(string, encoding) {
  if (typeof encoding !== "string" || encoding === "")
    encoding = "utf8";
  if (!Buffer2.isEncoding(encoding))
    throw TypeError("Unknown encoding: " + encoding);
  let length = byteLength(string, encoding) | 0, buf = createBuffer(length), actual = buf.write(string, encoding);
  if (actual !== length)
    buf = buf.slice(0, actual);
  return buf;
}
function fromArrayLike(array) {
  let length = array.length < 0 ? 0 : checked(array.length) | 0, buf = createBuffer(length);
  for (let i2 = 0;i2 < length; i2 += 1)
    buf[i2] = array[i2] & 255;
  return buf;
}
function fromArrayView(arrayView) {
  if (isInstance(arrayView, Uint8Array)) {
    let copy = new Uint8Array(arrayView);
    return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
  }
  return fromArrayLike(arrayView);
}
function fromArrayBuffer(array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset)
    throw RangeError('"offset" is outside of buffer bounds');
  if (array.byteLength < byteOffset + (length || 0))
    throw RangeError('"length" is outside of buffer bounds');
  let buf;
  if (byteOffset === undefined && length === undefined)
    buf = new Uint8Array(array);
  else if (length === undefined)
    buf = new Uint8Array(array, byteOffset);
  else
    buf = new Uint8Array(array, byteOffset, length);
  return Object.setPrototypeOf(buf, Buffer2.prototype), buf;
}
function fromObject(obj) {
  if (Buffer2.isBuffer(obj)) {
    let len2 = checked(obj.length) | 0, buf = createBuffer(len2);
    if (buf.length === 0)
      return buf;
    return obj.copy(buf, 0, 0, len2), buf;
  }
  if (obj.length !== undefined) {
    if (typeof obj.length !== "number" || Number.isNaN(obj.length))
      return createBuffer(0);
    return fromArrayLike(obj);
  }
  if (obj.type === "Buffer" && Array.isArray(obj.data))
    return fromArrayLike(obj.data);
}
function checked(length) {
  if (length >= kMaxLength)
    throw RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + kMaxLength.toString(16) + " bytes");
  return length | 0;
}
function byteLength(string, encoding) {
  if (Buffer2.isBuffer(string))
    return string.length;
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer))
    return string.byteLength;
  if (typeof string !== "string")
    throw TypeError('The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string);
  let len2 = string.length, mustMatch = arguments.length > 2 && arguments[2] === true;
  if (!mustMatch && len2 === 0)
    return 0;
  let loweredCase = false;
  for (;; )
    switch (encoding) {
      case "ascii":
      case "latin1":
      case "binary":
        return len2;
      case "utf8":
      case "utf-8":
        return utf8ToBytes(string).length;
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return len2 * 2;
      case "hex":
        return len2 >>> 1;
      case "base64":
        return base64ToBytes(string).length;
      default:
        if (loweredCase)
          return mustMatch ? -1 : utf8ToBytes(string).length;
        encoding = ("" + encoding).toLowerCase(), loweredCase = true;
    }
}
function slowToString(encoding, start, end) {
  let loweredCase = false;
  if (start === undefined || start < 0)
    start = 0;
  if (start > this.length)
    return "";
  if (end === undefined || end > this.length)
    end = this.length;
  if (end <= 0)
    return "";
  if (end >>>= 0, start >>>= 0, end <= start)
    return "";
  if (!encoding)
    encoding = "utf8";
  while (true)
    switch (encoding) {
      case "hex":
        return hexSlice(this, start, end);
      case "utf8":
      case "utf-8":
        return utf8Slice(this, start, end);
      case "ascii":
        return asciiSlice(this, start, end);
      case "latin1":
      case "binary":
        return latin1Slice(this, start, end);
      case "base64":
        return base64Slice(this, start, end);
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return utf16leSlice(this, start, end);
      default:
        if (loweredCase)
          throw TypeError("Unknown encoding: " + encoding);
        encoding = (encoding + "").toLowerCase(), loweredCase = true;
    }
}
function swap(b, n, m) {
  let i2 = b[n];
  b[n] = b[m], b[m] = i2;
}
function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  if (buffer.length === 0)
    return -1;
  if (typeof byteOffset === "string")
    encoding = byteOffset, byteOffset = 0;
  else if (byteOffset > 2147483647)
    byteOffset = 2147483647;
  else if (byteOffset < -2147483648)
    byteOffset = -2147483648;
  if (byteOffset = +byteOffset, Number.isNaN(byteOffset))
    byteOffset = dir ? 0 : buffer.length - 1;
  if (byteOffset < 0)
    byteOffset = buffer.length + byteOffset;
  if (byteOffset >= buffer.length)
    if (dir)
      return -1;
    else
      byteOffset = buffer.length - 1;
  else if (byteOffset < 0)
    if (dir)
      byteOffset = 0;
    else
      return -1;
  if (typeof val === "string")
    val = Buffer2.from(val, encoding);
  if (Buffer2.isBuffer(val)) {
    if (val.length === 0)
      return -1;
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
  } else if (typeof val === "number") {
    if (val = val & 255, typeof Uint8Array.prototype.indexOf === "function")
      if (dir)
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
      else
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
    return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
  }
  throw TypeError("val must be string, number or Buffer");
}
function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
  let indexSize = 1, arrLength = arr.length, valLength = val.length;
  if (encoding !== undefined) {
    if (encoding = String(encoding).toLowerCase(), encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
      if (arr.length < 2 || val.length < 2)
        return -1;
      indexSize = 2, arrLength /= 2, valLength /= 2, byteOffset /= 2;
    }
  }
  function read2(buf, i3) {
    if (indexSize === 1)
      return buf[i3];
    else
      return buf.readUInt16BE(i3 * indexSize);
  }
  let i2;
  if (dir) {
    let foundIndex = -1;
    for (i2 = byteOffset;i2 < arrLength; i2++)
      if (read2(arr, i2) === read2(val, foundIndex === -1 ? 0 : i2 - foundIndex)) {
        if (foundIndex === -1)
          foundIndex = i2;
        if (i2 - foundIndex + 1 === valLength)
          return foundIndex * indexSize;
      } else {
        if (foundIndex !== -1)
          i2 -= i2 - foundIndex;
        foundIndex = -1;
      }
  } else {
    if (byteOffset + valLength > arrLength)
      byteOffset = arrLength - valLength;
    for (i2 = byteOffset;i2 >= 0; i2--) {
      let found = true;
      for (let j = 0;j < valLength; j++)
        if (read2(arr, i2 + j) !== read2(val, j)) {
          found = false;
          break;
        }
      if (found)
        return i2;
    }
  }
  return -1;
}
function hexWrite(buf, string, offset, length) {
  offset = Number(offset) || 0;
  let remaining = buf.length - offset;
  if (!length)
    length = remaining;
  else if (length = Number(length), length > remaining)
    length = remaining;
  let strLen = string.length;
  if (length > strLen / 2)
    length = strLen / 2;
  let i2;
  for (i2 = 0;i2 < length; ++i2) {
    let parsed = parseInt(string.substr(i2 * 2, 2), 16);
    if (Number.isNaN(parsed))
      return i2;
    buf[offset + i2] = parsed;
  }
  return i2;
}
function utf8Write(buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
}
function asciiWrite(buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length);
}
function base64Write(buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length);
}
function ucs2Write(buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
}
function base64Slice(buf, start, end) {
  if (start === 0 && end === buf.length)
    return fromByteArray(buf);
  else
    return fromByteArray(buf.slice(start, end));
}
function utf8Slice(buf, start, end) {
  end = Math.min(buf.length, end);
  let res = [], i2 = start;
  while (i2 < end) {
    let firstByte = buf[i2], codePoint = null, bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
    if (i2 + bytesPerSequence <= end) {
      let secondByte, thirdByte, fourthByte, tempCodePoint;
      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 128)
            codePoint = firstByte;
          break;
        case 2:
          if (secondByte = buf[i2 + 1], (secondByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 31) << 6 | secondByte & 63, tempCodePoint > 127)
              codePoint = tempCodePoint;
          }
          break;
        case 3:
          if (secondByte = buf[i2 + 1], thirdByte = buf[i2 + 2], (secondByte & 192) === 128 && (thirdByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63, tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343))
              codePoint = tempCodePoint;
          }
          break;
        case 4:
          if (secondByte = buf[i2 + 1], thirdByte = buf[i2 + 2], fourthByte = buf[i2 + 3], (secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
            if (tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63, tempCodePoint > 65535 && tempCodePoint < 1114112)
              codePoint = tempCodePoint;
          }
      }
    }
    if (codePoint === null)
      codePoint = 65533, bytesPerSequence = 1;
    else if (codePoint > 65535)
      codePoint -= 65536, res.push(codePoint >>> 10 & 1023 | 55296), codePoint = 56320 | codePoint & 1023;
    res.push(codePoint), i2 += bytesPerSequence;
  }
  return decodeCodePointsArray(res);
}
function decodeCodePointsArray(codePoints) {
  let len2 = codePoints.length;
  if (len2 <= MAX_ARGUMENTS_LENGTH)
    return String.fromCharCode.apply(String, codePoints);
  let res = "", i2 = 0;
  while (i2 < len2)
    res += String.fromCharCode.apply(String, codePoints.slice(i2, i2 += MAX_ARGUMENTS_LENGTH));
  return res;
}
function asciiSlice(buf, start, end) {
  let ret = "";
  end = Math.min(buf.length, end);
  for (let i2 = start;i2 < end; ++i2)
    ret += String.fromCharCode(buf[i2] & 127);
  return ret;
}
function latin1Slice(buf, start, end) {
  let ret = "";
  end = Math.min(buf.length, end);
  for (let i2 = start;i2 < end; ++i2)
    ret += String.fromCharCode(buf[i2]);
  return ret;
}
function hexSlice(buf, start, end) {
  let len2 = buf.length;
  if (!start || start < 0)
    start = 0;
  if (!end || end < 0 || end > len2)
    end = len2;
  let out = "";
  for (let i2 = start;i2 < end; ++i2)
    out += hexSliceLookupTable[buf[i2]];
  return out;
}
function utf16leSlice(buf, start, end) {
  let bytes = buf.slice(start, end), res = "";
  for (let i2 = 0;i2 < bytes.length - 1; i2 += 2)
    res += String.fromCharCode(bytes[i2] + bytes[i2 + 1] * 256);
  return res;
}
function checkOffset(offset, ext, length) {
  if (offset % 1 !== 0 || offset < 0)
    throw RangeError("offset is not uint");
  if (offset + ext > length)
    throw RangeError("Trying to access beyond buffer length");
}
function checkInt(buf, value, offset, ext, max, min) {
  if (!Buffer2.isBuffer(buf))
    throw TypeError('"buffer" argument must be a Buffer instance');
  if (value > max || value < min)
    throw RangeError('"value" argument is out of bounds');
  if (offset + ext > buf.length)
    throw RangeError("Index out of range");
}
function wrtBigUInt64LE(buf, value, offset, min, max) {
  checkIntBI(value, min, max, buf, offset, 7);
  let lo = Number(value & BigInt(4294967295));
  buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo, lo = lo >> 8, buf[offset++] = lo;
  let hi = Number(value >> BigInt(32) & BigInt(4294967295));
  return buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, hi = hi >> 8, buf[offset++] = hi, offset;
}
function wrtBigUInt64BE(buf, value, offset, min, max) {
  checkIntBI(value, min, max, buf, offset, 7);
  let lo = Number(value & BigInt(4294967295));
  buf[offset + 7] = lo, lo = lo >> 8, buf[offset + 6] = lo, lo = lo >> 8, buf[offset + 5] = lo, lo = lo >> 8, buf[offset + 4] = lo;
  let hi = Number(value >> BigInt(32) & BigInt(4294967295));
  return buf[offset + 3] = hi, hi = hi >> 8, buf[offset + 2] = hi, hi = hi >> 8, buf[offset + 1] = hi, hi = hi >> 8, buf[offset] = hi, offset + 8;
}
function checkIEEE754(buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length)
    throw RangeError("Index out of range");
  if (offset < 0)
    throw RangeError("Index out of range");
}
function writeFloat(buf, value, offset, littleEndian, noAssert) {
  if (value = +value, offset = offset >>> 0, !noAssert)
    checkIEEE754(buf, value, offset, 4, 340282346638528860000000000000000000000, -340282346638528860000000000000000000000);
  return write(buf, value, offset, littleEndian, 23, 4), offset + 4;
}
function writeDouble(buf, value, offset, littleEndian, noAssert) {
  if (value = +value, offset = offset >>> 0, !noAssert)
    checkIEEE754(buf, value, offset, 8, 179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000, -179769313486231570000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000);
  return write(buf, value, offset, littleEndian, 52, 8), offset + 8;
}
function addNumericalSeparator(val) {
  let res = "", i2 = val.length, start = val[0] === "-" ? 1 : 0;
  for (;i2 >= start + 4; i2 -= 3)
    res = `_${val.slice(i2 - 3, i2)}${res}`;
  return `${val.slice(0, i2)}${res}`;
}
function checkBounds(buf, offset, byteLength2) {
  if (validateNumber(offset, "offset"), buf[offset] === undefined || buf[offset + byteLength2] === undefined)
    boundsError(offset, buf.length - (byteLength2 + 1));
}
function checkIntBI(value, min, max, buf, offset, byteLength2) {
  if (value > max || value < min) {
    let n = typeof min === "bigint" ? "n" : "", range;
    if (byteLength2 > 3)
      if (min === 0 || min === BigInt(0))
        range = `>= 0${n} and < 2${n} ** ${(byteLength2 + 1) * 8}${n}`;
      else
        range = `>= -(2${n} ** ${(byteLength2 + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength2 + 1) * 8 - 1}${n}`;
    else
      range = `>= ${min}${n} and <= ${max}${n}`;
    throw new ERR_OUT_OF_RANGE("value", range, value);
  }
  checkBounds(buf, offset, byteLength2);
}
function validateNumber(value, name) {
  if (typeof value !== "number")
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}
function boundsError(value, length, type) {
  if (Math.floor(value) !== value)
    throw validateNumber(value, type), new ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
  if (length < 0)
    throw new ERR_BUFFER_OUT_OF_BOUNDS;
  throw new ERR_OUT_OF_RANGE(type || "offset", `>= ${type ? 1 : 0} and <= ${length}`, value);
}
function base64clean(str) {
  if (str = str.split("=")[0], str = str.trim().replace(INVALID_BASE64_RE, ""), str.length < 2)
    return "";
  while (str.length % 4 !== 0)
    str = str + "=";
  return str;
}
function utf8ToBytes(string, units) {
  units = units || 1 / 0;
  let codePoint, length = string.length, leadSurrogate = null, bytes = [];
  for (let i2 = 0;i2 < length; ++i2) {
    if (codePoint = string.charCodeAt(i2), codePoint > 55295 && codePoint < 57344) {
      if (!leadSurrogate) {
        if (codePoint > 56319) {
          if ((units -= 3) > -1)
            bytes.push(239, 191, 189);
          continue;
        } else if (i2 + 1 === length) {
          if ((units -= 3) > -1)
            bytes.push(239, 191, 189);
          continue;
        }
        leadSurrogate = codePoint;
        continue;
      }
      if (codePoint < 56320) {
        if ((units -= 3) > -1)
          bytes.push(239, 191, 189);
        leadSurrogate = codePoint;
        continue;
      }
      codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
    } else if (leadSurrogate) {
      if ((units -= 3) > -1)
        bytes.push(239, 191, 189);
    }
    if (leadSurrogate = null, codePoint < 128) {
      if ((units -= 1) < 0)
        break;
      bytes.push(codePoint);
    } else if (codePoint < 2048) {
      if ((units -= 2) < 0)
        break;
      bytes.push(codePoint >> 6 | 192, codePoint & 63 | 128);
    } else if (codePoint < 65536) {
      if ((units -= 3) < 0)
        break;
      bytes.push(codePoint >> 12 | 224, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
    } else if (codePoint < 1114112) {
      if ((units -= 4) < 0)
        break;
      bytes.push(codePoint >> 18 | 240, codePoint >> 12 & 63 | 128, codePoint >> 6 & 63 | 128, codePoint & 63 | 128);
    } else
      throw Error("Invalid code point");
  }
  return bytes;
}
function asciiToBytes(str) {
  let byteArray = [];
  for (let i2 = 0;i2 < str.length; ++i2)
    byteArray.push(str.charCodeAt(i2) & 255);
  return byteArray;
}
function utf16leToBytes(str, units) {
  let c, hi, lo, byteArray = [];
  for (let i2 = 0;i2 < str.length; ++i2) {
    if ((units -= 2) < 0)
      break;
    c = str.charCodeAt(i2), hi = c >> 8, lo = c % 256, byteArray.push(lo), byteArray.push(hi);
  }
  return byteArray;
}
function base64ToBytes(str) {
  return toByteArray(base64clean(str));
}
function blitBuffer(src, dst, offset, length) {
  let i2;
  for (i2 = 0;i2 < length; ++i2) {
    if (i2 + offset >= dst.length || i2 >= src.length)
      break;
    dst[i2 + offset] = src[i2];
  }
  return i2;
}
function isInstance(obj, type) {
  return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
}
function defineBigIntMethod(fn) {
  return typeof BigInt > "u" ? BufferBigIntNotDefined : fn;
}
function BufferBigIntNotDefined() {
  throw Error("BigInt not supported");
}
function notimpl(name) {
  return () => {
    throw Error(name + " is not implemented for node:buffer browser polyfill");
  };
}
var lookup, revLookup, code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", i, len, customInspectSymbol, INSPECT_MAX_BYTES = 50, kMaxLength = 2147483647, kStringMaxLength = 536870888, btoa2, atob, File, Blob, constants, ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, MAX_ARGUMENTS_LENGTH = 4096, INVALID_BASE64_RE, hexSliceLookupTable, resolveObjectURL, isUtf8, isAscii = (str) => {
  for (let char of str)
    if (char.charCodeAt(0) > 127)
      return false;
  return true;
}, transcode, buffer_default;
var init_buffer = __esm(() => {
  lookup = [];
  revLookup = [];
  for (i = 0, len = code.length;i < len; ++i)
    lookup[i] = code[i], revLookup[code.charCodeAt(i)] = i;
  revLookup[45] = 62;
  revLookup[95] = 63;
  customInspectSymbol = typeof Symbol === "function" && typeof Symbol.for === "function" ? Symbol.for("nodejs.util.inspect.custom") : null;
  btoa2 = globalThis.btoa;
  atob = globalThis.atob;
  File = globalThis.File;
  Blob = globalThis.Blob;
  constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
  ERR_BUFFER_OUT_OF_BOUNDS = E("ERR_BUFFER_OUT_OF_BOUNDS", function(name) {
    if (name)
      return `${name} is outside of buffer bounds`;
    return "Attempt to access memory outside buffer bounds";
  }, RangeError);
  ERR_INVALID_ARG_TYPE = E("ERR_INVALID_ARG_TYPE", function(name, actual) {
    return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
  }, TypeError);
  ERR_OUT_OF_RANGE = E("ERR_OUT_OF_RANGE", function(str, range, input) {
    let msg = `The value of "${str}" is out of range.`, received = input;
    if (Number.isInteger(input) && Math.abs(input) > 4294967296)
      received = addNumericalSeparator(String(input));
    else if (typeof input === "bigint") {
      if (received = String(input), input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32)))
        received = addNumericalSeparator(received);
      received += "n";
    }
    return msg += ` It must be ${range}. Received ${received}`, msg;
  }, RangeError);
  Object.defineProperty(Buffer2.prototype, "parent", { enumerable: true, get: function() {
    if (!Buffer2.isBuffer(this))
      return;
    return this.buffer;
  } });
  Object.defineProperty(Buffer2.prototype, "offset", { enumerable: true, get: function() {
    if (!Buffer2.isBuffer(this))
      return;
    return this.byteOffset;
  } });
  Buffer2.poolSize = 8192;
  Buffer2.from = function(value, encodingOrOffset, length) {
    return from(value, encodingOrOffset, length);
  };
  Object.setPrototypeOf(Buffer2.prototype, Uint8Array.prototype);
  Object.setPrototypeOf(Buffer2, Uint8Array);
  Buffer2.alloc = function(size, fill, encoding) {
    return alloc(size, fill, encoding);
  };
  Buffer2.allocUnsafe = function(size) {
    return allocUnsafe(size);
  };
  Buffer2.allocUnsafeSlow = function(size) {
    return allocUnsafe(size);
  };
  Buffer2.isBuffer = function(b) {
    return b != null && b._isBuffer === true && b !== Buffer2.prototype;
  };
  Buffer2.compare = function(a, b) {
    if (isInstance(a, Uint8Array))
      a = Buffer2.from(a, a.offset, a.byteLength);
    if (isInstance(b, Uint8Array))
      b = Buffer2.from(b, b.offset, b.byteLength);
    if (!Buffer2.isBuffer(a) || !Buffer2.isBuffer(b))
      throw TypeError('The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array');
    if (a === b)
      return 0;
    let x = a.length, y = b.length;
    for (let i2 = 0, len2 = Math.min(x, y);i2 < len2; ++i2)
      if (a[i2] !== b[i2]) {
        x = a[i2], y = b[i2];
        break;
      }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer2.isEncoding = function(encoding) {
    switch (String(encoding).toLowerCase()) {
      case "hex":
      case "utf8":
      case "utf-8":
      case "ascii":
      case "latin1":
      case "binary":
      case "base64":
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return true;
      default:
        return false;
    }
  };
  Buffer2.concat = function(list, length) {
    if (!Array.isArray(list))
      throw TypeError('"list" argument must be an Array of Buffers');
    if (list.length === 0)
      return Buffer2.alloc(0);
    let i2;
    if (length === undefined) {
      length = 0;
      for (i2 = 0;i2 < list.length; ++i2)
        length += list[i2].length;
    }
    let buffer = Buffer2.allocUnsafe(length), pos = 0;
    for (i2 = 0;i2 < list.length; ++i2) {
      let buf = list[i2];
      if (isInstance(buf, Uint8Array))
        if (pos + buf.length > buffer.length) {
          if (!Buffer2.isBuffer(buf))
            buf = Buffer2.from(buf);
          buf.copy(buffer, pos);
        } else
          Uint8Array.prototype.set.call(buffer, buf, pos);
      else if (!Buffer2.isBuffer(buf))
        throw TypeError('"list" argument must be an Array of Buffers');
      else
        buf.copy(buffer, pos);
      pos += buf.length;
    }
    return buffer;
  };
  Buffer2.byteLength = byteLength;
  Buffer2.prototype._isBuffer = true;
  Buffer2.prototype.swap16 = function() {
    let len2 = this.length;
    if (len2 % 2 !== 0)
      throw RangeError("Buffer size must be a multiple of 16-bits");
    for (let i2 = 0;i2 < len2; i2 += 2)
      swap(this, i2, i2 + 1);
    return this;
  };
  Buffer2.prototype.swap32 = function() {
    let len2 = this.length;
    if (len2 % 4 !== 0)
      throw RangeError("Buffer size must be a multiple of 32-bits");
    for (let i2 = 0;i2 < len2; i2 += 4)
      swap(this, i2, i2 + 3), swap(this, i2 + 1, i2 + 2);
    return this;
  };
  Buffer2.prototype.swap64 = function() {
    let len2 = this.length;
    if (len2 % 8 !== 0)
      throw RangeError("Buffer size must be a multiple of 64-bits");
    for (let i2 = 0;i2 < len2; i2 += 8)
      swap(this, i2, i2 + 7), swap(this, i2 + 1, i2 + 6), swap(this, i2 + 2, i2 + 5), swap(this, i2 + 3, i2 + 4);
    return this;
  };
  Buffer2.prototype.toString = function() {
    let length = this.length;
    if (length === 0)
      return "";
    if (arguments.length === 0)
      return utf8Slice(this, 0, length);
    return slowToString.apply(this, arguments);
  };
  Buffer2.prototype.toLocaleString = Buffer2.prototype.toString;
  Buffer2.prototype.equals = function(b) {
    if (!Buffer2.isBuffer(b))
      throw TypeError("Argument must be a Buffer");
    if (this === b)
      return true;
    return Buffer2.compare(this, b) === 0;
  };
  Buffer2.prototype.inspect = function() {
    let str = "", max = INSPECT_MAX_BYTES;
    if (str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim(), this.length > max)
      str += " ... ";
    return "<Buffer " + str + ">";
  };
  if (customInspectSymbol)
    Buffer2.prototype[customInspectSymbol] = Buffer2.prototype.inspect;
  Buffer2.prototype.compare = function(target, start, end, thisStart, thisEnd) {
    if (isInstance(target, Uint8Array))
      target = Buffer2.from(target, target.offset, target.byteLength);
    if (!Buffer2.isBuffer(target))
      throw TypeError('The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target);
    if (start === undefined)
      start = 0;
    if (end === undefined)
      end = target ? target.length : 0;
    if (thisStart === undefined)
      thisStart = 0;
    if (thisEnd === undefined)
      thisEnd = this.length;
    if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length)
      throw RangeError("out of range index");
    if (thisStart >= thisEnd && start >= end)
      return 0;
    if (thisStart >= thisEnd)
      return -1;
    if (start >= end)
      return 1;
    if (start >>>= 0, end >>>= 0, thisStart >>>= 0, thisEnd >>>= 0, this === target)
      return 0;
    let x = thisEnd - thisStart, y = end - start, len2 = Math.min(x, y), thisCopy = this.slice(thisStart, thisEnd), targetCopy = target.slice(start, end);
    for (let i2 = 0;i2 < len2; ++i2)
      if (thisCopy[i2] !== targetCopy[i2]) {
        x = thisCopy[i2], y = targetCopy[i2];
        break;
      }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer2.prototype.includes = function(val, byteOffset, encoding) {
    return this.indexOf(val, byteOffset, encoding) !== -1;
  };
  Buffer2.prototype.indexOf = function(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
  };
  Buffer2.prototype.lastIndexOf = function(val, byteOffset, encoding) {
    return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
  };
  Buffer2.prototype.write = function(string, offset, length, encoding) {
    if (offset === undefined)
      encoding = "utf8", length = this.length, offset = 0;
    else if (length === undefined && typeof offset === "string")
      encoding = offset, length = this.length, offset = 0;
    else if (isFinite(offset))
      if (offset = offset >>> 0, isFinite(length)) {
        if (length = length >>> 0, encoding === undefined)
          encoding = "utf8";
      } else
        encoding = length, length = undefined;
    else
      throw Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");
    let remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length)
      throw RangeError("Attempt to write outside buffer bounds");
    if (!encoding)
      encoding = "utf8";
    let loweredCase = false;
    for (;; )
      switch (encoding) {
        case "hex":
          return hexWrite(this, string, offset, length);
        case "utf8":
        case "utf-8":
          return utf8Write(this, string, offset, length);
        case "ascii":
        case "latin1":
        case "binary":
          return asciiWrite(this, string, offset, length);
        case "base64":
          return base64Write(this, string, offset, length);
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw TypeError("Unknown encoding: " + encoding);
          encoding = ("" + encoding).toLowerCase(), loweredCase = true;
      }
  };
  Buffer2.prototype.toJSON = function() {
    return { type: "Buffer", data: Array.prototype.slice.call(this._arr || this, 0) };
  };
  Buffer2.prototype.slice = function(start, end) {
    let len2 = this.length;
    if (start = ~~start, end = end === undefined ? len2 : ~~end, start < 0) {
      if (start += len2, start < 0)
        start = 0;
    } else if (start > len2)
      start = len2;
    if (end < 0) {
      if (end += len2, end < 0)
        end = 0;
    } else if (end > len2)
      end = len2;
    if (end < start)
      end = start;
    let newBuf = this.subarray(start, end);
    return Object.setPrototypeOf(newBuf, Buffer2.prototype), newBuf;
  };
  Buffer2.prototype.readUintLE = Buffer2.prototype.readUIntLE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset], mul = 1, i2 = 0;
    while (++i2 < byteLength2 && (mul *= 256))
      val += this[offset + i2] * mul;
    return val;
  };
  Buffer2.prototype.readUintBE = Buffer2.prototype.readUIntBE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset + --byteLength2], mul = 1;
    while (byteLength2 > 0 && (mul *= 256))
      val += this[offset + --byteLength2] * mul;
    return val;
  };
  Buffer2.prototype.readUint8 = Buffer2.prototype.readUInt8 = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer2.prototype.readUint16LE = Buffer2.prototype.readUInt16LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | this[offset + 1] << 8;
  };
  Buffer2.prototype.readUint16BE = Buffer2.prototype.readUInt16BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] << 8 | this[offset + 1];
  };
  Buffer2.prototype.readUint32LE = Buffer2.prototype.readUInt32LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
  };
  Buffer2.prototype.readUint32BE = Buffer2.prototype.readUInt32BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
  };
  Buffer2.prototype.readBigUInt64LE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let lo = first + this[++offset] * 256 + this[++offset] * 65536 + this[++offset] * 16777216, hi = this[++offset] + this[++offset] * 256 + this[++offset] * 65536 + last * 16777216;
    return BigInt(lo) + (BigInt(hi) << BigInt(32));
  });
  Buffer2.prototype.readBigUInt64BE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let hi = first * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + this[++offset], lo = this[++offset] * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + last;
    return (BigInt(hi) << BigInt(32)) + BigInt(lo);
  });
  Buffer2.prototype.readIntLE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let val = this[offset], mul = 1, i2 = 0;
    while (++i2 < byteLength2 && (mul *= 256))
      val += this[offset + i2] * mul;
    if (mul *= 128, val >= mul)
      val -= Math.pow(2, 8 * byteLength2);
    return val;
  };
  Buffer2.prototype.readIntBE = function(offset, byteLength2, noAssert) {
    if (offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert)
      checkOffset(offset, byteLength2, this.length);
    let i2 = byteLength2, mul = 1, val = this[offset + --i2];
    while (i2 > 0 && (mul *= 256))
      val += this[offset + --i2] * mul;
    if (mul *= 128, val >= mul)
      val -= Math.pow(2, 8 * byteLength2);
    return val;
  };
  Buffer2.prototype.readInt8 = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 128))
      return this[offset];
    return (255 - this[offset] + 1) * -1;
  };
  Buffer2.prototype.readInt16LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    let val = this[offset] | this[offset + 1] << 8;
    return val & 32768 ? val | 4294901760 : val;
  };
  Buffer2.prototype.readInt16BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 2, this.length);
    let val = this[offset + 1] | this[offset] << 8;
    return val & 32768 ? val | 4294901760 : val;
  };
  Buffer2.prototype.readInt32LE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
  };
  Buffer2.prototype.readInt32BE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
  };
  Buffer2.prototype.readBigInt64LE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let val = this[offset + 4] + this[offset + 5] * 256 + this[offset + 6] * 65536 + (last << 24);
    return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 256 + this[++offset] * 65536 + this[++offset] * 16777216);
  });
  Buffer2.prototype.readBigInt64BE = defineBigIntMethod(function(offset) {
    offset = offset >>> 0, validateNumber(offset, "offset");
    let first = this[offset], last = this[offset + 7];
    if (first === undefined || last === undefined)
      boundsError(offset, this.length - 8);
    let val = (first << 24) + this[++offset] * 65536 + this[++offset] * 256 + this[++offset];
    return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 16777216 + this[++offset] * 65536 + this[++offset] * 256 + last);
  });
  Buffer2.prototype.readFloatLE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return read(this, offset, true, 23, 4);
  };
  Buffer2.prototype.readFloatBE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 4, this.length);
    return read(this, offset, false, 23, 4);
  };
  Buffer2.prototype.readDoubleLE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 8, this.length);
    return read(this, offset, true, 52, 8);
  };
  Buffer2.prototype.readDoubleBE = function(offset, noAssert) {
    if (offset = offset >>> 0, !noAssert)
      checkOffset(offset, 8, this.length);
    return read(this, offset, false, 52, 8);
  };
  Buffer2.prototype.writeUintLE = Buffer2.prototype.writeUIntLE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert) {
      let maxBytes = Math.pow(2, 8 * byteLength2) - 1;
      checkInt(this, value, offset, byteLength2, maxBytes, 0);
    }
    let mul = 1, i2 = 0;
    this[offset] = value & 255;
    while (++i2 < byteLength2 && (mul *= 256))
      this[offset + i2] = value / mul & 255;
    return offset + byteLength2;
  };
  Buffer2.prototype.writeUintBE = Buffer2.prototype.writeUIntBE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, byteLength2 = byteLength2 >>> 0, !noAssert) {
      let maxBytes = Math.pow(2, 8 * byteLength2) - 1;
      checkInt(this, value, offset, byteLength2, maxBytes, 0);
    }
    let i2 = byteLength2 - 1, mul = 1;
    this[offset + i2] = value & 255;
    while (--i2 >= 0 && (mul *= 256))
      this[offset + i2] = value / mul & 255;
    return offset + byteLength2;
  };
  Buffer2.prototype.writeUint8 = Buffer2.prototype.writeUInt8 = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 1, 255, 0);
    return this[offset] = value & 255, offset + 1;
  };
  Buffer2.prototype.writeUint16LE = Buffer2.prototype.writeUInt16LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 65535, 0);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, offset + 2;
  };
  Buffer2.prototype.writeUint16BE = Buffer2.prototype.writeUInt16BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 65535, 0);
    return this[offset] = value >>> 8, this[offset + 1] = value & 255, offset + 2;
  };
  Buffer2.prototype.writeUint32LE = Buffer2.prototype.writeUInt32LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 4294967295, 0);
    return this[offset + 3] = value >>> 24, this[offset + 2] = value >>> 16, this[offset + 1] = value >>> 8, this[offset] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeUint32BE = Buffer2.prototype.writeUInt32BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 4294967295, 0);
    return this[offset] = value >>> 24, this[offset + 1] = value >>> 16, this[offset + 2] = value >>> 8, this[offset + 3] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeBigUInt64LE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
  });
  Buffer2.prototype.writeBigUInt64BE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
  });
  Buffer2.prototype.writeIntLE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert) {
      let limit = Math.pow(2, 8 * byteLength2 - 1);
      checkInt(this, value, offset, byteLength2, limit - 1, -limit);
    }
    let i2 = 0, mul = 1, sub = 0;
    this[offset] = value & 255;
    while (++i2 < byteLength2 && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i2 - 1] !== 0)
        sub = 1;
      this[offset + i2] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength2;
  };
  Buffer2.prototype.writeIntBE = function(value, offset, byteLength2, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert) {
      let limit = Math.pow(2, 8 * byteLength2 - 1);
      checkInt(this, value, offset, byteLength2, limit - 1, -limit);
    }
    let i2 = byteLength2 - 1, mul = 1, sub = 0;
    this[offset + i2] = value & 255;
    while (--i2 >= 0 && (mul *= 256)) {
      if (value < 0 && sub === 0 && this[offset + i2 + 1] !== 0)
        sub = 1;
      this[offset + i2] = (value / mul >> 0) - sub & 255;
    }
    return offset + byteLength2;
  };
  Buffer2.prototype.writeInt8 = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 1, 127, -128);
    if (value < 0)
      value = 255 + value + 1;
    return this[offset] = value & 255, offset + 1;
  };
  Buffer2.prototype.writeInt16LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 32767, -32768);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, offset + 2;
  };
  Buffer2.prototype.writeInt16BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 2, 32767, -32768);
    return this[offset] = value >>> 8, this[offset + 1] = value & 255, offset + 2;
  };
  Buffer2.prototype.writeInt32LE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 2147483647, -2147483648);
    return this[offset] = value & 255, this[offset + 1] = value >>> 8, this[offset + 2] = value >>> 16, this[offset + 3] = value >>> 24, offset + 4;
  };
  Buffer2.prototype.writeInt32BE = function(value, offset, noAssert) {
    if (value = +value, offset = offset >>> 0, !noAssert)
      checkInt(this, value, offset, 4, 2147483647, -2147483648);
    if (value < 0)
      value = 4294967295 + value + 1;
    return this[offset] = value >>> 24, this[offset + 1] = value >>> 16, this[offset + 2] = value >>> 8, this[offset + 3] = value & 255, offset + 4;
  };
  Buffer2.prototype.writeBigInt64LE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
  });
  Buffer2.prototype.writeBigInt64BE = defineBigIntMethod(function(value, offset = 0) {
    return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
  });
  Buffer2.prototype.writeFloatLE = function(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer2.prototype.writeFloatBE = function(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  Buffer2.prototype.writeDoubleLE = function(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer2.prototype.writeDoubleBE = function(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer2.prototype.copy = function(target, targetStart, start, end) {
    if (!Buffer2.isBuffer(target))
      throw TypeError("argument should be a Buffer");
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0)
      throw RangeError("targetStart out of bounds");
    if (start < 0 || start >= this.length)
      throw RangeError("Index out of range");
    if (end < 0)
      throw RangeError("sourceEnd out of bounds");
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start)
      end = target.length - targetStart + start;
    let len2 = end - start;
    if (this === target && typeof Uint8Array.prototype.copyWithin === "function")
      this.copyWithin(targetStart, start, end);
    else
      Uint8Array.prototype.set.call(target, this.subarray(start, end), targetStart);
    return len2;
  };
  Buffer2.prototype.fill = function(val, start, end, encoding) {
    if (typeof val === "string") {
      if (typeof start === "string")
        encoding = start, start = 0, end = this.length;
      else if (typeof end === "string")
        encoding = end, end = this.length;
      if (encoding !== undefined && typeof encoding !== "string")
        throw TypeError("encoding must be a string");
      if (typeof encoding === "string" && !Buffer2.isEncoding(encoding))
        throw TypeError("Unknown encoding: " + encoding);
      if (val.length === 1) {
        let code2 = val.charCodeAt(0);
        if (encoding === "utf8" && code2 < 128 || encoding === "latin1")
          val = code2;
      }
    } else if (typeof val === "number")
      val = val & 255;
    else if (typeof val === "boolean")
      val = Number(val);
    if (start < 0 || this.length < start || this.length < end)
      throw RangeError("Out of range index");
    if (end <= start)
      return this;
    if (start = start >>> 0, end = end === undefined ? this.length : end >>> 0, !val)
      val = 0;
    let i2;
    if (typeof val === "number")
      for (i2 = start;i2 < end; ++i2)
        this[i2] = val;
    else {
      let bytes = Buffer2.isBuffer(val) ? val : Buffer2.from(val, encoding), len2 = bytes.length;
      if (len2 === 0)
        throw TypeError('The value "' + val + '" is invalid for argument "value"');
      for (i2 = 0;i2 < end - start; ++i2)
        this[i2 + start] = bytes[i2 % len2];
    }
    return this;
  };
  INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
  hexSliceLookupTable = function() {
    let table = Array(256);
    for (let i2 = 0;i2 < 16; ++i2) {
      let i16 = i2 * 16;
      for (let j = 0;j < 16; ++j)
        table[i16 + j] = "0123456789abcdef"[i2] + "0123456789abcdef"[j];
    }
    return table;
  }();
  resolveObjectURL = notimpl("resolveObjectURL");
  isUtf8 = notimpl("isUtf8");
  transcode = notimpl("transcode");
  buffer_default = Buffer2;
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/crypto.js
var crypto2;
var init_crypto = __esm(() => {
  crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : undefined;
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0;i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes2(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes2(data);
  abytes(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}

class Hash {
}
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}
var isLE, swap32IfBE, hasHexBuiltin, hexes, asciis;
var init_utils = __esm(() => {
  init_crypto();
  /*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
  swap32IfBE = isLE ? (u) => u : byteSwap32;
  hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
  hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD, SHA256_IV, SHA512_IV;
var init__md = __esm(() => {
  init_utils();
  HashMD = class HashMD extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
      super();
      this.finished = false;
      this.length = 0;
      this.pos = 0;
      this.destroyed = false;
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      aexists(this);
      data = toBytes(data);
      abytes(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0;pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (;blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos;i < blockLen; i++)
        buffer[i] = 0;
      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen should be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0;i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to || (to = new this.constructor);
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0;i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var U32_MASK64, _32n, shrSH = (h, _l, s) => h >>> s, shrSL = (h, l, s) => h << 32 - s | l >>> s, rotrSH = (h, l, s) => h >>> s | l << 32 - s, rotrSL = (h, l, s) => h << 32 - s | l >>> s, rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32, rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s, rotlSH = (h, l, s) => h << s | l >>> 32 - s, rotlSL = (h, l, s) => l << s | h >>> 32 - s, rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s, rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s, add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0), add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0, add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0), add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0, add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0), add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
var init__u64 = __esm(() => {
  U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  _32n = /* @__PURE__ */ BigInt(32);
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K, SHA256_W, SHA256, K512, SHA512_Kh, SHA512_Kl, SHA512_W_H, SHA512_W_L, SHA512, sha256, sha512;
var init_sha2 = __esm(() => {
  init__md();
  init__u64();
  init_utils();
  SHA256_K = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  SHA256 = class SHA256 extends HashMD {
    constructor(outputLen = 32) {
      super(64, outputLen, 8, false);
      this.A = SHA256_IV[0] | 0;
      this.B = SHA256_IV[1] | 0;
      this.C = SHA256_IV[2] | 0;
      this.D = SHA256_IV[3] | 0;
      this.E = SHA256_IV[4] | 0;
      this.F = SHA256_IV[5] | 0;
      this.G = SHA256_IV[6] | 0;
      this.H = SHA256_IV[7] | 0;
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0;i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16;i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0;i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T2 = sigma0 + Maj(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T1 | 0;
        D = C;
        C = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      clean(SHA256_W);
    }
    destroy() {
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      clean(this.buffer);
    }
  };
  K512 = /* @__PURE__ */ (() => split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n) => BigInt(n))))();
  SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
  SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
  SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  SHA512 = class SHA512 extends HashMD {
    constructor(outputLen = 64) {
      super(128, outputLen, 16, false);
      this.Ah = SHA512_IV[0] | 0;
      this.Al = SHA512_IV[1] | 0;
      this.Bh = SHA512_IV[2] | 0;
      this.Bl = SHA512_IV[3] | 0;
      this.Ch = SHA512_IV[4] | 0;
      this.Cl = SHA512_IV[5] | 0;
      this.Dh = SHA512_IV[6] | 0;
      this.Dl = SHA512_IV[7] | 0;
      this.Eh = SHA512_IV[8] | 0;
      this.El = SHA512_IV[9] | 0;
      this.Fh = SHA512_IV[10] | 0;
      this.Fl = SHA512_IV[11] | 0;
      this.Gh = SHA512_IV[12] | 0;
      this.Gl = SHA512_IV[13] | 0;
      this.Hh = SHA512_IV[14] | 0;
      this.Hl = SHA512_IV[15] | 0;
    }
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0;i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16;i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
        const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
        const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
        const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0;i < 80; i++) {
        const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
        const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
        const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = add3L(T1l, sigma0l, MAJl);
        Ah = add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      clean(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  sha256 = /* @__PURE__ */ createHasher(() => new SHA256);
  sha512 = /* @__PURE__ */ createHasher(() => new SHA512);
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/utils.js
function _abool2(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}"`;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function _abytes2(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function numberToHexUnpadded(num) {
  const hex = num.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0;n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const u8of = (byte) => Uint8Array.of(byte);
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n(0)) => {
    k = h(u8of(0), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8of(1), seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= 1000)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = undefined;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function _validateObject(object, fields, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
  Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}
function memoized(fn) {
  const map = new WeakMap;
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== undefined)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}
var _0n, _1n, isPosBig = (n) => typeof n === "bigint" && _0n <= n, bitMask = (n) => (_1n << BigInt(n)) - _1n, notImplemented = () => {
  throw new Error("not implemented");
};
var init_utils2 = __esm(() => {
  init_utils();
  init_utils();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  _0n = /* @__PURE__ */ BigInt(0);
  _1n = /* @__PURE__ */ BigInt(1);
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/modular.js
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root = Fp.pow(n, p1div4);
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i = Fp.mul(Fp.mul(nv, _2n), v);
  const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4);
    let tv2 = Fp.mul(tv1, c1);
    const tv3 = Fp.mul(tv1, c2);
    const tv4 = Fp.mul(tv1, c3);
    const e1 = Fp.eql(Fp.sqr(tv2), n);
    const e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1);
    tv2 = Fp.cmov(tv4, tv3, e2);
    const e3 = Fp.eql(Fp.sqr(tv2), n);
    const root = Fp.cmov(tv1, tv2, e3);
    assertIsSquare(Fp, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i++;
        t_tmp = Fp.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp.pow(c, exponent);
      M = i;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  _validateObject(field, opts);
  return field;
}
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== undefined ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLenOrOpts, isLE = false, opts = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  let _nbitLength = undefined;
  let _sqrt = undefined;
  let modFromBytes = false;
  let allowedLengths = undefined;
  if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
    if (opts.sqrt || isLE)
      throw new Error("cannot specify opts in two arguments");
    const _opts = bitLenOrOpts;
    if (_opts.BITS)
      _nbitLength = _opts.BITS;
    if (_opts.sqrt)
      _sqrt = _opts.sqrt;
    if (typeof _opts.isLE === "boolean")
      isLE = _opts.isLE;
    if (typeof _opts.modFromBytes === "boolean")
      modFromBytes = _opts.modFromBytes;
    allowedLengths = _opts.allowedLengths;
  } else {
    if (typeof bitLenOrOpts === "number")
      _nbitLength = bitLenOrOpts;
    if (opts.sqrt)
      _sqrt = opts.sqrt;
  }
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    allowedLengths,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    isValidNot0: (num) => !f.is0(num) && f.isValid(num),
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: _sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes, skipValidation = true) => {
      if (allowedLengths) {
        if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!f.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    },
    invertBatch: (lst) => FpInvertBatch(f, lst),
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
var _0n2, _1n2, _2n, _3n, _4n, _5n, _7n, _8n, _9n, _16n, isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2, FIELD_FIELDS;
var init_modular = __esm(() => {
  init_utils2();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  _0n2 = BigInt(0);
  _1n2 = BigInt(1);
  _2n = /* @__PURE__ */ BigInt(2);
  _3n = /* @__PURE__ */ BigInt(3);
  _4n = /* @__PURE__ */ BigInt(4);
  _5n = /* @__PURE__ */ BigInt(5);
  _7n = /* @__PURE__ */ BigInt(7);
  _8n = /* @__PURE__ */ BigInt(8);
  _9n = /* @__PURE__ */ BigInt(9);
  _16n = /* @__PURE__ */ BigInt(16);
  FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/curve.js
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window2, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window2 * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window2 % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}

class wNAF {
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base = p;
    for (let window2 = 0;window2 < windows; window2++) {
      base = p;
      points.push(base);
      for (let i = 1;i < windowSize; i++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window2 = 0;window2 < wo.windows; window2++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window2 = 0;window2 < wo.windows; window2++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
}
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point;
  let p1 = Point.ZERO;
  let p2 = Point.ZERO;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3)
      p1 = p1.add(acc);
    if (k2 & _1n3)
      p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n3;
    k2 >>= _1n3;
  }
  return { p1, p2 };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits;i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0;j < slength; j++) {
      const scalar = scalars[j];
      const wbits = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits] = buckets[wbits].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero;j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0;j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
var _0n3, _1n3, pointPrecomputes, pointWindowSizes;
var init_curve = __esm(() => {
  init_utils2();
  init_modular();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  _0n3 = BigInt(0);
  _1n3 = BigInt(1);
  pointPrecomputes = new WeakMap;
  pointWindowSizes = new WeakMap;
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/edwards.js
function isEdValidXY(Fp, CURVE, x, y) {
  const x2 = Fp.sqr(x);
  const y2 = Fp.sqr(y);
  const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
  const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  const validated = _createCurveFields("edwards", params, extraOpts, extraOpts.FpFnLE);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  _validateObject(extraOpts, {}, { uvRatio: "function" });
  const MASK = _2n2 << BigInt(Fn.BYTES * 8) - _1n4;
  const modP = (n) => Fp.create(n);
  const uvRatio = extraOpts.uvRatio || ((u, v) => {
    try {
      return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  });
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aextpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ExtendedPoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? _8n2 : Fp.inv(Z);
    const x = modP(X * iz);
    const y = modP(Y * iz);
    const zz = Fp.mul(Z, iz);
    if (is0)
      return { x: _0n4, y: _1n4 };
    if (zz !== _1n4)
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    const { a, d } = CURVE;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * modP(aX2 + Y2));
    const right = modP(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return true;
  });

  class Point {
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, _1n4, modP(x * y));
    }
    static fromBytes(bytes, zip215 = false) {
      const len = Fp.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(_abytes2(bytes, len, "point"));
      _abool2(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = modP(y * y);
      const u = modP(y2 - _1n4);
      const v = modP(d * y2 - a);
      let { isValid, value: x } = uvRatio(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = (x & _1n4) === _1n4;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n4 && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP(-x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(bytes, zip215 = false) {
      return Point.fromBytes(ensureBytes("point", bytes), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    assertValidity() {
      assertValidMemo(this);
    }
    equals(other) {
      aextpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
    }
    double() {
      const { a } = CURVE;
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C = modP(_2n2 * modP(Z1 * Z1));
      const D = modP(a * A);
      const x1y1 = X1 + Y1;
      const E = modP(modP(x1y1 * x1y1) - A - B);
      const G = D + B;
      const F = G - C;
      const H = D - B;
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    add(other) {
      aextpoint(other);
      const { a, d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C = modP(T1 * d * T2);
      const D = modP(Z1 * Z2);
      const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
      const F = D - C;
      const G = D + C;
      const H = modP(B - a * A);
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.cached(this, scalar, (p) => normalizeZ(Point, p));
      return normalizeZ(Point, [p, f])[0];
    }
    multiplyUnsafe(scalar, acc = Point.ZERO) {
      if (!Fn.isValid(scalar))
        throw new Error("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point, p), acc);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    isTorsionFree() {
      return wnaf.unsafe(this, CURVE.n).is0();
    }
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp.toBytes(y);
      bytes[bytes.length - 1] |= x & _1n4 ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
    get ex() {
      return this.X;
    }
    get ey() {
      return this.Y;
    }
    get ez() {
      return this.Z;
    }
    get et() {
      return this.T;
    }
    static normalizeZ(points) {
      return normalizeZ(Point, points);
    }
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    toRawBytes() {
      return this.toBytes();
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
  Point.ZERO = new Point(_0n4, _1n4, _1n4, _0n4);
  Point.Fp = Fp;
  Point.Fn = Fn;
  const wnaf = new wNAF(Point, Fn.BITS);
  Point.BASE.precompute(8);
  return Point;
}

class PrimeEdwardsPoint {
  constructor(ep) {
    this.ep = ep;
  }
  static fromBytes(_bytes) {
    notImplemented();
  }
  static fromHex(_hex) {
    notImplemented();
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  clearCofactor() {
    return this;
  }
  assertValidity() {
    this.ep.assertValidity();
  }
  toAffine(invertedZ) {
    return this.ep.toAffine(invertedZ);
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  toString() {
    return this.toHex();
  }
  isTorsionFree() {
    return true;
  }
  isSmallOrder() {
    return false;
  }
  add(other) {
    this.assertSame(other);
    return this.init(this.ep.add(other.ep));
  }
  subtract(other) {
    this.assertSame(other);
    return this.init(this.ep.subtract(other.ep));
  }
  multiply(scalar) {
    return this.init(this.ep.multiply(scalar));
  }
  multiplyUnsafe(scalar) {
    return this.init(this.ep.multiplyUnsafe(scalar));
  }
  double() {
    return this.init(this.ep.double());
  }
  negate() {
    return this.init(this.ep.negate());
  }
  precompute(windowSize, isLazy) {
    return this.init(this.ep.precompute(windowSize, isLazy));
  }
  toRawBytes() {
    return this.toBytes();
  }
}
function eddsa(Point, cHash, eddsaOpts = {}) {
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  _validateObject(eddsaOpts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    mapToCurve: "function"
  });
  const { prehash } = eddsaOpts;
  const { BASE, Fp, Fn } = Point;
  const randomBytes2 = eddsaOpts.randomBytes || randomBytes;
  const adjustScalarBytes = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
  const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
    _abool2(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  });
  function modN_LE(hash) {
    return Fn.create(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    key = ensureBytes("private key", key, len);
    const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
    const head = adjustScalarBytes(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(secretKey) {
    return getExtendedPublicKey(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes(...msgs);
    return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    msg = ensureBytes("message", msg);
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn.create(r + k * scalar);
    if (!Fn.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes(R, Fn.toBytes(s));
    return _abytes2(rs, lengths.signature, "result");
  }
  const verifyOpts = { zip215: true };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    const { context, zip215 } = options;
    const len = lengths.signature;
    sig = ensureBytes("signature", sig, len);
    msg = ensureBytes("message", msg);
    publicKey = ensureBytes("publicKey", publicKey, lengths.publicKey);
    if (zip215 !== undefined)
      _abool2(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point.fromBytes(publicKey, zip215);
      R = Point.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed = randomBytes2(lengths.seed)) {
    return _abytes2(seed, lengths.seed, "seed");
  }
  function keygen(seed) {
    const secretKey = utils.randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  }
  function isValidSecretKey(key) {
    return isBytes(key) && key.length === Fn.BYTES;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point.fromBytes(key, zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    toMontgomery(publicKey) {
      const { y } = Point.fromBytes(publicKey);
      const size = lengths.publicKey;
      const is25519 = size === 32;
      if (!is25519 && size !== 57)
        throw new Error("only defined for 25519 and 448");
      const u = is25519 ? Fp.div(_1n4 + y, _1n4 - y) : Fp.div(y - _1n4, y + _1n4);
      return Fp.toBytes(u);
    },
    toMontgomerySecret(secretKey) {
      const size = lengths.secretKey;
      _abytes2(secretKey, size);
      const hashed = cHash(secretKey.subarray(0, size));
      return adjustScalarBytes(hashed).subarray(0, size);
    },
    randomPrivateKey: randomSecretKey,
    precompute(windowSize = 8, point = Point.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return Object.freeze({
    keygen,
    getPublicKey,
    sign,
    verify,
    utils,
    Point,
    lengths
  });
}
function _eddsa_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    d: c.d,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp = c.Fp;
  const Fn = Field(CURVE.n, c.nBitLength, true);
  const curveOpts = { Fp, Fn, uvRatio: c.uvRatio };
  const eddsaOpts = {
    randomBytes: c.randomBytes,
    adjustScalarBytes: c.adjustScalarBytes,
    domain: c.domain,
    prehash: c.prehash,
    mapToCurve: c.mapToCurve
  };
  return { CURVE, curveOpts, hash: c.hash, eddsaOpts };
}
function _eddsa_new_output_to_legacy(c, eddsa) {
  const Point = eddsa.Point;
  const legacy = Object.assign({}, eddsa, {
    ExtendedPoint: Point,
    CURVE: c,
    nBitLength: Point.Fn.BITS,
    nByteLength: Point.Fn.BYTES
  });
  return legacy;
}
function twistedEdwards(c) {
  const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
  const Point = edwards(CURVE, curveOpts);
  const EDDSA = eddsa(Point, hash, eddsaOpts);
  return _eddsa_new_output_to_legacy(c, EDDSA);
}
var _0n4, _1n4, _2n2, _8n2;
var init_edwards = __esm(() => {
  init_utils2();
  init_curve();
  init_modular();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  _0n4 = BigInt(0);
  _1n4 = BigInt(1);
  _2n2 = BigInt(2);
  _8n2 = BigInt(8);
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/ed25519.js
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n3, P) * b2 % P;
  const b5 = pow2(b4, _1n5, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
function calcElligatorRistrettoMap(r0) {
  const { d } = ed25519_CURVE;
  const P = ed25519_CURVE_p;
  const mod = (n) => Fp.create(n);
  const r = mod(SQRT_M1 * r0 * r0);
  const Ns = mod((r + _1n5) * ONE_MINUS_D_SQ);
  let c = BigInt(-1);
  const D = mod((c - d * r) * mod(r + d));
  let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
  let s_ = mod(s * r0);
  if (!isNegativeLE(s_, P))
    s_ = mod(-s_);
  if (!Ns_D_is_sq)
    s = s_;
  if (!Ns_D_is_sq)
    c = r;
  const Nt = mod(c * (r - _1n5) * D_MINUS_ONE_SQ - D);
  const s2 = s * s;
  const W0 = mod((s + s) * D);
  const W1 = mod(Nt * SQRT_AD_MINUS_ONE);
  const W2 = mod(_1n5 - s2);
  const W3 = mod(_1n5 + s2);
  return new ed25519.Point(mod(W0 * W3), mod(W2 * W1), mod(W1 * W3), mod(W0 * W2));
}
function ristretto255_map(bytes) {
  abytes(bytes, 64);
  const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
  const R1 = calcElligatorRistrettoMap(r1);
  const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
  const R2 = calcElligatorRistrettoMap(r2);
  return new _RistrettoPoint(R1.add(R2));
}
var _0n5, _1n5, _2n3, _3n2, _5n2, _8n3, ed25519_CURVE_p, ed25519_CURVE, ED25519_SQRT_M1, Fp, Fn, ed25519Defaults, ed25519, SQRT_M1, SQRT_AD_MINUS_ONE, INVSQRT_A_MINUS_D, ONE_MINUS_D_SQ, D_MINUS_ONE_SQ, invertSqrt = (number) => uvRatio(_1n5, number), MAX_255B, bytes255ToNumberLE = (bytes) => ed25519.Point.Fp.create(bytesToNumberLE(bytes) & MAX_255B), _RistrettoPoint;
var init_ed25519 = __esm(() => {
  init_sha2();
  init_utils();
  init_curve();
  init_edwards();
  init_modular();
  init_utils2();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  _0n5 = /* @__PURE__ */ BigInt(0);
  _1n5 = BigInt(1);
  _2n3 = BigInt(2);
  _3n2 = BigInt(3);
  _5n2 = BigInt(5);
  _8n3 = BigInt(8);
  ed25519_CURVE_p = BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
  ed25519_CURVE = /* @__PURE__ */ (() => ({
    p: ed25519_CURVE_p,
    n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
    h: _8n3,
    a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
    d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
    Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
    Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
  }))();
  ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
  Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, { isLE: true }))();
  Fn = /* @__PURE__ */ (() => Field(ed25519_CURVE.n, { isLE: true }))();
  ed25519Defaults = /* @__PURE__ */ (() => ({
    ...ed25519_CURVE,
    Fp,
    hash: sha512,
    adjustScalarBytes,
    uvRatio
  }))();
  ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();
  SQRT_M1 = ED25519_SQRT_M1;
  SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
  INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
  ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
  D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
  MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  _RistrettoPoint = class _RistrettoPoint extends PrimeEdwardsPoint {
    constructor(ep) {
      super(ep);
    }
    static fromAffine(ap) {
      return new _RistrettoPoint(ed25519.Point.fromAffine(ap));
    }
    assertSame(other) {
      if (!(other instanceof _RistrettoPoint))
        throw new Error("RistrettoPoint expected");
    }
    init(ep) {
      return new _RistrettoPoint(ep);
    }
    static hashToCurve(hex) {
      return ristretto255_map(ensureBytes("ristrettoHash", hex, 64));
    }
    static fromBytes(bytes) {
      abytes(bytes, 32);
      const { a, d } = ed25519_CURVE;
      const P = ed25519_CURVE_p;
      const mod = (n) => Fp.create(n);
      const s = bytes255ToNumberLE(bytes);
      if (!equalBytes(Fp.toBytes(s), bytes) || isNegativeLE(s, P))
        throw new Error("invalid ristretto255 encoding 1");
      const s2 = mod(s * s);
      const u1 = mod(_1n5 + a * s2);
      const u2 = mod(_1n5 - a * s2);
      const u1_2 = mod(u1 * u1);
      const u2_2 = mod(u2 * u2);
      const v = mod(a * d * u1_2 - u2_2);
      const { isValid, value: I } = invertSqrt(mod(v * u2_2));
      const Dx = mod(I * u2);
      const Dy = mod(I * Dx * v);
      let x = mod((s + s) * Dx);
      if (isNegativeLE(x, P))
        x = mod(-x);
      const y = mod(u1 * Dy);
      const t = mod(x * y);
      if (!isValid || isNegativeLE(t, P) || y === _0n5)
        throw new Error("invalid ristretto255 encoding 2");
      return new _RistrettoPoint(new ed25519.Point(x, y, _1n5, t));
    }
    static fromHex(hex) {
      return _RistrettoPoint.fromBytes(ensureBytes("ristrettoHex", hex, 32));
    }
    static msm(points, scalars) {
      return pippenger(_RistrettoPoint, ed25519.Point.Fn, points, scalars);
    }
    toBytes() {
      let { X, Y, Z, T } = this.ep;
      const P = ed25519_CURVE_p;
      const mod = (n) => Fp.create(n);
      const u1 = mod(mod(Z + Y) * mod(Z - Y));
      const u2 = mod(X * Y);
      const u2sq = mod(u2 * u2);
      const { value: invsqrt } = invertSqrt(mod(u1 * u2sq));
      const D1 = mod(invsqrt * u1);
      const D2 = mod(invsqrt * u2);
      const zInv = mod(D1 * D2 * T);
      let D;
      if (isNegativeLE(T * zInv, P)) {
        let _x = mod(Y * SQRT_M1);
        let _y = mod(X * SQRT_M1);
        X = _x;
        Y = _y;
        D = mod(D1 * INVSQRT_A_MINUS_D);
      } else {
        D = D2;
      }
      if (isNegativeLE(X * zInv, P))
        Y = mod(-Y);
      let s = mod((Z - Y) * D);
      if (isNegativeLE(s, P))
        s = mod(-s);
      return Fp.toBytes(s);
    }
    equals(other) {
      this.assertSame(other);
      const { X: X1, Y: Y1 } = this.ep;
      const { X: X2, Y: Y2 } = other.ep;
      const mod = (n) => Fp.create(n);
      const one = mod(X1 * Y2) === mod(Y1 * X2);
      const two = mod(Y1 * Y2) === mod(X1 * X2);
      return one || two;
    }
    is0() {
      return this.equals(_RistrettoPoint.ZERO);
    }
  };
  _RistrettoPoint.BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.BASE))();
  _RistrettoPoint.ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.ZERO))();
  _RistrettoPoint.Fp = /* @__PURE__ */ (() => Fp)();
  _RistrettoPoint.Fn = /* @__PURE__ */ (() => Fn)();
});

// ../../node_modules/.bun/bn.js@5.2.5/node_modules/bn.js/lib/bn.js
var require_bn = __commonJS(function(exports, module) {
  (function(module2, exports2) {
    function assert(val, msg) {
      if (!val)
        throw new Error(msg || "Assertion failed");
    }
    function inherits(ctor, superCtor) {
      ctor.super_ = superCtor;
      var TempCtor = function() {};
      TempCtor.prototype = superCtor.prototype;
      ctor.prototype = new TempCtor;
      ctor.prototype.constructor = ctor;
    }
    function BN(number, base, endian) {
      if (BN.isBN(number)) {
        return number;
      }
      this.negative = 0;
      this.words = null;
      this.length = 0;
      this.red = null;
      if (number !== null) {
        if (base === "le" || base === "be") {
          endian = base;
          base = 10;
        }
        this._init(number || 0, base || 10, endian || "be");
      }
    }
    if (typeof module2 === "object") {
      module2.exports = BN;
    } else {
      exports2.BN = BN;
    }
    BN.BN = BN;
    BN.wordSize = 26;
    var Buffer2;
    try {
      if (typeof window !== "undefined" && typeof window.Buffer !== "undefined") {
        Buffer2 = window.Buffer;
      } else {
        Buffer2 = (() => ({})).Buffer;
      }
    } catch (e) {}
    BN.isBN = function isBN(num) {
      if (num instanceof BN) {
        return true;
      }
      return num !== null && typeof num === "object" && num.constructor.wordSize === BN.wordSize && Array.isArray(num.words);
    };
    BN.max = function max(left, right) {
      if (left.cmp(right) > 0)
        return left;
      return right;
    };
    BN.min = function min(left, right) {
      if (left.cmp(right) < 0)
        return left;
      return right;
    };
    BN.prototype._init = function init(number, base, endian) {
      if (typeof number === "number") {
        return this._initNumber(number, base, endian);
      }
      if (typeof number === "object") {
        return this._initArray(number, base, endian);
      }
      if (base === "hex") {
        base = 16;
      }
      assert(base === (base | 0) && base >= 2 && base <= 36);
      number = number.toString().replace(/\s+/g, "");
      var start = 0;
      if (number[0] === "-") {
        start++;
        this.negative = 1;
      }
      if (start < number.length) {
        if (base === 16) {
          this._parseHex(number, start, endian);
        } else {
          this._parseBase(number, base, start);
          if (endian === "le") {
            this._initArray(this.toArray(), base, endian);
          }
        }
      }
    };
    BN.prototype._initNumber = function _initNumber(number, base, endian) {
      if (number < 0) {
        this.negative = 1;
        number = -number;
      }
      if (number < 67108864) {
        this.words = [number & 67108863];
        this.length = 1;
      } else if (number < 4503599627370496) {
        this.words = [
          number & 67108863,
          number / 67108864 & 67108863
        ];
        this.length = 2;
      } else {
        assert(number < 9007199254740992);
        this.words = [
          number & 67108863,
          number / 67108864 & 67108863,
          1
        ];
        this.length = 3;
      }
      if (endian !== "le")
        return;
      this._initArray(this.toArray(), base, endian);
    };
    BN.prototype._initArray = function _initArray(number, base, endian) {
      assert(typeof number.length === "number");
      if (number.length <= 0) {
        this.words = [0];
        this.length = 1;
        return this;
      }
      this.length = Math.ceil(number.length / 3);
      this.words = new Array(this.length);
      for (var i = 0;i < this.length; i++) {
        this.words[i] = 0;
      }
      var j, w;
      var off = 0;
      if (endian === "be") {
        for (i = number.length - 1, j = 0;i >= 0; i -= 3) {
          w = number[i] | number[i - 1] << 8 | number[i - 2] << 16;
          this.words[j] |= w << off & 67108863;
          this.words[j + 1] = w >>> 26 - off & 67108863;
          off += 24;
          if (off >= 26) {
            off -= 26;
            j++;
          }
        }
      } else if (endian === "le") {
        for (i = 0, j = 0;i < number.length; i += 3) {
          w = number[i] | number[i + 1] << 8 | number[i + 2] << 16;
          this.words[j] |= w << off & 67108863;
          this.words[j + 1] = w >>> 26 - off & 67108863;
          off += 24;
          if (off >= 26) {
            off -= 26;
            j++;
          }
        }
      }
      return this._strip();
    };
    function parseHex4Bits(string, index) {
      var c = string.charCodeAt(index);
      if (c >= 48 && c <= 57) {
        return c - 48;
      } else if (c >= 65 && c <= 70) {
        return c - 55;
      } else if (c >= 97 && c <= 102) {
        return c - 87;
      } else {
        assert(false, "Invalid character in " + string);
      }
    }
    function parseHexByte(string, lowerBound, index) {
      var r = parseHex4Bits(string, index);
      if (index - 1 >= lowerBound) {
        r |= parseHex4Bits(string, index - 1) << 4;
      }
      return r;
    }
    BN.prototype._parseHex = function _parseHex(number, start, endian) {
      this.length = Math.ceil((number.length - start) / 6);
      this.words = new Array(this.length);
      for (var i = 0;i < this.length; i++) {
        this.words[i] = 0;
      }
      var off = 0;
      var j = 0;
      var w;
      if (endian === "be") {
        for (i = number.length - 1;i >= start; i -= 2) {
          w = parseHexByte(number, start, i) << off;
          this.words[j] |= w & 67108863;
          if (off >= 18) {
            off -= 18;
            j += 1;
            this.words[j] |= w >>> 26;
          } else {
            off += 8;
          }
        }
      } else {
        var parseLength = number.length - start;
        for (i = parseLength % 2 === 0 ? start + 1 : start;i < number.length; i += 2) {
          w = parseHexByte(number, start, i) << off;
          this.words[j] |= w & 67108863;
          if (off >= 18) {
            off -= 18;
            j += 1;
            this.words[j] |= w >>> 26;
          } else {
            off += 8;
          }
        }
      }
      this._strip();
    };
    function parseBase(str, start, end, mul) {
      var r = 0;
      var b = 0;
      var len = Math.min(str.length, end);
      for (var i = start;i < len; i++) {
        var c = str.charCodeAt(i) - 48;
        r *= mul;
        if (c >= 49) {
          b = c - 49 + 10;
        } else if (c >= 17) {
          b = c - 17 + 10;
        } else {
          b = c;
        }
        assert(c >= 0 && b < mul, "Invalid character");
        r += b;
      }
      return r;
    }
    BN.prototype._parseBase = function _parseBase(number, base, start) {
      this.words = [0];
      this.length = 1;
      for (var limbLen = 0, limbPow = 1;limbPow <= 67108863; limbPow *= base) {
        limbLen++;
      }
      limbLen--;
      limbPow = limbPow / base | 0;
      var total = number.length - start;
      var mod = total % limbLen;
      var end = Math.min(total, total - mod) + start;
      var word = 0;
      for (var i = start;i < end; i += limbLen) {
        word = parseBase(number, i, i + limbLen, base);
        this.imuln(limbPow);
        if (this.words[0] + word < 67108864) {
          this.words[0] += word;
        } else {
          this._iaddn(word);
        }
      }
      if (mod !== 0) {
        var pow = 1;
        word = parseBase(number, i, number.length, base);
        for (i = 0;i < mod; i++) {
          pow *= base;
        }
        this.imuln(pow);
        if (this.words[0] + word < 67108864) {
          this.words[0] += word;
        } else {
          this._iaddn(word);
        }
      }
      this._strip();
    };
    BN.prototype.copy = function copy(dest) {
      dest.words = new Array(this.length);
      for (var i = 0;i < this.length; i++) {
        dest.words[i] = this.words[i];
      }
      dest.length = this.length;
      dest.negative = this.negative;
      dest.red = this.red;
    };
    function move(dest, src) {
      dest.words = src.words;
      dest.length = src.length;
      dest.negative = src.negative;
      dest.red = src.red;
    }
    BN.prototype._move = function _move(dest) {
      move(dest, this);
    };
    BN.prototype.clone = function clone() {
      var r = new BN(null);
      this.copy(r);
      return r;
    };
    BN.prototype._expand = function _expand(size) {
      while (this.length < size) {
        this.words[this.length++] = 0;
      }
      return this;
    };
    BN.prototype._strip = function strip() {
      while (this.length > 1 && this.words[this.length - 1] === 0) {
        this.length--;
      }
      return this._normSign();
    };
    BN.prototype._normSign = function _normSign() {
      if (this.length === 1 && this.words[0] === 0) {
        this.negative = 0;
      }
      return this;
    };
    if (typeof Symbol !== "undefined" && typeof Symbol.for === "function") {
      try {
        BN.prototype[Symbol.for("nodejs.util.inspect.custom")] = inspect;
      } catch (e) {
        BN.prototype.inspect = inspect;
      }
    } else {
      BN.prototype.inspect = inspect;
    }
    function inspect() {
      return (this.red ? "<BN-R: " : "<BN: ") + this.toString(16) + ">";
    }
    var zeros = [
      "",
      "0",
      "00",
      "000",
      "0000",
      "00000",
      "000000",
      "0000000",
      "00000000",
      "000000000",
      "0000000000",
      "00000000000",
      "000000000000",
      "0000000000000",
      "00000000000000",
      "000000000000000",
      "0000000000000000",
      "00000000000000000",
      "000000000000000000",
      "0000000000000000000",
      "00000000000000000000",
      "000000000000000000000",
      "0000000000000000000000",
      "00000000000000000000000",
      "000000000000000000000000",
      "0000000000000000000000000"
    ];
    var groupSizes = [
      0,
      0,
      25,
      16,
      12,
      11,
      10,
      9,
      8,
      8,
      7,
      7,
      7,
      7,
      6,
      6,
      6,
      6,
      6,
      6,
      6,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5,
      5
    ];
    var groupBases = [
      0,
      0,
      33554432,
      43046721,
      16777216,
      48828125,
      60466176,
      40353607,
      16777216,
      43046721,
      1e7,
      19487171,
      35831808,
      62748517,
      7529536,
      11390625,
      16777216,
      24137569,
      34012224,
      47045881,
      64000000,
      4084101,
      5153632,
      6436343,
      7962624,
      9765625,
      11881376,
      14348907,
      17210368,
      20511149,
      24300000,
      28629151,
      33554432,
      39135393,
      45435424,
      52521875,
      60466176
    ];
    BN.prototype.toString = function toString(base, padding) {
      base = base || 10;
      padding = padding | 0 || 1;
      var out;
      if (base === 16 || base === "hex") {
        out = "";
        var off = 0;
        var carry = 0;
        for (var i = 0;i < this.length; i++) {
          var w = this.words[i];
          var word = ((w << off | carry) & 16777215).toString(16);
          carry = w >>> 24 - off & 16777215;
          off += 2;
          if (off >= 26) {
            off -= 26;
            i--;
          }
          if (carry !== 0 || i !== this.length - 1) {
            out = zeros[6 - word.length] + word + out;
          } else {
            out = word + out;
          }
        }
        if (carry !== 0) {
          out = carry.toString(16) + out;
        }
        while (out.length % padding !== 0) {
          out = "0" + out;
        }
        if (this.negative !== 0) {
          out = "-" + out;
        }
        return out;
      }
      if (base === (base | 0) && base >= 2 && base <= 36) {
        var groupSize = groupSizes[base];
        var groupBase = groupBases[base];
        out = "";
        var c = this.clone();
        c.negative = 0;
        while (!c.isZero()) {
          var r = c.modrn(groupBase).toString(base);
          c = c.idivn(groupBase);
          if (!c.isZero()) {
            out = zeros[groupSize - r.length] + r + out;
          } else {
            out = r + out;
          }
        }
        if (this.isZero()) {
          out = "0" + out;
        }
        while (out.length % padding !== 0) {
          out = "0" + out;
        }
        if (this.negative !== 0) {
          out = "-" + out;
        }
        return out;
      }
      assert(false, "Base should be between 2 and 36");
    };
    BN.prototype.toNumber = function toNumber() {
      var ret = this.words[0];
      if (this.length === 2) {
        ret += this.words[1] * 67108864;
      } else if (this.length === 3 && this.words[2] === 1) {
        ret += 4503599627370496 + this.words[1] * 67108864;
      } else if (this.length > 2) {
        assert(false, "Number can only safely store up to 53 bits");
      }
      return this.negative !== 0 ? -ret : ret;
    };
    BN.prototype.toJSON = function toJSON() {
      return this.toString(16, 2);
    };
    if (Buffer2) {
      BN.prototype.toBuffer = function toBuffer(endian, length) {
        return this.toArrayLike(Buffer2, endian, length);
      };
    }
    BN.prototype.toArray = function toArray(endian, length) {
      return this.toArrayLike(Array, endian, length);
    };
    var allocate = function allocate(ArrayType, size) {
      if (ArrayType.allocUnsafe) {
        return ArrayType.allocUnsafe(size);
      }
      return new ArrayType(size);
    };
    BN.prototype.toArrayLike = function toArrayLike(ArrayType, endian, length) {
      this._strip();
      var byteLength = this.byteLength();
      var reqLength = length || Math.max(1, byteLength);
      assert(byteLength <= reqLength, "byte array longer than desired length");
      assert(reqLength > 0, "Requested array length <= 0");
      var res = allocate(ArrayType, reqLength);
      var postfix = endian === "le" ? "LE" : "BE";
      this["_toArrayLike" + postfix](res, byteLength);
      return res;
    };
    BN.prototype._toArrayLikeLE = function _toArrayLikeLE(res, byteLength) {
      var position = 0;
      var carry = 0;
      for (var i = 0, shift = 0;i < this.length; i++) {
        var word = this.words[i] << shift | carry;
        res[position++] = word & 255;
        if (position < res.length) {
          res[position++] = word >> 8 & 255;
        }
        if (position < res.length) {
          res[position++] = word >> 16 & 255;
        }
        if (shift === 6) {
          if (position < res.length) {
            res[position++] = word >> 24 & 255;
          }
          carry = 0;
          shift = 0;
        } else {
          carry = word >>> 24;
          shift += 2;
        }
      }
      if (position < res.length) {
        res[position++] = carry;
        while (position < res.length) {
          res[position++] = 0;
        }
      }
    };
    BN.prototype._toArrayLikeBE = function _toArrayLikeBE(res, byteLength) {
      var position = res.length - 1;
      var carry = 0;
      for (var i = 0, shift = 0;i < this.length; i++) {
        var word = this.words[i] << shift | carry;
        res[position--] = word & 255;
        if (position >= 0) {
          res[position--] = word >> 8 & 255;
        }
        if (position >= 0) {
          res[position--] = word >> 16 & 255;
        }
        if (shift === 6) {
          if (position >= 0) {
            res[position--] = word >> 24 & 255;
          }
          carry = 0;
          shift = 0;
        } else {
          carry = word >>> 24;
          shift += 2;
        }
      }
      if (position >= 0) {
        res[position--] = carry;
        while (position >= 0) {
          res[position--] = 0;
        }
      }
    };
    if (Math.clz32) {
      BN.prototype._countBits = function _countBits(w) {
        return 32 - Math.clz32(w);
      };
    } else {
      BN.prototype._countBits = function _countBits(w) {
        var t = w;
        var r = 0;
        if (t >= 4096) {
          r += 13;
          t >>>= 13;
        }
        if (t >= 64) {
          r += 7;
          t >>>= 7;
        }
        if (t >= 8) {
          r += 4;
          t >>>= 4;
        }
        if (t >= 2) {
          r += 2;
          t >>>= 2;
        }
        return r + t;
      };
    }
    BN.prototype._zeroBits = function _zeroBits(w) {
      if (w === 0)
        return 26;
      var t = w;
      var r = 0;
      if ((t & 8191) === 0) {
        r += 13;
        t >>>= 13;
      }
      if ((t & 127) === 0) {
        r += 7;
        t >>>= 7;
      }
      if ((t & 15) === 0) {
        r += 4;
        t >>>= 4;
      }
      if ((t & 3) === 0) {
        r += 2;
        t >>>= 2;
      }
      if ((t & 1) === 0) {
        r++;
      }
      return r;
    };
    BN.prototype.bitLength = function bitLength() {
      var w = this.words[this.length - 1];
      var hi = this._countBits(w);
      return (this.length - 1) * 26 + hi;
    };
    function toBitArray(num) {
      var w = new Array(num.bitLength());
      for (var bit = 0;bit < w.length; bit++) {
        var off = bit / 26 | 0;
        var wbit = bit % 26;
        w[bit] = num.words[off] >>> wbit & 1;
      }
      return w;
    }
    BN.prototype.zeroBits = function zeroBits() {
      if (this.isZero())
        return 0;
      var r = 0;
      for (var i = 0;i < this.length; i++) {
        var b = this._zeroBits(this.words[i]);
        r += b;
        if (b !== 26)
          break;
      }
      return r;
    };
    BN.prototype.byteLength = function byteLength() {
      return Math.ceil(this.bitLength() / 8);
    };
    BN.prototype.toTwos = function toTwos(width) {
      if (this.negative !== 0) {
        return this.abs().inotn(width).iaddn(1);
      }
      return this.clone();
    };
    BN.prototype.fromTwos = function fromTwos(width) {
      if (this.testn(width - 1)) {
        return this.notn(width).iaddn(1).ineg();
      }
      return this.clone();
    };
    BN.prototype.isNeg = function isNeg() {
      return this.negative !== 0;
    };
    BN.prototype.neg = function neg() {
      return this.clone().ineg();
    };
    BN.prototype.ineg = function ineg() {
      if (!this.isZero()) {
        this.negative ^= 1;
      }
      return this;
    };
    BN.prototype.iuor = function iuor(num) {
      while (this.length < num.length) {
        this.words[this.length++] = 0;
      }
      for (var i = 0;i < num.length; i++) {
        this.words[i] = this.words[i] | num.words[i];
      }
      return this._strip();
    };
    BN.prototype.ior = function ior(num) {
      assert((this.negative | num.negative) === 0);
      return this.iuor(num);
    };
    BN.prototype.or = function or(num) {
      if (this.length > num.length)
        return this.clone().ior(num);
      return num.clone().ior(this);
    };
    BN.prototype.uor = function uor(num) {
      if (this.length > num.length)
        return this.clone().iuor(num);
      return num.clone().iuor(this);
    };
    BN.prototype.iuand = function iuand(num) {
      var b;
      if (this.length > num.length) {
        b = num;
      } else {
        b = this;
      }
      for (var i = 0;i < b.length; i++) {
        this.words[i] = this.words[i] & num.words[i];
      }
      this.length = b.length;
      return this._strip();
    };
    BN.prototype.iand = function iand(num) {
      assert((this.negative | num.negative) === 0);
      return this.iuand(num);
    };
    BN.prototype.and = function and(num) {
      if (this.length > num.length)
        return this.clone().iand(num);
      return num.clone().iand(this);
    };
    BN.prototype.uand = function uand(num) {
      if (this.length > num.length)
        return this.clone().iuand(num);
      return num.clone().iuand(this);
    };
    BN.prototype.iuxor = function iuxor(num) {
      var a;
      var b;
      if (this.length > num.length) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      for (var i = 0;i < b.length; i++) {
        this.words[i] = a.words[i] ^ b.words[i];
      }
      if (this !== a) {
        for (;i < a.length; i++) {
          this.words[i] = a.words[i];
        }
      }
      this.length = a.length;
      return this._strip();
    };
    BN.prototype.ixor = function ixor(num) {
      assert((this.negative | num.negative) === 0);
      return this.iuxor(num);
    };
    BN.prototype.xor = function xor(num) {
      if (this.length > num.length)
        return this.clone().ixor(num);
      return num.clone().ixor(this);
    };
    BN.prototype.uxor = function uxor(num) {
      if (this.length > num.length)
        return this.clone().iuxor(num);
      return num.clone().iuxor(this);
    };
    BN.prototype.inotn = function inotn(width) {
      assert(typeof width === "number" && width >= 0);
      var bytesNeeded = Math.ceil(width / 26) | 0;
      var bitsLeft = width % 26;
      this._expand(bytesNeeded);
      if (bitsLeft > 0) {
        bytesNeeded--;
      }
      for (var i = 0;i < bytesNeeded; i++) {
        this.words[i] = ~this.words[i] & 67108863;
      }
      if (bitsLeft > 0) {
        this.words[i] = ~this.words[i] & 67108863 >> 26 - bitsLeft;
        i++;
      }
      for (;i < this.length; i++) {
        this.words[i] = 0;
      }
      return this._strip();
    };
    BN.prototype.notn = function notn(width) {
      return this.clone().inotn(width);
    };
    BN.prototype.setn = function setn(bit, val) {
      assert(typeof bit === "number" && bit >= 0);
      var off = bit / 26 | 0;
      var wbit = bit % 26;
      this._expand(off + 1);
      if (val) {
        this.words[off] = this.words[off] | 1 << wbit;
      } else {
        this.words[off] = this.words[off] & ~(1 << wbit);
      }
      return this._strip();
    };
    BN.prototype.iadd = function iadd(num) {
      var r;
      if (this.negative !== 0 && num.negative === 0) {
        this.negative = 0;
        r = this.isub(num);
        this.negative ^= 1;
        return this._normSign();
      } else if (this.negative === 0 && num.negative !== 0) {
        num.negative = 0;
        r = this.isub(num);
        num.negative = 1;
        return r._normSign();
      }
      var a, b;
      if (this.length > num.length) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      var carry = 0;
      for (var i = 0;i < b.length; i++) {
        r = (a.words[i] | 0) + (b.words[i] | 0) + carry;
        this.words[i] = r & 67108863;
        carry = r >>> 26;
      }
      for (;carry !== 0 && i < a.length; i++) {
        r = (a.words[i] | 0) + carry;
        this.words[i] = r & 67108863;
        carry = r >>> 26;
      }
      this.length = a.length;
      if (carry !== 0) {
        this.words[this.length] = carry;
        this.length++;
      } else if (a !== this) {
        for (;i < a.length; i++) {
          this.words[i] = a.words[i];
        }
      }
      return this;
    };
    BN.prototype.add = function add(num) {
      var res;
      if (num.negative !== 0 && this.negative === 0) {
        num.negative = 0;
        res = this.sub(num);
        num.negative ^= 1;
        return res;
      } else if (num.negative === 0 && this.negative !== 0) {
        this.negative = 0;
        res = num.sub(this);
        this.negative = 1;
        return res;
      }
      if (this.length > num.length)
        return this.clone().iadd(num);
      return num.clone().iadd(this);
    };
    BN.prototype.isub = function isub(num) {
      if (num.negative !== 0) {
        num.negative = 0;
        var r = this.iadd(num);
        num.negative = 1;
        return r._normSign();
      } else if (this.negative !== 0) {
        this.negative = 0;
        this.iadd(num);
        this.negative = 1;
        return this._normSign();
      }
      var cmp = this.cmp(num);
      if (cmp === 0) {
        this.negative = 0;
        this.length = 1;
        this.words[0] = 0;
        return this;
      }
      var a, b;
      if (cmp > 0) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      var carry = 0;
      for (var i = 0;i < b.length; i++) {
        r = (a.words[i] | 0) - (b.words[i] | 0) + carry;
        carry = r >> 26;
        this.words[i] = r & 67108863;
      }
      for (;carry !== 0 && i < a.length; i++) {
        r = (a.words[i] | 0) + carry;
        carry = r >> 26;
        this.words[i] = r & 67108863;
      }
      if (carry === 0 && i < a.length && a !== this) {
        for (;i < a.length; i++) {
          this.words[i] = a.words[i];
        }
      }
      this.length = Math.max(this.length, i);
      if (a !== this) {
        this.negative = 1;
      }
      return this._strip();
    };
    BN.prototype.sub = function sub(num) {
      return this.clone().isub(num);
    };
    function smallMulTo(self, num, out) {
      out.negative = num.negative ^ self.negative;
      var len = self.length + num.length | 0;
      out.length = len;
      len = len - 1 | 0;
      var a = self.words[0] | 0;
      var b = num.words[0] | 0;
      var r = a * b;
      var lo = r & 67108863;
      var carry = r / 67108864 | 0;
      out.words[0] = lo;
      for (var k = 1;k < len; k++) {
        var ncarry = carry >>> 26;
        var rword = carry & 67108863;
        var maxJ = Math.min(k, num.length - 1);
        for (var j = Math.max(0, k - self.length + 1);j <= maxJ; j++) {
          var i = k - j | 0;
          a = self.words[i] | 0;
          b = num.words[j] | 0;
          r = a * b + rword;
          ncarry += r / 67108864 | 0;
          rword = r & 67108863;
        }
        out.words[k] = rword | 0;
        carry = ncarry | 0;
      }
      if (carry !== 0) {
        out.words[k] = carry | 0;
      } else {
        out.length--;
      }
      return out._strip();
    }
    var comb10MulTo = function comb10MulTo(self, num, out) {
      var a = self.words;
      var b = num.words;
      var o = out.words;
      var c = 0;
      var lo;
      var mid;
      var hi;
      var a0 = a[0] | 0;
      var al0 = a0 & 8191;
      var ah0 = a0 >>> 13;
      var a1 = a[1] | 0;
      var al1 = a1 & 8191;
      var ah1 = a1 >>> 13;
      var a2 = a[2] | 0;
      var al2 = a2 & 8191;
      var ah2 = a2 >>> 13;
      var a3 = a[3] | 0;
      var al3 = a3 & 8191;
      var ah3 = a3 >>> 13;
      var a4 = a[4] | 0;
      var al4 = a4 & 8191;
      var ah4 = a4 >>> 13;
      var a5 = a[5] | 0;
      var al5 = a5 & 8191;
      var ah5 = a5 >>> 13;
      var a6 = a[6] | 0;
      var al6 = a6 & 8191;
      var ah6 = a6 >>> 13;
      var a7 = a[7] | 0;
      var al7 = a7 & 8191;
      var ah7 = a7 >>> 13;
      var a8 = a[8] | 0;
      var al8 = a8 & 8191;
      var ah8 = a8 >>> 13;
      var a9 = a[9] | 0;
      var al9 = a9 & 8191;
      var ah9 = a9 >>> 13;
      var b0 = b[0] | 0;
      var bl0 = b0 & 8191;
      var bh0 = b0 >>> 13;
      var b1 = b[1] | 0;
      var bl1 = b1 & 8191;
      var bh1 = b1 >>> 13;
      var b2 = b[2] | 0;
      var bl2 = b2 & 8191;
      var bh2 = b2 >>> 13;
      var b3 = b[3] | 0;
      var bl3 = b3 & 8191;
      var bh3 = b3 >>> 13;
      var b4 = b[4] | 0;
      var bl4 = b4 & 8191;
      var bh4 = b4 >>> 13;
      var b5 = b[5] | 0;
      var bl5 = b5 & 8191;
      var bh5 = b5 >>> 13;
      var b6 = b[6] | 0;
      var bl6 = b6 & 8191;
      var bh6 = b6 >>> 13;
      var b7 = b[7] | 0;
      var bl7 = b7 & 8191;
      var bh7 = b7 >>> 13;
      var b8 = b[8] | 0;
      var bl8 = b8 & 8191;
      var bh8 = b8 >>> 13;
      var b9 = b[9] | 0;
      var bl9 = b9 & 8191;
      var bh9 = b9 >>> 13;
      out.negative = self.negative ^ num.negative;
      out.length = 19;
      lo = Math.imul(al0, bl0);
      mid = Math.imul(al0, bh0);
      mid = mid + Math.imul(ah0, bl0) | 0;
      hi = Math.imul(ah0, bh0);
      var w0 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w0 >>> 26) | 0;
      w0 &= 67108863;
      lo = Math.imul(al1, bl0);
      mid = Math.imul(al1, bh0);
      mid = mid + Math.imul(ah1, bl0) | 0;
      hi = Math.imul(ah1, bh0);
      lo = lo + Math.imul(al0, bl1) | 0;
      mid = mid + Math.imul(al0, bh1) | 0;
      mid = mid + Math.imul(ah0, bl1) | 0;
      hi = hi + Math.imul(ah0, bh1) | 0;
      var w1 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w1 >>> 26) | 0;
      w1 &= 67108863;
      lo = Math.imul(al2, bl0);
      mid = Math.imul(al2, bh0);
      mid = mid + Math.imul(ah2, bl0) | 0;
      hi = Math.imul(ah2, bh0);
      lo = lo + Math.imul(al1, bl1) | 0;
      mid = mid + Math.imul(al1, bh1) | 0;
      mid = mid + Math.imul(ah1, bl1) | 0;
      hi = hi + Math.imul(ah1, bh1) | 0;
      lo = lo + Math.imul(al0, bl2) | 0;
      mid = mid + Math.imul(al0, bh2) | 0;
      mid = mid + Math.imul(ah0, bl2) | 0;
      hi = hi + Math.imul(ah0, bh2) | 0;
      var w2 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w2 >>> 26) | 0;
      w2 &= 67108863;
      lo = Math.imul(al3, bl0);
      mid = Math.imul(al3, bh0);
      mid = mid + Math.imul(ah3, bl0) | 0;
      hi = Math.imul(ah3, bh0);
      lo = lo + Math.imul(al2, bl1) | 0;
      mid = mid + Math.imul(al2, bh1) | 0;
      mid = mid + Math.imul(ah2, bl1) | 0;
      hi = hi + Math.imul(ah2, bh1) | 0;
      lo = lo + Math.imul(al1, bl2) | 0;
      mid = mid + Math.imul(al1, bh2) | 0;
      mid = mid + Math.imul(ah1, bl2) | 0;
      hi = hi + Math.imul(ah1, bh2) | 0;
      lo = lo + Math.imul(al0, bl3) | 0;
      mid = mid + Math.imul(al0, bh3) | 0;
      mid = mid + Math.imul(ah0, bl3) | 0;
      hi = hi + Math.imul(ah0, bh3) | 0;
      var w3 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w3 >>> 26) | 0;
      w3 &= 67108863;
      lo = Math.imul(al4, bl0);
      mid = Math.imul(al4, bh0);
      mid = mid + Math.imul(ah4, bl0) | 0;
      hi = Math.imul(ah4, bh0);
      lo = lo + Math.imul(al3, bl1) | 0;
      mid = mid + Math.imul(al3, bh1) | 0;
      mid = mid + Math.imul(ah3, bl1) | 0;
      hi = hi + Math.imul(ah3, bh1) | 0;
      lo = lo + Math.imul(al2, bl2) | 0;
      mid = mid + Math.imul(al2, bh2) | 0;
      mid = mid + Math.imul(ah2, bl2) | 0;
      hi = hi + Math.imul(ah2, bh2) | 0;
      lo = lo + Math.imul(al1, bl3) | 0;
      mid = mid + Math.imul(al1, bh3) | 0;
      mid = mid + Math.imul(ah1, bl3) | 0;
      hi = hi + Math.imul(ah1, bh3) | 0;
      lo = lo + Math.imul(al0, bl4) | 0;
      mid = mid + Math.imul(al0, bh4) | 0;
      mid = mid + Math.imul(ah0, bl4) | 0;
      hi = hi + Math.imul(ah0, bh4) | 0;
      var w4 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w4 >>> 26) | 0;
      w4 &= 67108863;
      lo = Math.imul(al5, bl0);
      mid = Math.imul(al5, bh0);
      mid = mid + Math.imul(ah5, bl0) | 0;
      hi = Math.imul(ah5, bh0);
      lo = lo + Math.imul(al4, bl1) | 0;
      mid = mid + Math.imul(al4, bh1) | 0;
      mid = mid + Math.imul(ah4, bl1) | 0;
      hi = hi + Math.imul(ah4, bh1) | 0;
      lo = lo + Math.imul(al3, bl2) | 0;
      mid = mid + Math.imul(al3, bh2) | 0;
      mid = mid + Math.imul(ah3, bl2) | 0;
      hi = hi + Math.imul(ah3, bh2) | 0;
      lo = lo + Math.imul(al2, bl3) | 0;
      mid = mid + Math.imul(al2, bh3) | 0;
      mid = mid + Math.imul(ah2, bl3) | 0;
      hi = hi + Math.imul(ah2, bh3) | 0;
      lo = lo + Math.imul(al1, bl4) | 0;
      mid = mid + Math.imul(al1, bh4) | 0;
      mid = mid + Math.imul(ah1, bl4) | 0;
      hi = hi + Math.imul(ah1, bh4) | 0;
      lo = lo + Math.imul(al0, bl5) | 0;
      mid = mid + Math.imul(al0, bh5) | 0;
      mid = mid + Math.imul(ah0, bl5) | 0;
      hi = hi + Math.imul(ah0, bh5) | 0;
      var w5 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w5 >>> 26) | 0;
      w5 &= 67108863;
      lo = Math.imul(al6, bl0);
      mid = Math.imul(al6, bh0);
      mid = mid + Math.imul(ah6, bl0) | 0;
      hi = Math.imul(ah6, bh0);
      lo = lo + Math.imul(al5, bl1) | 0;
      mid = mid + Math.imul(al5, bh1) | 0;
      mid = mid + Math.imul(ah5, bl1) | 0;
      hi = hi + Math.imul(ah5, bh1) | 0;
      lo = lo + Math.imul(al4, bl2) | 0;
      mid = mid + Math.imul(al4, bh2) | 0;
      mid = mid + Math.imul(ah4, bl2) | 0;
      hi = hi + Math.imul(ah4, bh2) | 0;
      lo = lo + Math.imul(al3, bl3) | 0;
      mid = mid + Math.imul(al3, bh3) | 0;
      mid = mid + Math.imul(ah3, bl3) | 0;
      hi = hi + Math.imul(ah3, bh3) | 0;
      lo = lo + Math.imul(al2, bl4) | 0;
      mid = mid + Math.imul(al2, bh4) | 0;
      mid = mid + Math.imul(ah2, bl4) | 0;
      hi = hi + Math.imul(ah2, bh4) | 0;
      lo = lo + Math.imul(al1, bl5) | 0;
      mid = mid + Math.imul(al1, bh5) | 0;
      mid = mid + Math.imul(ah1, bl5) | 0;
      hi = hi + Math.imul(ah1, bh5) | 0;
      lo = lo + Math.imul(al0, bl6) | 0;
      mid = mid + Math.imul(al0, bh6) | 0;
      mid = mid + Math.imul(ah0, bl6) | 0;
      hi = hi + Math.imul(ah0, bh6) | 0;
      var w6 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w6 >>> 26) | 0;
      w6 &= 67108863;
      lo = Math.imul(al7, bl0);
      mid = Math.imul(al7, bh0);
      mid = mid + Math.imul(ah7, bl0) | 0;
      hi = Math.imul(ah7, bh0);
      lo = lo + Math.imul(al6, bl1) | 0;
      mid = mid + Math.imul(al6, bh1) | 0;
      mid = mid + Math.imul(ah6, bl1) | 0;
      hi = hi + Math.imul(ah6, bh1) | 0;
      lo = lo + Math.imul(al5, bl2) | 0;
      mid = mid + Math.imul(al5, bh2) | 0;
      mid = mid + Math.imul(ah5, bl2) | 0;
      hi = hi + Math.imul(ah5, bh2) | 0;
      lo = lo + Math.imul(al4, bl3) | 0;
      mid = mid + Math.imul(al4, bh3) | 0;
      mid = mid + Math.imul(ah4, bl3) | 0;
      hi = hi + Math.imul(ah4, bh3) | 0;
      lo = lo + Math.imul(al3, bl4) | 0;
      mid = mid + Math.imul(al3, bh4) | 0;
      mid = mid + Math.imul(ah3, bl4) | 0;
      hi = hi + Math.imul(ah3, bh4) | 0;
      lo = lo + Math.imul(al2, bl5) | 0;
      mid = mid + Math.imul(al2, bh5) | 0;
      mid = mid + Math.imul(ah2, bl5) | 0;
      hi = hi + Math.imul(ah2, bh5) | 0;
      lo = lo + Math.imul(al1, bl6) | 0;
      mid = mid + Math.imul(al1, bh6) | 0;
      mid = mid + Math.imul(ah1, bl6) | 0;
      hi = hi + Math.imul(ah1, bh6) | 0;
      lo = lo + Math.imul(al0, bl7) | 0;
      mid = mid + Math.imul(al0, bh7) | 0;
      mid = mid + Math.imul(ah0, bl7) | 0;
      hi = hi + Math.imul(ah0, bh7) | 0;
      var w7 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w7 >>> 26) | 0;
      w7 &= 67108863;
      lo = Math.imul(al8, bl0);
      mid = Math.imul(al8, bh0);
      mid = mid + Math.imul(ah8, bl0) | 0;
      hi = Math.imul(ah8, bh0);
      lo = lo + Math.imul(al7, bl1) | 0;
      mid = mid + Math.imul(al7, bh1) | 0;
      mid = mid + Math.imul(ah7, bl1) | 0;
      hi = hi + Math.imul(ah7, bh1) | 0;
      lo = lo + Math.imul(al6, bl2) | 0;
      mid = mid + Math.imul(al6, bh2) | 0;
      mid = mid + Math.imul(ah6, bl2) | 0;
      hi = hi + Math.imul(ah6, bh2) | 0;
      lo = lo + Math.imul(al5, bl3) | 0;
      mid = mid + Math.imul(al5, bh3) | 0;
      mid = mid + Math.imul(ah5, bl3) | 0;
      hi = hi + Math.imul(ah5, bh3) | 0;
      lo = lo + Math.imul(al4, bl4) | 0;
      mid = mid + Math.imul(al4, bh4) | 0;
      mid = mid + Math.imul(ah4, bl4) | 0;
      hi = hi + Math.imul(ah4, bh4) | 0;
      lo = lo + Math.imul(al3, bl5) | 0;
      mid = mid + Math.imul(al3, bh5) | 0;
      mid = mid + Math.imul(ah3, bl5) | 0;
      hi = hi + Math.imul(ah3, bh5) | 0;
      lo = lo + Math.imul(al2, bl6) | 0;
      mid = mid + Math.imul(al2, bh6) | 0;
      mid = mid + Math.imul(ah2, bl6) | 0;
      hi = hi + Math.imul(ah2, bh6) | 0;
      lo = lo + Math.imul(al1, bl7) | 0;
      mid = mid + Math.imul(al1, bh7) | 0;
      mid = mid + Math.imul(ah1, bl7) | 0;
      hi = hi + Math.imul(ah1, bh7) | 0;
      lo = lo + Math.imul(al0, bl8) | 0;
      mid = mid + Math.imul(al0, bh8) | 0;
      mid = mid + Math.imul(ah0, bl8) | 0;
      hi = hi + Math.imul(ah0, bh8) | 0;
      var w8 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w8 >>> 26) | 0;
      w8 &= 67108863;
      lo = Math.imul(al9, bl0);
      mid = Math.imul(al9, bh0);
      mid = mid + Math.imul(ah9, bl0) | 0;
      hi = Math.imul(ah9, bh0);
      lo = lo + Math.imul(al8, bl1) | 0;
      mid = mid + Math.imul(al8, bh1) | 0;
      mid = mid + Math.imul(ah8, bl1) | 0;
      hi = hi + Math.imul(ah8, bh1) | 0;
      lo = lo + Math.imul(al7, bl2) | 0;
      mid = mid + Math.imul(al7, bh2) | 0;
      mid = mid + Math.imul(ah7, bl2) | 0;
      hi = hi + Math.imul(ah7, bh2) | 0;
      lo = lo + Math.imul(al6, bl3) | 0;
      mid = mid + Math.imul(al6, bh3) | 0;
      mid = mid + Math.imul(ah6, bl3) | 0;
      hi = hi + Math.imul(ah6, bh3) | 0;
      lo = lo + Math.imul(al5, bl4) | 0;
      mid = mid + Math.imul(al5, bh4) | 0;
      mid = mid + Math.imul(ah5, bl4) | 0;
      hi = hi + Math.imul(ah5, bh4) | 0;
      lo = lo + Math.imul(al4, bl5) | 0;
      mid = mid + Math.imul(al4, bh5) | 0;
      mid = mid + Math.imul(ah4, bl5) | 0;
      hi = hi + Math.imul(ah4, bh5) | 0;
      lo = lo + Math.imul(al3, bl6) | 0;
      mid = mid + Math.imul(al3, bh6) | 0;
      mid = mid + Math.imul(ah3, bl6) | 0;
      hi = hi + Math.imul(ah3, bh6) | 0;
      lo = lo + Math.imul(al2, bl7) | 0;
      mid = mid + Math.imul(al2, bh7) | 0;
      mid = mid + Math.imul(ah2, bl7) | 0;
      hi = hi + Math.imul(ah2, bh7) | 0;
      lo = lo + Math.imul(al1, bl8) | 0;
      mid = mid + Math.imul(al1, bh8) | 0;
      mid = mid + Math.imul(ah1, bl8) | 0;
      hi = hi + Math.imul(ah1, bh8) | 0;
      lo = lo + Math.imul(al0, bl9) | 0;
      mid = mid + Math.imul(al0, bh9) | 0;
      mid = mid + Math.imul(ah0, bl9) | 0;
      hi = hi + Math.imul(ah0, bh9) | 0;
      var w9 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w9 >>> 26) | 0;
      w9 &= 67108863;
      lo = Math.imul(al9, bl1);
      mid = Math.imul(al9, bh1);
      mid = mid + Math.imul(ah9, bl1) | 0;
      hi = Math.imul(ah9, bh1);
      lo = lo + Math.imul(al8, bl2) | 0;
      mid = mid + Math.imul(al8, bh2) | 0;
      mid = mid + Math.imul(ah8, bl2) | 0;
      hi = hi + Math.imul(ah8, bh2) | 0;
      lo = lo + Math.imul(al7, bl3) | 0;
      mid = mid + Math.imul(al7, bh3) | 0;
      mid = mid + Math.imul(ah7, bl3) | 0;
      hi = hi + Math.imul(ah7, bh3) | 0;
      lo = lo + Math.imul(al6, bl4) | 0;
      mid = mid + Math.imul(al6, bh4) | 0;
      mid = mid + Math.imul(ah6, bl4) | 0;
      hi = hi + Math.imul(ah6, bh4) | 0;
      lo = lo + Math.imul(al5, bl5) | 0;
      mid = mid + Math.imul(al5, bh5) | 0;
      mid = mid + Math.imul(ah5, bl5) | 0;
      hi = hi + Math.imul(ah5, bh5) | 0;
      lo = lo + Math.imul(al4, bl6) | 0;
      mid = mid + Math.imul(al4, bh6) | 0;
      mid = mid + Math.imul(ah4, bl6) | 0;
      hi = hi + Math.imul(ah4, bh6) | 0;
      lo = lo + Math.imul(al3, bl7) | 0;
      mid = mid + Math.imul(al3, bh7) | 0;
      mid = mid + Math.imul(ah3, bl7) | 0;
      hi = hi + Math.imul(ah3, bh7) | 0;
      lo = lo + Math.imul(al2, bl8) | 0;
      mid = mid + Math.imul(al2, bh8) | 0;
      mid = mid + Math.imul(ah2, bl8) | 0;
      hi = hi + Math.imul(ah2, bh8) | 0;
      lo = lo + Math.imul(al1, bl9) | 0;
      mid = mid + Math.imul(al1, bh9) | 0;
      mid = mid + Math.imul(ah1, bl9) | 0;
      hi = hi + Math.imul(ah1, bh9) | 0;
      var w10 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w10 >>> 26) | 0;
      w10 &= 67108863;
      lo = Math.imul(al9, bl2);
      mid = Math.imul(al9, bh2);
      mid = mid + Math.imul(ah9, bl2) | 0;
      hi = Math.imul(ah9, bh2);
      lo = lo + Math.imul(al8, bl3) | 0;
      mid = mid + Math.imul(al8, bh3) | 0;
      mid = mid + Math.imul(ah8, bl3) | 0;
      hi = hi + Math.imul(ah8, bh3) | 0;
      lo = lo + Math.imul(al7, bl4) | 0;
      mid = mid + Math.imul(al7, bh4) | 0;
      mid = mid + Math.imul(ah7, bl4) | 0;
      hi = hi + Math.imul(ah7, bh4) | 0;
      lo = lo + Math.imul(al6, bl5) | 0;
      mid = mid + Math.imul(al6, bh5) | 0;
      mid = mid + Math.imul(ah6, bl5) | 0;
      hi = hi + Math.imul(ah6, bh5) | 0;
      lo = lo + Math.imul(al5, bl6) | 0;
      mid = mid + Math.imul(al5, bh6) | 0;
      mid = mid + Math.imul(ah5, bl6) | 0;
      hi = hi + Math.imul(ah5, bh6) | 0;
      lo = lo + Math.imul(al4, bl7) | 0;
      mid = mid + Math.imul(al4, bh7) | 0;
      mid = mid + Math.imul(ah4, bl7) | 0;
      hi = hi + Math.imul(ah4, bh7) | 0;
      lo = lo + Math.imul(al3, bl8) | 0;
      mid = mid + Math.imul(al3, bh8) | 0;
      mid = mid + Math.imul(ah3, bl8) | 0;
      hi = hi + Math.imul(ah3, bh8) | 0;
      lo = lo + Math.imul(al2, bl9) | 0;
      mid = mid + Math.imul(al2, bh9) | 0;
      mid = mid + Math.imul(ah2, bl9) | 0;
      hi = hi + Math.imul(ah2, bh9) | 0;
      var w11 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w11 >>> 26) | 0;
      w11 &= 67108863;
      lo = Math.imul(al9, bl3);
      mid = Math.imul(al9, bh3);
      mid = mid + Math.imul(ah9, bl3) | 0;
      hi = Math.imul(ah9, bh3);
      lo = lo + Math.imul(al8, bl4) | 0;
      mid = mid + Math.imul(al8, bh4) | 0;
      mid = mid + Math.imul(ah8, bl4) | 0;
      hi = hi + Math.imul(ah8, bh4) | 0;
      lo = lo + Math.imul(al7, bl5) | 0;
      mid = mid + Math.imul(al7, bh5) | 0;
      mid = mid + Math.imul(ah7, bl5) | 0;
      hi = hi + Math.imul(ah7, bh5) | 0;
      lo = lo + Math.imul(al6, bl6) | 0;
      mid = mid + Math.imul(al6, bh6) | 0;
      mid = mid + Math.imul(ah6, bl6) | 0;
      hi = hi + Math.imul(ah6, bh6) | 0;
      lo = lo + Math.imul(al5, bl7) | 0;
      mid = mid + Math.imul(al5, bh7) | 0;
      mid = mid + Math.imul(ah5, bl7) | 0;
      hi = hi + Math.imul(ah5, bh7) | 0;
      lo = lo + Math.imul(al4, bl8) | 0;
      mid = mid + Math.imul(al4, bh8) | 0;
      mid = mid + Math.imul(ah4, bl8) | 0;
      hi = hi + Math.imul(ah4, bh8) | 0;
      lo = lo + Math.imul(al3, bl9) | 0;
      mid = mid + Math.imul(al3, bh9) | 0;
      mid = mid + Math.imul(ah3, bl9) | 0;
      hi = hi + Math.imul(ah3, bh9) | 0;
      var w12 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w12 >>> 26) | 0;
      w12 &= 67108863;
      lo = Math.imul(al9, bl4);
      mid = Math.imul(al9, bh4);
      mid = mid + Math.imul(ah9, bl4) | 0;
      hi = Math.imul(ah9, bh4);
      lo = lo + Math.imul(al8, bl5) | 0;
      mid = mid + Math.imul(al8, bh5) | 0;
      mid = mid + Math.imul(ah8, bl5) | 0;
      hi = hi + Math.imul(ah8, bh5) | 0;
      lo = lo + Math.imul(al7, bl6) | 0;
      mid = mid + Math.imul(al7, bh6) | 0;
      mid = mid + Math.imul(ah7, bl6) | 0;
      hi = hi + Math.imul(ah7, bh6) | 0;
      lo = lo + Math.imul(al6, bl7) | 0;
      mid = mid + Math.imul(al6, bh7) | 0;
      mid = mid + Math.imul(ah6, bl7) | 0;
      hi = hi + Math.imul(ah6, bh7) | 0;
      lo = lo + Math.imul(al5, bl8) | 0;
      mid = mid + Math.imul(al5, bh8) | 0;
      mid = mid + Math.imul(ah5, bl8) | 0;
      hi = hi + Math.imul(ah5, bh8) | 0;
      lo = lo + Math.imul(al4, bl9) | 0;
      mid = mid + Math.imul(al4, bh9) | 0;
      mid = mid + Math.imul(ah4, bl9) | 0;
      hi = hi + Math.imul(ah4, bh9) | 0;
      var w13 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w13 >>> 26) | 0;
      w13 &= 67108863;
      lo = Math.imul(al9, bl5);
      mid = Math.imul(al9, bh5);
      mid = mid + Math.imul(ah9, bl5) | 0;
      hi = Math.imul(ah9, bh5);
      lo = lo + Math.imul(al8, bl6) | 0;
      mid = mid + Math.imul(al8, bh6) | 0;
      mid = mid + Math.imul(ah8, bl6) | 0;
      hi = hi + Math.imul(ah8, bh6) | 0;
      lo = lo + Math.imul(al7, bl7) | 0;
      mid = mid + Math.imul(al7, bh7) | 0;
      mid = mid + Math.imul(ah7, bl7) | 0;
      hi = hi + Math.imul(ah7, bh7) | 0;
      lo = lo + Math.imul(al6, bl8) | 0;
      mid = mid + Math.imul(al6, bh8) | 0;
      mid = mid + Math.imul(ah6, bl8) | 0;
      hi = hi + Math.imul(ah6, bh8) | 0;
      lo = lo + Math.imul(al5, bl9) | 0;
      mid = mid + Math.imul(al5, bh9) | 0;
      mid = mid + Math.imul(ah5, bl9) | 0;
      hi = hi + Math.imul(ah5, bh9) | 0;
      var w14 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w14 >>> 26) | 0;
      w14 &= 67108863;
      lo = Math.imul(al9, bl6);
      mid = Math.imul(al9, bh6);
      mid = mid + Math.imul(ah9, bl6) | 0;
      hi = Math.imul(ah9, bh6);
      lo = lo + Math.imul(al8, bl7) | 0;
      mid = mid + Math.imul(al8, bh7) | 0;
      mid = mid + Math.imul(ah8, bl7) | 0;
      hi = hi + Math.imul(ah8, bh7) | 0;
      lo = lo + Math.imul(al7, bl8) | 0;
      mid = mid + Math.imul(al7, bh8) | 0;
      mid = mid + Math.imul(ah7, bl8) | 0;
      hi = hi + Math.imul(ah7, bh8) | 0;
      lo = lo + Math.imul(al6, bl9) | 0;
      mid = mid + Math.imul(al6, bh9) | 0;
      mid = mid + Math.imul(ah6, bl9) | 0;
      hi = hi + Math.imul(ah6, bh9) | 0;
      var w15 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w15 >>> 26) | 0;
      w15 &= 67108863;
      lo = Math.imul(al9, bl7);
      mid = Math.imul(al9, bh7);
      mid = mid + Math.imul(ah9, bl7) | 0;
      hi = Math.imul(ah9, bh7);
      lo = lo + Math.imul(al8, bl8) | 0;
      mid = mid + Math.imul(al8, bh8) | 0;
      mid = mid + Math.imul(ah8, bl8) | 0;
      hi = hi + Math.imul(ah8, bh8) | 0;
      lo = lo + Math.imul(al7, bl9) | 0;
      mid = mid + Math.imul(al7, bh9) | 0;
      mid = mid + Math.imul(ah7, bl9) | 0;
      hi = hi + Math.imul(ah7, bh9) | 0;
      var w16 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w16 >>> 26) | 0;
      w16 &= 67108863;
      lo = Math.imul(al9, bl8);
      mid = Math.imul(al9, bh8);
      mid = mid + Math.imul(ah9, bl8) | 0;
      hi = Math.imul(ah9, bh8);
      lo = lo + Math.imul(al8, bl9) | 0;
      mid = mid + Math.imul(al8, bh9) | 0;
      mid = mid + Math.imul(ah8, bl9) | 0;
      hi = hi + Math.imul(ah8, bh9) | 0;
      var w17 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w17 >>> 26) | 0;
      w17 &= 67108863;
      lo = Math.imul(al9, bl9);
      mid = Math.imul(al9, bh9);
      mid = mid + Math.imul(ah9, bl9) | 0;
      hi = Math.imul(ah9, bh9);
      var w18 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
      c = (hi + (mid >>> 13) | 0) + (w18 >>> 26) | 0;
      w18 &= 67108863;
      o[0] = w0;
      o[1] = w1;
      o[2] = w2;
      o[3] = w3;
      o[4] = w4;
      o[5] = w5;
      o[6] = w6;
      o[7] = w7;
      o[8] = w8;
      o[9] = w9;
      o[10] = w10;
      o[11] = w11;
      o[12] = w12;
      o[13] = w13;
      o[14] = w14;
      o[15] = w15;
      o[16] = w16;
      o[17] = w17;
      o[18] = w18;
      if (c !== 0) {
        o[19] = c;
        out.length++;
      }
      return out;
    };
    if (!Math.imul) {
      comb10MulTo = smallMulTo;
    }
    function bigMulTo(self, num, out) {
      out.negative = num.negative ^ self.negative;
      out.length = self.length + num.length;
      var carry = 0;
      var hncarry = 0;
      for (var k = 0;k < out.length - 1; k++) {
        var ncarry = hncarry;
        hncarry = 0;
        var rword = carry & 67108863;
        var maxJ = Math.min(k, num.length - 1);
        for (var j = Math.max(0, k - self.length + 1);j <= maxJ; j++) {
          var i = k - j;
          var a = self.words[i] | 0;
          var b = num.words[j] | 0;
          var r = a * b;
          var lo = r & 67108863;
          ncarry = ncarry + (r / 67108864 | 0) | 0;
          lo = lo + rword | 0;
          rword = lo & 67108863;
          ncarry = ncarry + (lo >>> 26) | 0;
          hncarry += ncarry >>> 26;
          ncarry &= 67108863;
        }
        out.words[k] = rword;
        carry = ncarry;
        ncarry = hncarry;
      }
      if (carry !== 0) {
        out.words[k] = carry;
      } else {
        out.length--;
      }
      return out._strip();
    }
    function jumboMulTo(self, num, out) {
      return bigMulTo(self, num, out);
    }
    BN.prototype.mulTo = function mulTo(num, out) {
      var res;
      var len = this.length + num.length;
      if (this.length === 10 && num.length === 10) {
        res = comb10MulTo(this, num, out);
      } else if (len < 63) {
        res = smallMulTo(this, num, out);
      } else if (len < 1024) {
        res = bigMulTo(this, num, out);
      } else {
        res = jumboMulTo(this, num, out);
      }
      return res;
    };
    function FFTM(x, y) {
      this.x = x;
      this.y = y;
    }
    FFTM.prototype.makeRBT = function makeRBT(N) {
      var t = new Array(N);
      var l = BN.prototype._countBits(N) - 1;
      for (var i = 0;i < N; i++) {
        t[i] = this.revBin(i, l, N);
      }
      return t;
    };
    FFTM.prototype.revBin = function revBin(x, l, N) {
      if (x === 0 || x === N - 1)
        return x;
      var rb = 0;
      for (var i = 0;i < l; i++) {
        rb |= (x & 1) << l - i - 1;
        x >>= 1;
      }
      return rb;
    };
    FFTM.prototype.permute = function permute(rbt, rws, iws, rtws, itws, N) {
      for (var i = 0;i < N; i++) {
        rtws[i] = rws[rbt[i]];
        itws[i] = iws[rbt[i]];
      }
    };
    FFTM.prototype.transform = function transform(rws, iws, rtws, itws, N, rbt) {
      this.permute(rbt, rws, iws, rtws, itws, N);
      for (var s = 1;s < N; s <<= 1) {
        var l = s << 1;
        var rtwdf = Math.cos(2 * Math.PI / l);
        var itwdf = Math.sin(2 * Math.PI / l);
        for (var p = 0;p < N; p += l) {
          var rtwdf_ = rtwdf;
          var itwdf_ = itwdf;
          for (var j = 0;j < s; j++) {
            var re = rtws[p + j];
            var ie = itws[p + j];
            var ro = rtws[p + j + s];
            var io = itws[p + j + s];
            var rx = rtwdf_ * ro - itwdf_ * io;
            io = rtwdf_ * io + itwdf_ * ro;
            ro = rx;
            rtws[p + j] = re + ro;
            itws[p + j] = ie + io;
            rtws[p + j + s] = re - ro;
            itws[p + j + s] = ie - io;
            if (j !== l) {
              rx = rtwdf * rtwdf_ - itwdf * itwdf_;
              itwdf_ = rtwdf * itwdf_ + itwdf * rtwdf_;
              rtwdf_ = rx;
            }
          }
        }
      }
    };
    FFTM.prototype.guessLen13b = function guessLen13b(n, m) {
      var N = Math.max(m, n) | 1;
      var odd = N & 1;
      var i = 0;
      for (N = N / 2 | 0;N; N = N >>> 1) {
        i++;
      }
      return 1 << i + 1 + odd;
    };
    FFTM.prototype.conjugate = function conjugate(rws, iws, N) {
      if (N <= 1)
        return;
      for (var i = 0;i < N / 2; i++) {
        var t = rws[i];
        rws[i] = rws[N - i - 1];
        rws[N - i - 1] = t;
        t = iws[i];
        iws[i] = -iws[N - i - 1];
        iws[N - i - 1] = -t;
      }
    };
    FFTM.prototype.normalize13b = function normalize13b(ws, N) {
      var carry = 0;
      for (var i = 0;i < N / 2; i++) {
        var w = Math.round(ws[2 * i + 1] / N) * 8192 + Math.round(ws[2 * i] / N) + carry;
        ws[i] = w & 67108863;
        if (w < 67108864) {
          carry = 0;
        } else {
          carry = w / 67108864 | 0;
        }
      }
      return ws;
    };
    FFTM.prototype.convert13b = function convert13b(ws, len, rws, N) {
      var carry = 0;
      for (var i = 0;i < len; i++) {
        carry = carry + (ws[i] | 0);
        rws[2 * i] = carry & 8191;
        carry = carry >>> 13;
        rws[2 * i + 1] = carry & 8191;
        carry = carry >>> 13;
      }
      for (i = 2 * len;i < N; ++i) {
        rws[i] = 0;
      }
      assert(carry === 0);
      assert((carry & ~8191) === 0);
    };
    FFTM.prototype.stub = function stub(N) {
      var ph = new Array(N);
      for (var i = 0;i < N; i++) {
        ph[i] = 0;
      }
      return ph;
    };
    FFTM.prototype.mulp = function mulp(x, y, out) {
      var N = 2 * this.guessLen13b(x.length, y.length);
      var rbt = this.makeRBT(N);
      var _ = this.stub(N);
      var rws = new Array(N);
      var rwst = new Array(N);
      var iwst = new Array(N);
      var nrws = new Array(N);
      var nrwst = new Array(N);
      var niwst = new Array(N);
      var rmws = out.words;
      rmws.length = N;
      this.convert13b(x.words, x.length, rws, N);
      this.convert13b(y.words, y.length, nrws, N);
      this.transform(rws, _, rwst, iwst, N, rbt);
      this.transform(nrws, _, nrwst, niwst, N, rbt);
      for (var i = 0;i < N; i++) {
        var rx = rwst[i] * nrwst[i] - iwst[i] * niwst[i];
        iwst[i] = rwst[i] * niwst[i] + iwst[i] * nrwst[i];
        rwst[i] = rx;
      }
      this.conjugate(rwst, iwst, N);
      this.transform(rwst, iwst, rmws, _, N, rbt);
      this.conjugate(rmws, _, N);
      this.normalize13b(rmws, N);
      out.negative = x.negative ^ y.negative;
      out.length = x.length + y.length;
      return out._strip();
    };
    BN.prototype.mul = function mul(num) {
      var out = new BN(null);
      out.words = new Array(this.length + num.length);
      return this.mulTo(num, out);
    };
    BN.prototype.mulf = function mulf(num) {
      var out = new BN(null);
      out.words = new Array(this.length + num.length);
      return jumboMulTo(this, num, out);
    };
    BN.prototype.imul = function imul(num) {
      return this.clone().mulTo(num, this);
    };
    BN.prototype.imuln = function imuln(num) {
      var isNegNum = num < 0;
      if (isNegNum)
        num = -num;
      assert(typeof num === "number");
      assert(num < 67108864);
      var carry = 0;
      for (var i = 0;i < this.length; i++) {
        var w = (this.words[i] | 0) * num;
        var lo = (w & 67108863) + (carry & 67108863);
        carry >>= 26;
        carry += w / 67108864 | 0;
        carry += lo >>> 26;
        this.words[i] = lo & 67108863;
      }
      if (carry !== 0) {
        this.words[i] = carry;
        this.length++;
      }
      if (num === 0) {
        this.length = 1;
        this._normSign();
      }
      return isNegNum ? this.ineg() : this;
    };
    BN.prototype.muln = function muln(num) {
      return this.clone().imuln(num);
    };
    BN.prototype.sqr = function sqr() {
      return this.mul(this);
    };
    BN.prototype.isqr = function isqr() {
      return this.imul(this.clone());
    };
    BN.prototype.pow = function pow(num) {
      var w = toBitArray(num);
      if (w.length === 0)
        return new BN(1);
      var res = this;
      for (var i = 0;i < w.length; i++, res = res.sqr()) {
        if (w[i] !== 0)
          break;
      }
      if (++i < w.length) {
        for (var q = res.sqr();i < w.length; i++, q = q.sqr()) {
          if (w[i] === 0)
            continue;
          res = res.mul(q);
        }
      }
      return res;
    };
    BN.prototype.iushln = function iushln(bits) {
      assert(typeof bits === "number" && bits >= 0);
      var r = bits % 26;
      var s = (bits - r) / 26;
      var carryMask = 67108863 >>> 26 - r << 26 - r;
      var i;
      if (r !== 0) {
        var carry = 0;
        for (i = 0;i < this.length; i++) {
          var newCarry = this.words[i] & carryMask;
          var c = (this.words[i] | 0) - newCarry << r;
          this.words[i] = c | carry;
          carry = newCarry >>> 26 - r;
        }
        if (carry) {
          this.words[i] = carry;
          this.length++;
        }
      }
      if (s !== 0) {
        for (i = this.length - 1;i >= 0; i--) {
          this.words[i + s] = this.words[i];
        }
        for (i = 0;i < s; i++) {
          this.words[i] = 0;
        }
        this.length += s;
      }
      return this._strip();
    };
    BN.prototype.ishln = function ishln(bits) {
      assert(this.negative === 0);
      return this.iushln(bits);
    };
    BN.prototype.iushrn = function iushrn(bits, hint, extended) {
      assert(typeof bits === "number" && bits >= 0);
      var h;
      if (hint) {
        h = (hint - hint % 26) / 26;
      } else {
        h = 0;
      }
      var r = bits % 26;
      var s = Math.min((bits - r) / 26, this.length);
      var mask = 67108863 ^ 67108863 >>> r << r;
      var maskedWords = extended;
      h -= s;
      h = Math.max(0, h);
      if (maskedWords) {
        for (var i = 0;i < s; i++) {
          maskedWords.words[i] = this.words[i];
        }
        maskedWords.length = s;
      }
      if (s === 0) {} else if (this.length > s) {
        this.length -= s;
        for (i = 0;i < this.length; i++) {
          this.words[i] = this.words[i + s];
        }
      } else {
        this.words[0] = 0;
        this.length = 1;
      }
      var carry = 0;
      for (i = this.length - 1;i >= 0 && (carry !== 0 || i >= h); i--) {
        var word = this.words[i] | 0;
        this.words[i] = carry << 26 - r | word >>> r;
        carry = word & mask;
      }
      if (maskedWords && carry !== 0) {
        maskedWords.words[maskedWords.length++] = carry;
      }
      if (this.length === 0) {
        this.words[0] = 0;
        this.length = 1;
      }
      return this._strip();
    };
    BN.prototype.ishrn = function ishrn(bits, hint, extended) {
      assert(this.negative === 0);
      return this.iushrn(bits, hint, extended);
    };
    BN.prototype.shln = function shln(bits) {
      return this.clone().ishln(bits);
    };
    BN.prototype.ushln = function ushln(bits) {
      return this.clone().iushln(bits);
    };
    BN.prototype.shrn = function shrn(bits) {
      return this.clone().ishrn(bits);
    };
    BN.prototype.ushrn = function ushrn(bits) {
      return this.clone().iushrn(bits);
    };
    BN.prototype.testn = function testn(bit) {
      assert(typeof bit === "number" && bit >= 0);
      var r = bit % 26;
      var s = (bit - r) / 26;
      var q = 1 << r;
      if (this.length <= s)
        return false;
      var w = this.words[s];
      return !!(w & q);
    };
    BN.prototype.imaskn = function imaskn(bits) {
      assert(typeof bits === "number" && bits >= 0);
      var r = bits % 26;
      var s = (bits - r) / 26;
      assert(this.negative === 0, "imaskn works only with positive numbers");
      if (this.length <= s) {
        return this;
      }
      if (r !== 0) {
        s++;
      }
      this.length = Math.min(s, this.length);
      if (r !== 0) {
        var mask = 67108863 ^ 67108863 >>> r << r;
        this.words[this.length - 1] &= mask;
      }
      if (this.length === 0) {
        this.words[0] = 0;
        this.length = 1;
      }
      return this._strip();
    };
    BN.prototype.maskn = function maskn(bits) {
      return this.clone().imaskn(bits);
    };
    BN.prototype.iaddn = function iaddn(num) {
      assert(typeof num === "number");
      assert(num < 67108864);
      if (num < 0)
        return this.isubn(-num);
      if (this.negative !== 0) {
        if (this.length === 1 && (this.words[0] | 0) <= num) {
          this.words[0] = num - (this.words[0] | 0);
          this.negative = 0;
          return this;
        }
        this.negative = 0;
        this.isubn(num);
        this.negative = 1;
        return this;
      }
      return this._iaddn(num);
    };
    BN.prototype._iaddn = function _iaddn(num) {
      this.words[0] += num;
      for (var i = 0;i < this.length && this.words[i] >= 67108864; i++) {
        this.words[i] -= 67108864;
        if (i === this.length - 1) {
          this.words[i + 1] = 1;
        } else {
          this.words[i + 1]++;
        }
      }
      this.length = Math.max(this.length, i + 1);
      return this;
    };
    BN.prototype.isubn = function isubn(num) {
      assert(typeof num === "number");
      assert(num < 67108864);
      if (num < 0)
        return this.iaddn(-num);
      if (this.negative !== 0) {
        this.negative = 0;
        this.iaddn(num);
        this.negative = 1;
        return this;
      }
      this.words[0] -= num;
      if (this.length === 1 && this.words[0] < 0) {
        this.words[0] = -this.words[0];
        this.negative = 1;
      } else {
        for (var i = 0;i < this.length && this.words[i] < 0; i++) {
          this.words[i] += 67108864;
          this.words[i + 1] -= 1;
        }
      }
      return this._strip();
    };
    BN.prototype.addn = function addn(num) {
      return this.clone().iaddn(num);
    };
    BN.prototype.subn = function subn(num) {
      return this.clone().isubn(num);
    };
    BN.prototype.iabs = function iabs() {
      this.negative = 0;
      return this;
    };
    BN.prototype.abs = function abs() {
      return this.clone().iabs();
    };
    BN.prototype._ishlnsubmul = function _ishlnsubmul(num, mul, shift) {
      var len = num.length + shift;
      var i;
      this._expand(len);
      var w;
      var carry = 0;
      for (i = 0;i < num.length; i++) {
        w = (this.words[i + shift] | 0) + carry;
        var right = (num.words[i] | 0) * mul;
        w -= right & 67108863;
        carry = (w >> 26) - (right / 67108864 | 0);
        this.words[i + shift] = w & 67108863;
      }
      for (;i < this.length - shift; i++) {
        w = (this.words[i + shift] | 0) + carry;
        carry = w >> 26;
        this.words[i + shift] = w & 67108863;
      }
      if (carry === 0)
        return this._strip();
      assert(carry === -1);
      carry = 0;
      for (i = 0;i < this.length; i++) {
        w = -(this.words[i] | 0) + carry;
        carry = w >> 26;
        this.words[i] = w & 67108863;
      }
      this.negative = 1;
      return this._strip();
    };
    BN.prototype._wordDiv = function _wordDiv(num, mode) {
      var shift = this.length - num.length;
      var a = this.clone();
      var b = num;
      var bhi = b.words[b.length - 1] | 0;
      var bhiBits = this._countBits(bhi);
      shift = 26 - bhiBits;
      if (shift !== 0) {
        b = b.ushln(shift);
        a.iushln(shift);
        bhi = b.words[b.length - 1] | 0;
      }
      var m = a.length - b.length;
      var q;
      if (mode !== "mod") {
        q = new BN(null);
        q.length = m + 1;
        q.words = new Array(q.length);
        for (var i = 0;i < q.length; i++) {
          q.words[i] = 0;
        }
      }
      var diff = a.clone()._ishlnsubmul(b, 1, m);
      if (diff.negative === 0) {
        a = diff;
        if (q) {
          q.words[m] = 1;
        }
      }
      for (var j = m - 1;j >= 0; j--) {
        var qj = (a.words[b.length + j] | 0) * 67108864 + (a.words[b.length + j - 1] | 0);
        qj = Math.min(qj / bhi | 0, 67108863);
        a._ishlnsubmul(b, qj, j);
        while (a.negative !== 0) {
          qj--;
          a.negative = 0;
          a._ishlnsubmul(b, 1, j);
          if (!a.isZero()) {
            a.negative ^= 1;
          }
        }
        if (q) {
          q.words[j] = qj;
        }
      }
      if (q) {
        q._strip();
      }
      a._strip();
      if (mode !== "div" && shift !== 0) {
        a.iushrn(shift);
      }
      return {
        div: q || null,
        mod: a
      };
    };
    BN.prototype.divmod = function divmod(num, mode, positive) {
      assert(!num.isZero());
      if (this.isZero()) {
        return {
          div: new BN(0),
          mod: new BN(0)
        };
      }
      var div, mod, res;
      if (this.negative !== 0 && num.negative === 0) {
        res = this.neg().divmod(num, mode);
        if (mode !== "mod") {
          div = res.div.neg();
        }
        if (mode !== "div") {
          mod = res.mod.neg();
          if (positive && mod.negative !== 0) {
            mod.iadd(num);
          }
        }
        return {
          div,
          mod
        };
      }
      if (this.negative === 0 && num.negative !== 0) {
        res = this.divmod(num.neg(), mode);
        if (mode !== "mod") {
          div = res.div.neg();
        }
        return {
          div,
          mod: res.mod
        };
      }
      if ((this.negative & num.negative) !== 0) {
        res = this.neg().divmod(num.neg(), mode);
        if (mode !== "div") {
          mod = res.mod.neg();
          if (positive && mod.negative !== 0) {
            mod.isub(num);
          }
        }
        return {
          div: res.div,
          mod
        };
      }
      if (num.length > this.length || this.cmp(num) < 0) {
        return {
          div: new BN(0),
          mod: this
        };
      }
      if (num.length === 1) {
        if (mode === "div") {
          return {
            div: this.divn(num.words[0]),
            mod: null
          };
        }
        if (mode === "mod") {
          return {
            div: null,
            mod: new BN(this.modrn(num.words[0]))
          };
        }
        return {
          div: this.divn(num.words[0]),
          mod: new BN(this.modrn(num.words[0]))
        };
      }
      return this._wordDiv(num, mode);
    };
    BN.prototype.div = function div(num) {
      return this.divmod(num, "div", false).div;
    };
    BN.prototype.mod = function mod(num) {
      return this.divmod(num, "mod", false).mod;
    };
    BN.prototype.umod = function umod(num) {
      return this.divmod(num, "mod", true).mod;
    };
    BN.prototype.divRound = function divRound(num) {
      var dm = this.divmod(num);
      if (dm.mod.isZero())
        return dm.div;
      var mod = dm.mod.abs();
      var half = num.abs().iushrn(1);
      var r2 = num.words[0] & 1;
      var cmp = mod.cmp(half);
      if (cmp < 0 || r2 === 1 && cmp === 0)
        return dm.div;
      var up = new BN(1);
      up.negative = this.negative ^ num.negative;
      return dm.div.iadd(up);
    };
    BN.prototype.modrn = function modrn(num) {
      var isNegNum = num < 0;
      if (isNegNum)
        num = -num;
      assert(num <= 67108863);
      var p = (1 << 26) % num;
      var acc = 0;
      for (var i = this.length - 1;i >= 0; i--) {
        acc = (p * acc + (this.words[i] | 0)) % num;
      }
      return isNegNum ? -acc : acc;
    };
    BN.prototype.modn = function modn(num) {
      return this.modrn(num);
    };
    BN.prototype.idivn = function idivn(num) {
      var isNegNum = num < 0;
      if (isNegNum)
        num = -num;
      assert(num <= 67108863);
      var carry = 0;
      for (var i = this.length - 1;i >= 0; i--) {
        var w = (this.words[i] | 0) + carry * 67108864;
        this.words[i] = w / num | 0;
        carry = w % num;
      }
      this._strip();
      return isNegNum ? this.ineg() : this;
    };
    BN.prototype.divn = function divn(num) {
      return this.clone().idivn(num);
    };
    BN.prototype.egcd = function egcd(p) {
      assert(p.negative === 0);
      assert(!p.isZero());
      var x = this;
      var y = p.clone();
      if (x.negative !== 0) {
        x = x.umod(p);
      } else {
        x = x.clone();
      }
      var A = new BN(1);
      var B = new BN(0);
      var C = new BN(0);
      var D = new BN(1);
      var g = 0;
      while (x.isEven() && y.isEven()) {
        x.iushrn(1);
        y.iushrn(1);
        ++g;
      }
      var yp = y.clone();
      var xp = x.clone();
      while (!x.isZero()) {
        for (var i = 0, im = 1;(x.words[0] & im) === 0 && i < 26; ++i, im <<= 1)
          ;
        if (i > 0) {
          x.iushrn(i);
          while (i-- > 0) {
            if (A.isOdd() || B.isOdd()) {
              A.iadd(yp);
              B.isub(xp);
            }
            A.iushrn(1);
            B.iushrn(1);
          }
        }
        for (var j = 0, jm = 1;(y.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1)
          ;
        if (j > 0) {
          y.iushrn(j);
          while (j-- > 0) {
            if (C.isOdd() || D.isOdd()) {
              C.iadd(yp);
              D.isub(xp);
            }
            C.iushrn(1);
            D.iushrn(1);
          }
        }
        if (x.cmp(y) >= 0) {
          x.isub(y);
          A.isub(C);
          B.isub(D);
        } else {
          y.isub(x);
          C.isub(A);
          D.isub(B);
        }
      }
      return {
        a: C,
        b: D,
        gcd: y.iushln(g)
      };
    };
    BN.prototype._invmp = function _invmp(p) {
      assert(p.negative === 0);
      assert(!p.isZero());
      var a = this;
      var b = p.clone();
      if (a.negative !== 0) {
        a = a.umod(p);
      } else {
        a = a.clone();
      }
      var x1 = new BN(1);
      var x2 = new BN(0);
      var delta = b.clone();
      while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
        for (var i = 0, im = 1;(a.words[0] & im) === 0 && i < 26; ++i, im <<= 1)
          ;
        if (i > 0) {
          a.iushrn(i);
          while (i-- > 0) {
            if (x1.isOdd()) {
              x1.iadd(delta);
            }
            x1.iushrn(1);
          }
        }
        for (var j = 0, jm = 1;(b.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1)
          ;
        if (j > 0) {
          b.iushrn(j);
          while (j-- > 0) {
            if (x2.isOdd()) {
              x2.iadd(delta);
            }
            x2.iushrn(1);
          }
        }
        if (a.cmp(b) >= 0) {
          a.isub(b);
          x1.isub(x2);
        } else {
          b.isub(a);
          x2.isub(x1);
        }
      }
      var res;
      if (a.cmpn(1) === 0) {
        res = x1;
      } else {
        res = x2;
      }
      if (res.cmpn(0) < 0) {
        res.iadd(p);
      }
      return res;
    };
    BN.prototype.gcd = function gcd(num) {
      if (this.isZero())
        return num.abs();
      if (num.isZero())
        return this.abs();
      var a = this.clone();
      var b = num.clone();
      a.negative = 0;
      b.negative = 0;
      for (var shift = 0;a.isEven() && b.isEven(); shift++) {
        a.iushrn(1);
        b.iushrn(1);
      }
      do {
        while (a.isEven()) {
          a.iushrn(1);
        }
        while (b.isEven()) {
          b.iushrn(1);
        }
        var r = a.cmp(b);
        if (r < 0) {
          var t = a;
          a = b;
          b = t;
        } else if (r === 0 || b.cmpn(1) === 0) {
          break;
        }
        a.isub(b);
      } while (true);
      return b.iushln(shift);
    };
    BN.prototype.invm = function invm(num) {
      return this.egcd(num).a.umod(num);
    };
    BN.prototype.isEven = function isEven() {
      return (this.words[0] & 1) === 0;
    };
    BN.prototype.isOdd = function isOdd() {
      return (this.words[0] & 1) === 1;
    };
    BN.prototype.andln = function andln(num) {
      return this.words[0] & num;
    };
    BN.prototype.bincn = function bincn(bit) {
      assert(typeof bit === "number");
      var r = bit % 26;
      var s = (bit - r) / 26;
      var q = 1 << r;
      if (this.length <= s) {
        this._expand(s + 1);
        this.words[s] |= q;
        return this;
      }
      var carry = q;
      for (var i = s;carry !== 0 && i < this.length; i++) {
        var w = this.words[i] | 0;
        w += carry;
        carry = w >>> 26;
        w &= 67108863;
        this.words[i] = w;
      }
      if (carry !== 0) {
        this.words[i] = carry;
        this.length++;
      }
      return this;
    };
    BN.prototype.isZero = function isZero() {
      return this.length === 1 && this.words[0] === 0;
    };
    BN.prototype.cmpn = function cmpn(num) {
      var negative = num < 0;
      if (this.negative !== 0 && !negative)
        return -1;
      if (this.negative === 0 && negative)
        return 1;
      this._strip();
      var res;
      if (this.length > 1) {
        res = 1;
      } else {
        if (negative) {
          num = -num;
        }
        assert(num <= 67108863, "Number is too big");
        var w = this.words[0] | 0;
        res = w === num ? 0 : w < num ? -1 : 1;
      }
      if (this.negative !== 0)
        return -res | 0;
      return res;
    };
    BN.prototype.cmp = function cmp(num) {
      if (this.negative !== 0 && num.negative === 0)
        return -1;
      if (this.negative === 0 && num.negative !== 0)
        return 1;
      var res = this.ucmp(num);
      if (this.negative !== 0)
        return -res | 0;
      return res;
    };
    BN.prototype.ucmp = function ucmp(num) {
      if (this.length > num.length)
        return 1;
      if (this.length < num.length)
        return -1;
      var res = 0;
      for (var i = this.length - 1;i >= 0; i--) {
        var a = this.words[i] | 0;
        var b = num.words[i] | 0;
        if (a === b)
          continue;
        if (a < b) {
          res = -1;
        } else if (a > b) {
          res = 1;
        }
        break;
      }
      return res;
    };
    BN.prototype.gtn = function gtn(num) {
      return this.cmpn(num) === 1;
    };
    BN.prototype.gt = function gt(num) {
      return this.cmp(num) === 1;
    };
    BN.prototype.gten = function gten(num) {
      return this.cmpn(num) >= 0;
    };
    BN.prototype.gte = function gte(num) {
      return this.cmp(num) >= 0;
    };
    BN.prototype.ltn = function ltn(num) {
      return this.cmpn(num) === -1;
    };
    BN.prototype.lt = function lt(num) {
      return this.cmp(num) === -1;
    };
    BN.prototype.lten = function lten(num) {
      return this.cmpn(num) <= 0;
    };
    BN.prototype.lte = function lte(num) {
      return this.cmp(num) <= 0;
    };
    BN.prototype.eqn = function eqn(num) {
      return this.cmpn(num) === 0;
    };
    BN.prototype.eq = function eq(num) {
      return this.cmp(num) === 0;
    };
    BN.red = function red(num) {
      return new Red(num);
    };
    BN.prototype.toRed = function toRed(ctx) {
      assert(!this.red, "Already a number in reduction context");
      assert(this.negative === 0, "red works only with positives");
      return ctx.convertTo(this)._forceRed(ctx);
    };
    BN.prototype.fromRed = function fromRed() {
      assert(this.red, "fromRed works only with numbers in reduction context");
      return this.red.convertFrom(this);
    };
    BN.prototype._forceRed = function _forceRed(ctx) {
      this.red = ctx;
      return this;
    };
    BN.prototype.forceRed = function forceRed(ctx) {
      assert(!this.red, "Already a number in reduction context");
      return this._forceRed(ctx);
    };
    BN.prototype.redAdd = function redAdd(num) {
      assert(this.red, "redAdd works only with red numbers");
      return this.red.add(this, num);
    };
    BN.prototype.redIAdd = function redIAdd(num) {
      assert(this.red, "redIAdd works only with red numbers");
      return this.red.iadd(this, num);
    };
    BN.prototype.redSub = function redSub(num) {
      assert(this.red, "redSub works only with red numbers");
      return this.red.sub(this, num);
    };
    BN.prototype.redISub = function redISub(num) {
      assert(this.red, "redISub works only with red numbers");
      return this.red.isub(this, num);
    };
    BN.prototype.redShl = function redShl(num) {
      assert(this.red, "redShl works only with red numbers");
      return this.red.shl(this, num);
    };
    BN.prototype.redMul = function redMul(num) {
      assert(this.red, "redMul works only with red numbers");
      this.red._verify2(this, num);
      return this.red.mul(this, num);
    };
    BN.prototype.redIMul = function redIMul(num) {
      assert(this.red, "redMul works only with red numbers");
      this.red._verify2(this, num);
      return this.red.imul(this, num);
    };
    BN.prototype.redSqr = function redSqr() {
      assert(this.red, "redSqr works only with red numbers");
      this.red._verify1(this);
      return this.red.sqr(this);
    };
    BN.prototype.redISqr = function redISqr() {
      assert(this.red, "redISqr works only with red numbers");
      this.red._verify1(this);
      return this.red.isqr(this);
    };
    BN.prototype.redSqrt = function redSqrt() {
      assert(this.red, "redSqrt works only with red numbers");
      this.red._verify1(this);
      return this.red.sqrt(this);
    };
    BN.prototype.redInvm = function redInvm() {
      assert(this.red, "redInvm works only with red numbers");
      this.red._verify1(this);
      return this.red.invm(this);
    };
    BN.prototype.redNeg = function redNeg() {
      assert(this.red, "redNeg works only with red numbers");
      this.red._verify1(this);
      return this.red.neg(this);
    };
    BN.prototype.redPow = function redPow(num) {
      assert(this.red && !num.red, "redPow(normalNum)");
      this.red._verify1(this);
      return this.red.pow(this, num);
    };
    var primes = {
      k256: null,
      p224: null,
      p192: null,
      p25519: null
    };
    function MPrime(name, p) {
      this.name = name;
      this.p = new BN(p, 16);
      this.n = this.p.bitLength();
      this.k = new BN(1).iushln(this.n).isub(this.p);
      this.tmp = this._tmp();
    }
    MPrime.prototype._tmp = function _tmp() {
      var tmp = new BN(null);
      tmp.words = new Array(Math.ceil(this.n / 13));
      return tmp;
    };
    MPrime.prototype.ireduce = function ireduce(num) {
      var r = num;
      var rlen;
      do {
        this.split(r, this.tmp);
        r = this.imulK(r);
        r = r.iadd(this.tmp);
        rlen = r.bitLength();
      } while (rlen > this.n);
      var cmp = rlen < this.n ? -1 : r.ucmp(this.p);
      if (cmp === 0) {
        r.words[0] = 0;
        r.length = 1;
      } else if (cmp > 0) {
        r.isub(this.p);
      } else {
        if (r.strip !== undefined) {
          r.strip();
        } else {
          r._strip();
        }
      }
      return r;
    };
    MPrime.prototype.split = function split(input, out) {
      input.iushrn(this.n, 0, out);
    };
    MPrime.prototype.imulK = function imulK(num) {
      return num.imul(this.k);
    };
    function K256() {
      MPrime.call(this, "k256", "ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f");
    }
    inherits(K256, MPrime);
    K256.prototype.split = function split(input, output) {
      var mask = 4194303;
      var outLen = Math.min(input.length, 9);
      for (var i = 0;i < outLen; i++) {
        output.words[i] = input.words[i];
      }
      output.length = outLen;
      if (input.length <= 9) {
        input.words[0] = 0;
        input.length = 1;
        return;
      }
      var prev = input.words[9];
      output.words[output.length++] = prev & mask;
      for (i = 10;i < input.length; i++) {
        var next = input.words[i] | 0;
        input.words[i - 10] = (next & mask) << 4 | prev >>> 22;
        prev = next;
      }
      prev >>>= 22;
      input.words[i - 10] = prev;
      if (prev === 0 && input.length > 10) {
        input.length -= 10;
      } else {
        input.length -= 9;
      }
    };
    K256.prototype.imulK = function imulK(num) {
      num.words[num.length] = 0;
      num.words[num.length + 1] = 0;
      num.length += 2;
      var lo = 0;
      for (var i = 0;i < num.length; i++) {
        var w = num.words[i] | 0;
        lo += w * 977;
        num.words[i] = lo & 67108863;
        lo = w * 64 + (lo / 67108864 | 0);
      }
      if (num.words[num.length - 1] === 0) {
        num.length--;
        if (num.words[num.length - 1] === 0) {
          num.length--;
        }
      }
      return num;
    };
    function P224() {
      MPrime.call(this, "p224", "ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001");
    }
    inherits(P224, MPrime);
    function P192() {
      MPrime.call(this, "p192", "ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff");
    }
    inherits(P192, MPrime);
    function P25519() {
      MPrime.call(this, "25519", "7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed");
    }
    inherits(P25519, MPrime);
    P25519.prototype.imulK = function imulK(num) {
      var carry = 0;
      for (var i = 0;i < num.length; i++) {
        var hi = (num.words[i] | 0) * 19 + carry;
        var lo = hi & 67108863;
        hi >>>= 26;
        num.words[i] = lo;
        carry = hi;
      }
      if (carry !== 0) {
        num.words[num.length++] = carry;
      }
      return num;
    };
    BN._prime = function prime(name) {
      if (primes[name])
        return primes[name];
      var prime;
      if (name === "k256") {
        prime = new K256;
      } else if (name === "p224") {
        prime = new P224;
      } else if (name === "p192") {
        prime = new P192;
      } else if (name === "p25519") {
        prime = new P25519;
      } else {
        throw new Error("Unknown prime " + name);
      }
      primes[name] = prime;
      return prime;
    };
    function Red(m) {
      if (typeof m === "string") {
        var prime = BN._prime(m);
        this.m = prime.p;
        this.prime = prime;
      } else {
        assert(m.gtn(1), "modulus must be greater than 1");
        this.m = m;
        this.prime = null;
      }
    }
    Red.prototype._verify1 = function _verify1(a) {
      assert(a.negative === 0, "red works only with positives");
      assert(a.red, "red works only with red numbers");
    };
    Red.prototype._verify2 = function _verify2(a, b) {
      assert((a.negative | b.negative) === 0, "red works only with positives");
      assert(a.red && a.red === b.red, "red works only with red numbers");
    };
    Red.prototype.imod = function imod(a) {
      if (this.prime)
        return this.prime.ireduce(a)._forceRed(this);
      move(a, a.umod(this.m)._forceRed(this));
      return a;
    };
    Red.prototype.neg = function neg(a) {
      if (a.isZero()) {
        return a.clone();
      }
      return this.m.sub(a)._forceRed(this);
    };
    Red.prototype.add = function add(a, b) {
      this._verify2(a, b);
      var res = a.add(b);
      if (res.cmp(this.m) >= 0) {
        res.isub(this.m);
      }
      return res._forceRed(this);
    };
    Red.prototype.iadd = function iadd(a, b) {
      this._verify2(a, b);
      var res = a.iadd(b);
      if (res.cmp(this.m) >= 0) {
        res.isub(this.m);
      }
      return res;
    };
    Red.prototype.sub = function sub(a, b) {
      this._verify2(a, b);
      var res = a.sub(b);
      if (res.cmpn(0) < 0) {
        res.iadd(this.m);
      }
      return res._forceRed(this);
    };
    Red.prototype.isub = function isub(a, b) {
      this._verify2(a, b);
      var res = a.isub(b);
      if (res.cmpn(0) < 0) {
        res.iadd(this.m);
      }
      return res;
    };
    Red.prototype.shl = function shl(a, num) {
      this._verify1(a);
      return this.imod(a.ushln(num));
    };
    Red.prototype.imul = function imul(a, b) {
      this._verify2(a, b);
      return this.imod(a.imul(b));
    };
    Red.prototype.mul = function mul(a, b) {
      this._verify2(a, b);
      return this.imod(a.mul(b));
    };
    Red.prototype.isqr = function isqr(a) {
      return this.imul(a, a.clone());
    };
    Red.prototype.sqr = function sqr(a) {
      return this.mul(a, a);
    };
    Red.prototype.sqrt = function sqrt(a) {
      if (a.isZero())
        return a.clone();
      var mod3 = this.m.andln(3);
      assert(mod3 % 2 === 1);
      if (mod3 === 3) {
        var pow = this.m.add(new BN(1)).iushrn(2);
        return this.pow(a, pow);
      }
      var q = this.m.subn(1);
      var s = 0;
      while (!q.isZero() && q.andln(1) === 0) {
        s++;
        q.iushrn(1);
      }
      assert(!q.isZero());
      var one = new BN(1).toRed(this);
      var nOne = one.redNeg();
      var lpow = this.m.subn(1).iushrn(1);
      var z = this.m.bitLength();
      z = new BN(2 * z * z).toRed(this);
      while (this.pow(z, lpow).cmp(nOne) !== 0) {
        z.redIAdd(nOne);
      }
      var c = this.pow(z, q);
      var r = this.pow(a, q.addn(1).iushrn(1));
      var t = this.pow(a, q);
      var m = s;
      while (t.cmp(one) !== 0) {
        var tmp = t;
        for (var i = 0;tmp.cmp(one) !== 0; i++) {
          tmp = tmp.redSqr();
        }
        assert(i < m);
        var b = this.pow(c, new BN(1).iushln(m - i - 1));
        r = r.redMul(b);
        c = b.redSqr();
        t = t.redMul(c);
        m = i;
      }
      return r;
    };
    Red.prototype.invm = function invm(a) {
      var inv = a._invmp(this.m);
      if (inv.negative !== 0) {
        inv.negative = 0;
        return this.imod(inv).redNeg();
      } else {
        return this.imod(inv);
      }
    };
    Red.prototype.pow = function pow(a, num) {
      if (num.isZero())
        return new BN(1).toRed(this);
      if (num.cmpn(1) === 0)
        return a.clone();
      var windowSize = 4;
      var wnd = new Array(1 << windowSize);
      wnd[0] = new BN(1).toRed(this);
      wnd[1] = a;
      for (var i = 2;i < wnd.length; i++) {
        wnd[i] = this.mul(wnd[i - 1], a);
      }
      var res = wnd[0];
      var current = 0;
      var currentLen = 0;
      var start = num.bitLength() % 26;
      if (start === 0) {
        start = 26;
      }
      for (i = num.length - 1;i >= 0; i--) {
        var word = num.words[i];
        for (var j = start - 1;j >= 0; j--) {
          var bit = word >> j & 1;
          if (res !== wnd[0]) {
            res = this.sqr(res);
          }
          if (bit === 0 && current === 0) {
            currentLen = 0;
            continue;
          }
          current <<= 1;
          current |= bit;
          currentLen++;
          if (currentLen !== windowSize && (i !== 0 || j !== 0))
            continue;
          res = this.mul(res, wnd[current]);
          currentLen = 0;
          current = 0;
        }
        start = 26;
      }
      return res;
    };
    Red.prototype.convertTo = function convertTo(num) {
      var r = num.umod(this.m);
      return r === num ? r.clone() : r;
    };
    Red.prototype.convertFrom = function convertFrom(num) {
      var res = num.clone();
      res.red = null;
      return res;
    };
    BN.mont = function mont(num) {
      return new Mont(num);
    };
    function Mont(m) {
      Red.call(this, m);
      this.shift = this.m.bitLength();
      if (this.shift % 26 !== 0) {
        this.shift += 26 - this.shift % 26;
      }
      this.r = new BN(1).iushln(this.shift);
      this.r2 = this.imod(this.r.sqr());
      this.rinv = this.r._invmp(this.m);
      this.minv = this.rinv.mul(this.r).isubn(1).div(this.m);
      this.minv = this.minv.umod(this.r);
      this.minv = this.r.sub(this.minv);
    }
    inherits(Mont, Red);
    Mont.prototype.convertTo = function convertTo(num) {
      return this.imod(num.ushln(this.shift));
    };
    Mont.prototype.convertFrom = function convertFrom(num) {
      var r = this.imod(num.mul(this.rinv));
      r.red = null;
      return r;
    };
    Mont.prototype.imul = function imul(a, b) {
      if (a.isZero() || b.isZero()) {
        a.words[0] = 0;
        a.length = 1;
        return a;
      }
      var t = a.imul(b);
      var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
      var u = t.isub(c).iushrn(this.shift);
      var res = u;
      if (u.cmp(this.m) >= 0) {
        res = u.isub(this.m);
      } else if (u.cmpn(0) < 0) {
        res = u.iadd(this.m);
      }
      return res._forceRed(this);
    };
    Mont.prototype.mul = function mul(a, b) {
      if (a.isZero() || b.isZero())
        return new BN(0)._forceRed(this);
      var t = a.mul(b);
      var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
      var u = t.isub(c).iushrn(this.shift);
      var res = u;
      if (u.cmp(this.m) >= 0) {
        res = u.isub(this.m);
      } else if (u.cmpn(0) < 0) {
        res = u.iadd(this.m);
      }
      return res._forceRed(this);
    };
    Mont.prototype.invm = function invm(a) {
      var res = this.imod(a._invmp(this.m).mul(this.r2));
      return res._forceRed(this);
    };
  })(typeof module === "undefined" || module, exports);
});

// ../../node_modules/.bun/safe-buffer@5.2.1/node_modules/safe-buffer/index.js
var require_safe_buffer = __commonJS(function(exports, module) {
  /*! safe-buffer. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
  var buffer = (init_buffer(), __toCommonJS(exports_buffer));
  var Buffer2 = buffer.Buffer;
  function copyProps(src, dst) {
    for (var key in src) {
      dst[key] = src[key];
    }
  }
  if (Buffer2.from && Buffer2.alloc && Buffer2.allocUnsafe && Buffer2.allocUnsafeSlow) {
    module.exports = buffer;
  } else {
    copyProps(buffer, exports);
    exports.Buffer = SafeBuffer;
  }
  function SafeBuffer(arg, encodingOrOffset, length) {
    return Buffer2(arg, encodingOrOffset, length);
  }
  SafeBuffer.prototype = Object.create(Buffer2.prototype);
  copyProps(Buffer2, SafeBuffer);
  SafeBuffer.from = function(arg, encodingOrOffset, length) {
    if (typeof arg === "number") {
      throw new TypeError("Argument must not be a number");
    }
    return Buffer2(arg, encodingOrOffset, length);
  };
  SafeBuffer.alloc = function(size, fill, encoding) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    var buf = Buffer2(size);
    if (fill !== undefined) {
      if (typeof encoding === "string") {
        buf.fill(fill, encoding);
      } else {
        buf.fill(fill);
      }
    } else {
      buf.fill(0);
    }
    return buf;
  };
  SafeBuffer.allocUnsafe = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return Buffer2(size);
  };
  SafeBuffer.allocUnsafeSlow = function(size) {
    if (typeof size !== "number") {
      throw new TypeError("Argument must be a number");
    }
    return buffer.SlowBuffer(size);
  };
});

// ../../node_modules/.bun/base-x@3.0.11/node_modules/base-x/src/index.js
var require_src = __commonJS(function(exports, module) {
  var _Buffer = require_safe_buffer().Buffer;
  function base(ALPHABET) {
    if (ALPHABET.length >= 255) {
      throw new TypeError("Alphabet too long");
    }
    var BASE_MAP = new Uint8Array(256);
    for (var j = 0;j < BASE_MAP.length; j++) {
      BASE_MAP[j] = 255;
    }
    for (var i = 0;i < ALPHABET.length; i++) {
      var x = ALPHABET.charAt(i);
      var xc = x.charCodeAt(0);
      if (BASE_MAP[xc] !== 255) {
        throw new TypeError(x + " is ambiguous");
      }
      BASE_MAP[xc] = i;
    }
    var BASE = ALPHABET.length;
    var LEADER = ALPHABET.charAt(0);
    var FACTOR = Math.log(BASE) / Math.log(256);
    var iFACTOR = Math.log(256) / Math.log(BASE);
    function encode(source) {
      if (Array.isArray(source) || source instanceof Uint8Array) {
        source = _Buffer.from(source);
      }
      if (!_Buffer.isBuffer(source)) {
        throw new TypeError("Expected Buffer");
      }
      if (source.length === 0) {
        return "";
      }
      var zeroes = 0;
      var length = 0;
      var pbegin = 0;
      var pend = source.length;
      while (pbegin !== pend && source[pbegin] === 0) {
        pbegin++;
        zeroes++;
      }
      var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
      var b58 = new Uint8Array(size);
      while (pbegin !== pend) {
        var carry = source[pbegin];
        var i = 0;
        for (var it1 = size - 1;(carry !== 0 || i < length) && it1 !== -1; it1--, i++) {
          carry += 256 * b58[it1] >>> 0;
          b58[it1] = carry % BASE >>> 0;
          carry = carry / BASE >>> 0;
        }
        if (carry !== 0) {
          throw new Error("Non-zero carry");
        }
        length = i;
        pbegin++;
      }
      var it2 = size - length;
      while (it2 !== size && b58[it2] === 0) {
        it2++;
      }
      var str = LEADER.repeat(zeroes);
      for (;it2 < size; ++it2) {
        str += ALPHABET.charAt(b58[it2]);
      }
      return str;
    }
    function decodeUnsafe(source) {
      if (typeof source !== "string") {
        throw new TypeError("Expected String");
      }
      if (source.length === 0) {
        return _Buffer.alloc(0);
      }
      var psz = 0;
      var zeroes = 0;
      var length = 0;
      while (source[psz] === LEADER) {
        zeroes++;
        psz++;
      }
      var size = (source.length - psz) * FACTOR + 1 >>> 0;
      var b256 = new Uint8Array(size);
      while (psz < source.length) {
        var charCode = source.charCodeAt(psz);
        if (charCode > 255) {
          return;
        }
        var carry = BASE_MAP[charCode];
        if (carry === 255) {
          return;
        }
        var i = 0;
        for (var it3 = size - 1;(carry !== 0 || i < length) && it3 !== -1; it3--, i++) {
          carry += BASE * b256[it3] >>> 0;
          b256[it3] = carry % 256 >>> 0;
          carry = carry / 256 >>> 0;
        }
        if (carry !== 0) {
          throw new Error("Non-zero carry");
        }
        length = i;
        psz++;
      }
      var it4 = size - length;
      while (it4 !== size && b256[it4] === 0) {
        it4++;
      }
      var vch = _Buffer.allocUnsafe(zeroes + (size - it4));
      vch.fill(0, 0, zeroes);
      var j = zeroes;
      while (it4 !== size) {
        vch[j++] = b256[it4++];
      }
      return vch;
    }
    function decode(string) {
      var buffer = decodeUnsafe(string);
      if (buffer) {
        return buffer;
      }
      throw new Error("Non-base" + BASE + " character");
    }
    return {
      encode,
      decodeUnsafe,
      decode
    };
  }
  module.exports = base;
});

// ../../node_modules/.bun/bs58@4.0.1/node_modules/bs58/index.js
var require_bs58 = __commonJS(function(exports, module) {
  var basex = require_src();
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  module.exports = basex(ALPHABET);
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha256.js
var sha2562;
var init_sha256 = __esm(() => {
  init_sha2();
  sha2562 = sha256;
});

// ../../node_modules/.bun/text-encoding-utf-8@1.0.2/node_modules/text-encoding-utf-8/lib/encoding.lib.js
var require_encoding_lib = __commonJS(function(exports) {
  function inRange(a, min, max) {
    return min <= a && a <= max;
  }
  function ToDictionary(o) {
    if (o === undefined)
      return {};
    if (o === Object(o))
      return o;
    throw TypeError("Could not convert argument to dictionary");
  }
  function stringToCodePoints(string) {
    var s = String(string);
    var n = s.length;
    var i = 0;
    var u = [];
    while (i < n) {
      var c = s.charCodeAt(i);
      if (c < 55296 || c > 57343) {
        u.push(c);
      } else if (56320 <= c && c <= 57343) {
        u.push(65533);
      } else if (55296 <= c && c <= 56319) {
        if (i === n - 1) {
          u.push(65533);
        } else {
          var d = string.charCodeAt(i + 1);
          if (56320 <= d && d <= 57343) {
            var a = c & 1023;
            var b = d & 1023;
            u.push(65536 + (a << 10) + b);
            i += 1;
          } else {
            u.push(65533);
          }
        }
      }
      i += 1;
    }
    return u;
  }
  function codePointsToString(code_points) {
    var s = "";
    for (var i = 0;i < code_points.length; ++i) {
      var cp = code_points[i];
      if (cp <= 65535) {
        s += String.fromCharCode(cp);
      } else {
        cp -= 65536;
        s += String.fromCharCode((cp >> 10) + 55296, (cp & 1023) + 56320);
      }
    }
    return s;
  }
  var end_of_stream = -1;
  function Stream(tokens) {
    this.tokens = [].slice.call(tokens);
  }
  Stream.prototype = {
    endOfStream: function() {
      return !this.tokens.length;
    },
    read: function() {
      if (!this.tokens.length)
        return end_of_stream;
      return this.tokens.shift();
    },
    prepend: function(token) {
      if (Array.isArray(token)) {
        var tokens = token;
        while (tokens.length)
          this.tokens.unshift(tokens.pop());
      } else {
        this.tokens.unshift(token);
      }
    },
    push: function(token) {
      if (Array.isArray(token)) {
        var tokens = token;
        while (tokens.length)
          this.tokens.push(tokens.shift());
      } else {
        this.tokens.push(token);
      }
    }
  };
  var finished = -1;
  function decoderError(fatal, opt_code_point) {
    if (fatal)
      throw TypeError("Decoder error");
    return opt_code_point || 65533;
  }
  var DEFAULT_ENCODING = "utf-8";
  function TextDecoder2(encoding, options) {
    if (!(this instanceof TextDecoder2)) {
      return new TextDecoder2(encoding, options);
    }
    encoding = encoding !== undefined ? String(encoding).toLowerCase() : DEFAULT_ENCODING;
    if (encoding !== DEFAULT_ENCODING) {
      throw new Error("Encoding not supported. Only utf-8 is supported");
    }
    options = ToDictionary(options);
    this._streaming = false;
    this._BOMseen = false;
    this._decoder = null;
    this._fatal = Boolean(options["fatal"]);
    this._ignoreBOM = Boolean(options["ignoreBOM"]);
    Object.defineProperty(this, "encoding", { value: "utf-8" });
    Object.defineProperty(this, "fatal", { value: this._fatal });
    Object.defineProperty(this, "ignoreBOM", { value: this._ignoreBOM });
  }
  TextDecoder2.prototype = {
    decode: function decode(input, options) {
      var bytes;
      if (typeof input === "object" && input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else if (typeof input === "object" && "buffer" in input && input.buffer instanceof ArrayBuffer) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else {
        bytes = new Uint8Array(0);
      }
      options = ToDictionary(options);
      if (!this._streaming) {
        this._decoder = new UTF8Decoder({ fatal: this._fatal });
        this._BOMseen = false;
      }
      this._streaming = Boolean(options["stream"]);
      var input_stream = new Stream(bytes);
      var code_points = [];
      var result;
      while (!input_stream.endOfStream()) {
        result = this._decoder.handler(input_stream, input_stream.read());
        if (result === finished)
          break;
        if (result === null)
          continue;
        if (Array.isArray(result))
          code_points.push.apply(code_points, result);
        else
          code_points.push(result);
      }
      if (!this._streaming) {
        do {
          result = this._decoder.handler(input_stream, input_stream.read());
          if (result === finished)
            break;
          if (result === null)
            continue;
          if (Array.isArray(result))
            code_points.push.apply(code_points, result);
          else
            code_points.push(result);
        } while (!input_stream.endOfStream());
        this._decoder = null;
      }
      if (code_points.length) {
        if (["utf-8"].indexOf(this.encoding) !== -1 && !this._ignoreBOM && !this._BOMseen) {
          if (code_points[0] === 65279) {
            this._BOMseen = true;
            code_points.shift();
          } else {
            this._BOMseen = true;
          }
        }
      }
      return codePointsToString(code_points);
    }
  };
  function TextEncoder2(encoding, options) {
    if (!(this instanceof TextEncoder2))
      return new TextEncoder2(encoding, options);
    encoding = encoding !== undefined ? String(encoding).toLowerCase() : DEFAULT_ENCODING;
    if (encoding !== DEFAULT_ENCODING) {
      throw new Error("Encoding not supported. Only utf-8 is supported");
    }
    options = ToDictionary(options);
    this._streaming = false;
    this._encoder = null;
    this._options = { fatal: Boolean(options["fatal"]) };
    Object.defineProperty(this, "encoding", { value: "utf-8" });
  }
  TextEncoder2.prototype = {
    encode: function encode(opt_string, options) {
      opt_string = opt_string ? String(opt_string) : "";
      options = ToDictionary(options);
      if (!this._streaming)
        this._encoder = new UTF8Encoder(this._options);
      this._streaming = Boolean(options["stream"]);
      var bytes = [];
      var input_stream = new Stream(stringToCodePoints(opt_string));
      var result;
      while (!input_stream.endOfStream()) {
        result = this._encoder.handler(input_stream, input_stream.read());
        if (result === finished)
          break;
        if (Array.isArray(result))
          bytes.push.apply(bytes, result);
        else
          bytes.push(result);
      }
      if (!this._streaming) {
        while (true) {
          result = this._encoder.handler(input_stream, input_stream.read());
          if (result === finished)
            break;
          if (Array.isArray(result))
            bytes.push.apply(bytes, result);
          else
            bytes.push(result);
        }
        this._encoder = null;
      }
      return new Uint8Array(bytes);
    }
  };
  function UTF8Decoder(options) {
    var fatal = options.fatal;
    var utf8_code_point = 0, utf8_bytes_seen = 0, utf8_bytes_needed = 0, utf8_lower_boundary = 128, utf8_upper_boundary = 191;
    this.handler = function(stream, bite) {
      if (bite === end_of_stream && utf8_bytes_needed !== 0) {
        utf8_bytes_needed = 0;
        return decoderError(fatal);
      }
      if (bite === end_of_stream)
        return finished;
      if (utf8_bytes_needed === 0) {
        if (inRange(bite, 0, 127)) {
          return bite;
        }
        if (inRange(bite, 194, 223)) {
          utf8_bytes_needed = 1;
          utf8_code_point = bite - 192;
        } else if (inRange(bite, 224, 239)) {
          if (bite === 224)
            utf8_lower_boundary = 160;
          if (bite === 237)
            utf8_upper_boundary = 159;
          utf8_bytes_needed = 2;
          utf8_code_point = bite - 224;
        } else if (inRange(bite, 240, 244)) {
          if (bite === 240)
            utf8_lower_boundary = 144;
          if (bite === 244)
            utf8_upper_boundary = 143;
          utf8_bytes_needed = 3;
          utf8_code_point = bite - 240;
        } else {
          return decoderError(fatal);
        }
        utf8_code_point = utf8_code_point << 6 * utf8_bytes_needed;
        return null;
      }
      if (!inRange(bite, utf8_lower_boundary, utf8_upper_boundary)) {
        utf8_code_point = utf8_bytes_needed = utf8_bytes_seen = 0;
        utf8_lower_boundary = 128;
        utf8_upper_boundary = 191;
        stream.prepend(bite);
        return decoderError(fatal);
      }
      utf8_lower_boundary = 128;
      utf8_upper_boundary = 191;
      utf8_bytes_seen += 1;
      utf8_code_point += bite - 128 << 6 * (utf8_bytes_needed - utf8_bytes_seen);
      if (utf8_bytes_seen !== utf8_bytes_needed)
        return null;
      var code_point = utf8_code_point;
      utf8_code_point = utf8_bytes_needed = utf8_bytes_seen = 0;
      return code_point;
    };
  }
  function UTF8Encoder(options) {
    var fatal = options.fatal;
    this.handler = function(stream, code_point) {
      if (code_point === end_of_stream)
        return finished;
      if (inRange(code_point, 0, 127))
        return code_point;
      var count, offset;
      if (inRange(code_point, 128, 2047)) {
        count = 1;
        offset = 192;
      } else if (inRange(code_point, 2048, 65535)) {
        count = 2;
        offset = 224;
      } else if (inRange(code_point, 65536, 1114111)) {
        count = 3;
        offset = 240;
      }
      var bytes = [(code_point >> 6 * count) + offset];
      while (count > 0) {
        var temp = code_point >> 6 * (count - 1);
        bytes.push(128 | temp & 63);
        count -= 1;
      }
      return bytes;
    };
  }
  exports.TextEncoder = TextEncoder2;
  exports.TextDecoder = TextDecoder2;
});

// ../../node_modules/.bun/borsh@0.7.0/node_modules/borsh/lib/index.js
var require_lib = __commonJS(function(exports) {
  var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() {
      return m[k];
    } });
  } : function(o, m, k, k2) {
    if (k2 === undefined)
      k2 = k;
    o[k2] = m[k];
  });
  var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
  } : function(o, v) {
    o["default"] = v;
  });
  var __decorate = exports && exports.__decorate || function(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function")
      r = Reflect.decorate(decorators, target, key, desc);
    else
      for (var i = decorators.length - 1;i >= 0; i--)
        if (d = decorators[i])
          r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
  };
  var __importStar = exports && exports.__importStar || function(mod) {
    if (mod && mod.__esModule)
      return mod;
    var result = {};
    if (mod != null) {
      for (var k in mod)
        if (k !== "default" && Object.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k);
    }
    __setModuleDefault(result, mod);
    return result;
  };
  var __importDefault = exports && exports.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.deserializeUnchecked = exports.deserialize = exports.serialize = exports.BinaryReader = exports.BinaryWriter = exports.BorshError = exports.baseDecode = exports.baseEncode = undefined;
  var bn_js_1 = __importDefault(require_bn());
  var bs58_1 = __importDefault(require_bs58());
  var encoding = __importStar(require_encoding_lib());
  var ResolvedTextDecoder = typeof TextDecoder !== "function" ? encoding.TextDecoder : TextDecoder;
  var textDecoder = new ResolvedTextDecoder("utf-8", { fatal: true });
  function baseEncode(value) {
    if (typeof value === "string") {
      value = Buffer.from(value, "utf8");
    }
    return bs58_1.default.encode(Buffer.from(value));
  }
  exports.baseEncode = baseEncode;
  function baseDecode(value) {
    return Buffer.from(bs58_1.default.decode(value));
  }
  exports.baseDecode = baseDecode;
  var INITIAL_LENGTH = 1024;

  class BorshError extends Error {
    constructor(message) {
      super(message);
      this.fieldPath = [];
      this.originalMessage = message;
    }
    addToFieldPath(fieldName) {
      this.fieldPath.splice(0, 0, fieldName);
      this.message = this.originalMessage + ": " + this.fieldPath.join(".");
    }
  }
  exports.BorshError = BorshError;

  class BinaryWriter {
    constructor() {
      this.buf = Buffer.alloc(INITIAL_LENGTH);
      this.length = 0;
    }
    maybeResize() {
      if (this.buf.length < 16 + this.length) {
        this.buf = Buffer.concat([this.buf, Buffer.alloc(INITIAL_LENGTH)]);
      }
    }
    writeU8(value) {
      this.maybeResize();
      this.buf.writeUInt8(value, this.length);
      this.length += 1;
    }
    writeU16(value) {
      this.maybeResize();
      this.buf.writeUInt16LE(value, this.length);
      this.length += 2;
    }
    writeU32(value) {
      this.maybeResize();
      this.buf.writeUInt32LE(value, this.length);
      this.length += 4;
    }
    writeU64(value) {
      this.maybeResize();
      this.writeBuffer(Buffer.from(new bn_js_1.default(value).toArray("le", 8)));
    }
    writeU128(value) {
      this.maybeResize();
      this.writeBuffer(Buffer.from(new bn_js_1.default(value).toArray("le", 16)));
    }
    writeU256(value) {
      this.maybeResize();
      this.writeBuffer(Buffer.from(new bn_js_1.default(value).toArray("le", 32)));
    }
    writeU512(value) {
      this.maybeResize();
      this.writeBuffer(Buffer.from(new bn_js_1.default(value).toArray("le", 64)));
    }
    writeBuffer(buffer) {
      this.buf = Buffer.concat([
        Buffer.from(this.buf.subarray(0, this.length)),
        buffer,
        Buffer.alloc(INITIAL_LENGTH)
      ]);
      this.length += buffer.length;
    }
    writeString(str) {
      this.maybeResize();
      const b = Buffer.from(str, "utf8");
      this.writeU32(b.length);
      this.writeBuffer(b);
    }
    writeFixedArray(array) {
      this.writeBuffer(Buffer.from(array));
    }
    writeArray(array, fn) {
      this.maybeResize();
      this.writeU32(array.length);
      for (const elem of array) {
        this.maybeResize();
        fn(elem);
      }
    }
    toArray() {
      return this.buf.subarray(0, this.length);
    }
  }
  exports.BinaryWriter = BinaryWriter;
  function handlingRangeError(target, propertyKey, propertyDescriptor) {
    const originalMethod = propertyDescriptor.value;
    propertyDescriptor.value = function(...args) {
      try {
        return originalMethod.apply(this, args);
      } catch (e) {
        if (e instanceof RangeError) {
          const code = e.code;
          if (["ERR_BUFFER_OUT_OF_BOUNDS", "ERR_OUT_OF_RANGE"].indexOf(code) >= 0) {
            throw new BorshError("Reached the end of buffer when deserializing");
          }
        }
        throw e;
      }
    };
  }

  class BinaryReader {
    constructor(buf) {
      this.buf = buf;
      this.offset = 0;
    }
    readU8() {
      const value = this.buf.readUInt8(this.offset);
      this.offset += 1;
      return value;
    }
    readU16() {
      const value = this.buf.readUInt16LE(this.offset);
      this.offset += 2;
      return value;
    }
    readU32() {
      const value = this.buf.readUInt32LE(this.offset);
      this.offset += 4;
      return value;
    }
    readU64() {
      const buf = this.readBuffer(8);
      return new bn_js_1.default(buf, "le");
    }
    readU128() {
      const buf = this.readBuffer(16);
      return new bn_js_1.default(buf, "le");
    }
    readU256() {
      const buf = this.readBuffer(32);
      return new bn_js_1.default(buf, "le");
    }
    readU512() {
      const buf = this.readBuffer(64);
      return new bn_js_1.default(buf, "le");
    }
    readBuffer(len) {
      if (this.offset + len > this.buf.length) {
        throw new BorshError(`Expected buffer length ${len} isn't within bounds`);
      }
      const result = this.buf.slice(this.offset, this.offset + len);
      this.offset += len;
      return result;
    }
    readString() {
      const len = this.readU32();
      const buf = this.readBuffer(len);
      try {
        return textDecoder.decode(buf);
      } catch (e) {
        throw new BorshError(`Error decoding UTF-8 string: ${e}`);
      }
    }
    readFixedArray(len) {
      return new Uint8Array(this.readBuffer(len));
    }
    readArray(fn) {
      const len = this.readU32();
      const result = Array();
      for (let i = 0;i < len; ++i) {
        result.push(fn());
      }
      return result;
    }
  }
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU8", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU16", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU32", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU64", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU128", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU256", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readU512", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readString", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readFixedArray", null);
  __decorate([
    handlingRangeError
  ], BinaryReader.prototype, "readArray", null);
  exports.BinaryReader = BinaryReader;
  function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
  }
  function serializeField(schema, fieldName, value, fieldType, writer) {
    try {
      if (typeof fieldType === "string") {
        writer[`write${capitalizeFirstLetter(fieldType)}`](value);
      } else if (fieldType instanceof Array) {
        if (typeof fieldType[0] === "number") {
          if (value.length !== fieldType[0]) {
            throw new BorshError(`Expecting byte array of length ${fieldType[0]}, but got ${value.length} bytes`);
          }
          writer.writeFixedArray(value);
        } else if (fieldType.length === 2 && typeof fieldType[1] === "number") {
          if (value.length !== fieldType[1]) {
            throw new BorshError(`Expecting byte array of length ${fieldType[1]}, but got ${value.length} bytes`);
          }
          for (let i = 0;i < fieldType[1]; i++) {
            serializeField(schema, null, value[i], fieldType[0], writer);
          }
        } else {
          writer.writeArray(value, (item) => {
            serializeField(schema, fieldName, item, fieldType[0], writer);
          });
        }
      } else if (fieldType.kind !== undefined) {
        switch (fieldType.kind) {
          case "option": {
            if (value === null || value === undefined) {
              writer.writeU8(0);
            } else {
              writer.writeU8(1);
              serializeField(schema, fieldName, value, fieldType.type, writer);
            }
            break;
          }
          case "map": {
            writer.writeU32(value.size);
            value.forEach((val, key) => {
              serializeField(schema, fieldName, key, fieldType.key, writer);
              serializeField(schema, fieldName, val, fieldType.value, writer);
            });
            break;
          }
          default:
            throw new BorshError(`FieldType ${fieldType} unrecognized`);
        }
      } else {
        serializeStruct(schema, value, writer);
      }
    } catch (error) {
      if (error instanceof BorshError) {
        error.addToFieldPath(fieldName);
      }
      throw error;
    }
  }
  function serializeStruct(schema, obj, writer) {
    if (typeof obj.borshSerialize === "function") {
      obj.borshSerialize(writer);
      return;
    }
    const structSchema = schema.get(obj.constructor);
    if (!structSchema) {
      throw new BorshError(`Class ${obj.constructor.name} is missing in schema`);
    }
    if (structSchema.kind === "struct") {
      structSchema.fields.map(([fieldName, fieldType]) => {
        serializeField(schema, fieldName, obj[fieldName], fieldType, writer);
      });
    } else if (structSchema.kind === "enum") {
      const name = obj[structSchema.field];
      for (let idx = 0;idx < structSchema.values.length; ++idx) {
        const [fieldName, fieldType] = structSchema.values[idx];
        if (fieldName === name) {
          writer.writeU8(idx);
          serializeField(schema, fieldName, obj[fieldName], fieldType, writer);
          break;
        }
      }
    } else {
      throw new BorshError(`Unexpected schema kind: ${structSchema.kind} for ${obj.constructor.name}`);
    }
  }
  function serialize(schema, obj, Writer = BinaryWriter) {
    const writer = new Writer;
    serializeStruct(schema, obj, writer);
    return writer.toArray();
  }
  exports.serialize = serialize;
  function deserializeField(schema, fieldName, fieldType, reader) {
    try {
      if (typeof fieldType === "string") {
        return reader[`read${capitalizeFirstLetter(fieldType)}`]();
      }
      if (fieldType instanceof Array) {
        if (typeof fieldType[0] === "number") {
          return reader.readFixedArray(fieldType[0]);
        } else if (typeof fieldType[1] === "number") {
          const arr = [];
          for (let i = 0;i < fieldType[1]; i++) {
            arr.push(deserializeField(schema, null, fieldType[0], reader));
          }
          return arr;
        } else {
          return reader.readArray(() => deserializeField(schema, fieldName, fieldType[0], reader));
        }
      }
      if (fieldType.kind === "option") {
        const option = reader.readU8();
        if (option) {
          return deserializeField(schema, fieldName, fieldType.type, reader);
        }
        return;
      }
      if (fieldType.kind === "map") {
        let map = new Map;
        const length = reader.readU32();
        for (let i = 0;i < length; i++) {
          const key = deserializeField(schema, fieldName, fieldType.key, reader);
          const val = deserializeField(schema, fieldName, fieldType.value, reader);
          map.set(key, val);
        }
        return map;
      }
      return deserializeStruct(schema, fieldType, reader);
    } catch (error) {
      if (error instanceof BorshError) {
        error.addToFieldPath(fieldName);
      }
      throw error;
    }
  }
  function deserializeStruct(schema, classType, reader) {
    if (typeof classType.borshDeserialize === "function") {
      return classType.borshDeserialize(reader);
    }
    const structSchema = schema.get(classType);
    if (!structSchema) {
      throw new BorshError(`Class ${classType.name} is missing in schema`);
    }
    if (structSchema.kind === "struct") {
      const result = {};
      for (const [fieldName, fieldType] of schema.get(classType).fields) {
        result[fieldName] = deserializeField(schema, fieldName, fieldType, reader);
      }
      return new classType(result);
    }
    if (structSchema.kind === "enum") {
      const idx = reader.readU8();
      if (idx >= structSchema.values.length) {
        throw new BorshError(`Enum index: ${idx} is out of range`);
      }
      const [fieldName, fieldType] = structSchema.values[idx];
      const fieldValue = deserializeField(schema, fieldName, fieldType, reader);
      return new classType({ [fieldName]: fieldValue });
    }
    throw new BorshError(`Unexpected schema kind: ${structSchema.kind} for ${classType.constructor.name}`);
  }
  function deserialize(schema, classType, buffer, Reader = BinaryReader) {
    const reader = new Reader(buffer);
    const result = deserializeStruct(schema, classType, reader);
    if (reader.offset < buffer.length) {
      throw new BorshError(`Unexpected ${buffer.length - reader.offset} bytes after deserialized data`);
    }
    return result;
  }
  exports.deserialize = deserialize;
  function deserializeUnchecked(schema, classType, buffer, Reader = BinaryReader) {
    const reader = new Reader(buffer);
    return deserializeStruct(schema, classType, reader);
  }
  exports.deserializeUnchecked = deserializeUnchecked;
});

// ../../node_modules/.bun/@solana+buffer-layout@4.0.1/node_modules/@solana/buffer-layout/lib/Layout.js
var require_Layout = __commonJS(function(exports) {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.s16 = exports.s8 = exports.nu64be = exports.u48be = exports.u40be = exports.u32be = exports.u24be = exports.u16be = exports.nu64 = exports.u48 = exports.u40 = exports.u32 = exports.u24 = exports.u16 = exports.u8 = exports.offset = exports.greedy = exports.Constant = exports.UTF8 = exports.CString = exports.Blob = exports.Boolean = exports.BitField = exports.BitStructure = exports.VariantLayout = exports.Union = exports.UnionLayoutDiscriminator = exports.UnionDiscriminator = exports.Structure = exports.Sequence = exports.DoubleBE = exports.Double = exports.FloatBE = exports.Float = exports.NearInt64BE = exports.NearInt64 = exports.NearUInt64BE = exports.NearUInt64 = exports.IntBE = exports.Int = exports.UIntBE = exports.UInt = exports.OffsetLayout = exports.GreedyCount = exports.ExternalLayout = exports.bindConstructorLayout = exports.nameWithProperty = exports.Layout = exports.uint8ArrayToBuffer = exports.checkUint8Array = undefined;
  exports.constant = exports.utf8 = exports.cstr = exports.blob = exports.unionLayoutDiscriminator = exports.union = exports.seq = exports.bits = exports.struct = exports.f64be = exports.f64 = exports.f32be = exports.f32 = exports.ns64be = exports.s48be = exports.s40be = exports.s32be = exports.s24be = exports.s16be = exports.ns64 = exports.s48 = exports.s40 = exports.s32 = exports.s24 = undefined;
  var buffer_1 = (init_buffer(), {});
  function checkUint8Array(b) {
    if (!(b instanceof Uint8Array)) {
      throw new TypeError("b must be a Uint8Array");
    }
  }
  exports.checkUint8Array = checkUint8Array;
  function uint8ArrayToBuffer(b) {
    checkUint8Array(b);
    return Buffer2.from(b.buffer, b.byteOffset, b.length);
  }
  exports.uint8ArrayToBuffer = uint8ArrayToBuffer;

  class Layout {
    constructor(span, property) {
      if (!Number.isInteger(span)) {
        throw new TypeError("span must be an integer");
      }
      this.span = span;
      this.property = property;
    }
    makeDestinationObject() {
      return {};
    }
    getSpan(b, offset) {
      if (0 > this.span) {
        throw new RangeError("indeterminate span");
      }
      return this.span;
    }
    replicate(property) {
      const rv = Object.create(this.constructor.prototype);
      Object.assign(rv, this);
      rv.property = property;
      return rv;
    }
    fromArray(values) {
      return;
    }
  }
  exports.Layout = Layout;
  function nameWithProperty(name, lo) {
    if (lo.property) {
      return name + "[" + lo.property + "]";
    }
    return name;
  }
  exports.nameWithProperty = nameWithProperty;
  function bindConstructorLayout(Class, layout) {
    if (typeof Class !== "function") {
      throw new TypeError("Class must be constructor");
    }
    if (Object.prototype.hasOwnProperty.call(Class, "layout_")) {
      throw new Error("Class is already bound to a layout");
    }
    if (!(layout && layout instanceof Layout)) {
      throw new TypeError("layout must be a Layout");
    }
    if (Object.prototype.hasOwnProperty.call(layout, "boundConstructor_")) {
      throw new Error("layout is already bound to a constructor");
    }
    Class.layout_ = layout;
    layout.boundConstructor_ = Class;
    layout.makeDestinationObject = () => new Class;
    Object.defineProperty(Class.prototype, "encode", {
      value(b, offset) {
        return layout.encode(this, b, offset);
      },
      writable: true
    });
    Object.defineProperty(Class, "decode", {
      value(b, offset) {
        return layout.decode(b, offset);
      },
      writable: true
    });
  }
  exports.bindConstructorLayout = bindConstructorLayout;

  class ExternalLayout extends Layout {
    isCount() {
      throw new Error("ExternalLayout is abstract");
    }
  }
  exports.ExternalLayout = ExternalLayout;

  class GreedyCount extends ExternalLayout {
    constructor(elementSpan = 1, property) {
      if (!Number.isInteger(elementSpan) || 0 >= elementSpan) {
        throw new TypeError("elementSpan must be a (positive) integer");
      }
      super(-1, property);
      this.elementSpan = elementSpan;
    }
    isCount() {
      return true;
    }
    decode(b, offset = 0) {
      checkUint8Array(b);
      const rem = b.length - offset;
      return Math.floor(rem / this.elementSpan);
    }
    encode(src, b, offset) {
      return 0;
    }
  }
  exports.GreedyCount = GreedyCount;

  class OffsetLayout extends ExternalLayout {
    constructor(layout, offset = 0, property) {
      if (!(layout instanceof Layout)) {
        throw new TypeError("layout must be a Layout");
      }
      if (!Number.isInteger(offset)) {
        throw new TypeError("offset must be integer or undefined");
      }
      super(layout.span, property || layout.property);
      this.layout = layout;
      this.offset = offset;
    }
    isCount() {
      return this.layout instanceof UInt || this.layout instanceof UIntBE;
    }
    decode(b, offset = 0) {
      return this.layout.decode(b, offset + this.offset);
    }
    encode(src, b, offset = 0) {
      return this.layout.encode(src, b, offset + this.offset);
    }
  }
  exports.OffsetLayout = OffsetLayout;

  class UInt extends Layout {
    constructor(span, property) {
      super(span, property);
      if (6 < this.span) {
        throw new RangeError("span must not exceed 6 bytes");
      }
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readUIntLE(offset, this.span);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeUIntLE(src, offset, this.span);
      return this.span;
    }
  }
  exports.UInt = UInt;

  class UIntBE extends Layout {
    constructor(span, property) {
      super(span, property);
      if (6 < this.span) {
        throw new RangeError("span must not exceed 6 bytes");
      }
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readUIntBE(offset, this.span);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeUIntBE(src, offset, this.span);
      return this.span;
    }
  }
  exports.UIntBE = UIntBE;

  class Int extends Layout {
    constructor(span, property) {
      super(span, property);
      if (6 < this.span) {
        throw new RangeError("span must not exceed 6 bytes");
      }
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readIntLE(offset, this.span);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeIntLE(src, offset, this.span);
      return this.span;
    }
  }
  exports.Int = Int;

  class IntBE extends Layout {
    constructor(span, property) {
      super(span, property);
      if (6 < this.span) {
        throw new RangeError("span must not exceed 6 bytes");
      }
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readIntBE(offset, this.span);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeIntBE(src, offset, this.span);
      return this.span;
    }
  }
  exports.IntBE = IntBE;
  var V2E32 = Math.pow(2, 32);
  function divmodInt64(src) {
    const hi32 = Math.floor(src / V2E32);
    const lo32 = src - hi32 * V2E32;
    return { hi32, lo32 };
  }
  function roundedInt64(hi32, lo32) {
    return hi32 * V2E32 + lo32;
  }

  class NearUInt64 extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      const buffer = uint8ArrayToBuffer(b);
      const lo32 = buffer.readUInt32LE(offset);
      const hi32 = buffer.readUInt32LE(offset + 4);
      return roundedInt64(hi32, lo32);
    }
    encode(src, b, offset = 0) {
      const split = divmodInt64(src);
      const buffer = uint8ArrayToBuffer(b);
      buffer.writeUInt32LE(split.lo32, offset);
      buffer.writeUInt32LE(split.hi32, offset + 4);
      return 8;
    }
  }
  exports.NearUInt64 = NearUInt64;

  class NearUInt64BE extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      const buffer = uint8ArrayToBuffer(b);
      const hi32 = buffer.readUInt32BE(offset);
      const lo32 = buffer.readUInt32BE(offset + 4);
      return roundedInt64(hi32, lo32);
    }
    encode(src, b, offset = 0) {
      const split = divmodInt64(src);
      const buffer = uint8ArrayToBuffer(b);
      buffer.writeUInt32BE(split.hi32, offset);
      buffer.writeUInt32BE(split.lo32, offset + 4);
      return 8;
    }
  }
  exports.NearUInt64BE = NearUInt64BE;

  class NearInt64 extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      const buffer = uint8ArrayToBuffer(b);
      const lo32 = buffer.readUInt32LE(offset);
      const hi32 = buffer.readInt32LE(offset + 4);
      return roundedInt64(hi32, lo32);
    }
    encode(src, b, offset = 0) {
      const split = divmodInt64(src);
      const buffer = uint8ArrayToBuffer(b);
      buffer.writeUInt32LE(split.lo32, offset);
      buffer.writeInt32LE(split.hi32, offset + 4);
      return 8;
    }
  }
  exports.NearInt64 = NearInt64;

  class NearInt64BE extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      const buffer = uint8ArrayToBuffer(b);
      const hi32 = buffer.readInt32BE(offset);
      const lo32 = buffer.readUInt32BE(offset + 4);
      return roundedInt64(hi32, lo32);
    }
    encode(src, b, offset = 0) {
      const split = divmodInt64(src);
      const buffer = uint8ArrayToBuffer(b);
      buffer.writeInt32BE(split.hi32, offset);
      buffer.writeUInt32BE(split.lo32, offset + 4);
      return 8;
    }
  }
  exports.NearInt64BE = NearInt64BE;

  class Float extends Layout {
    constructor(property) {
      super(4, property);
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readFloatLE(offset);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeFloatLE(src, offset);
      return 4;
    }
  }
  exports.Float = Float;

  class FloatBE extends Layout {
    constructor(property) {
      super(4, property);
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readFloatBE(offset);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeFloatBE(src, offset);
      return 4;
    }
  }
  exports.FloatBE = FloatBE;

  class Double extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readDoubleLE(offset);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeDoubleLE(src, offset);
      return 8;
    }
  }
  exports.Double = Double;

  class DoubleBE extends Layout {
    constructor(property) {
      super(8, property);
    }
    decode(b, offset = 0) {
      return uint8ArrayToBuffer(b).readDoubleBE(offset);
    }
    encode(src, b, offset = 0) {
      uint8ArrayToBuffer(b).writeDoubleBE(src, offset);
      return 8;
    }
  }
  exports.DoubleBE = DoubleBE;

  class Sequence extends Layout {
    constructor(elementLayout, count, property) {
      if (!(elementLayout instanceof Layout)) {
        throw new TypeError("elementLayout must be a Layout");
      }
      if (!(count instanceof ExternalLayout && count.isCount() || Number.isInteger(count) && 0 <= count)) {
        throw new TypeError("count must be non-negative integer " + "or an unsigned integer ExternalLayout");
      }
      let span = -1;
      if (!(count instanceof ExternalLayout) && 0 < elementLayout.span) {
        span = count * elementLayout.span;
      }
      super(span, property);
      this.elementLayout = elementLayout;
      this.count = count;
    }
    getSpan(b, offset = 0) {
      if (0 <= this.span) {
        return this.span;
      }
      let span = 0;
      let count = this.count;
      if (count instanceof ExternalLayout) {
        count = count.decode(b, offset);
      }
      if (0 < this.elementLayout.span) {
        span = count * this.elementLayout.span;
      } else {
        let idx = 0;
        while (idx < count) {
          span += this.elementLayout.getSpan(b, offset + span);
          ++idx;
        }
      }
      return span;
    }
    decode(b, offset = 0) {
      const rv = [];
      let i = 0;
      let count = this.count;
      if (count instanceof ExternalLayout) {
        count = count.decode(b, offset);
      }
      while (i < count) {
        rv.push(this.elementLayout.decode(b, offset));
        offset += this.elementLayout.getSpan(b, offset);
        i += 1;
      }
      return rv;
    }
    encode(src, b, offset = 0) {
      const elo = this.elementLayout;
      const span = src.reduce((span, v) => {
        return span + elo.encode(v, b, offset + span);
      }, 0);
      if (this.count instanceof ExternalLayout) {
        this.count.encode(src.length, b, offset);
      }
      return span;
    }
  }
  exports.Sequence = Sequence;

  class Structure extends Layout {
    constructor(fields, property, decodePrefixes) {
      if (!(Array.isArray(fields) && fields.reduce((acc, v) => acc && v instanceof Layout, true))) {
        throw new TypeError("fields must be array of Layout instances");
      }
      if (typeof property === "boolean" && decodePrefixes === undefined) {
        decodePrefixes = property;
        property = undefined;
      }
      for (const fd of fields) {
        if (0 > fd.span && fd.property === undefined) {
          throw new Error("fields cannot contain unnamed variable-length layout");
        }
      }
      let span = -1;
      try {
        span = fields.reduce((span, fd) => span + fd.getSpan(), 0);
      } catch (e) {}
      super(span, property);
      this.fields = fields;
      this.decodePrefixes = !!decodePrefixes;
    }
    getSpan(b, offset = 0) {
      if (0 <= this.span) {
        return this.span;
      }
      let span = 0;
      try {
        span = this.fields.reduce((span, fd) => {
          const fsp = fd.getSpan(b, offset);
          offset += fsp;
          return span + fsp;
        }, 0);
      } catch (e) {
        throw new RangeError("indeterminate span");
      }
      return span;
    }
    decode(b, offset = 0) {
      checkUint8Array(b);
      const dest = this.makeDestinationObject();
      for (const fd of this.fields) {
        if (fd.property !== undefined) {
          dest[fd.property] = fd.decode(b, offset);
        }
        offset += fd.getSpan(b, offset);
        if (this.decodePrefixes && b.length === offset) {
          break;
        }
      }
      return dest;
    }
    encode(src, b, offset = 0) {
      const firstOffset = offset;
      let lastOffset = 0;
      let lastWrote = 0;
      for (const fd of this.fields) {
        let span = fd.span;
        lastWrote = 0 < span ? span : 0;
        if (fd.property !== undefined) {
          const fv = src[fd.property];
          if (fv !== undefined) {
            lastWrote = fd.encode(fv, b, offset);
            if (0 > span) {
              span = fd.getSpan(b, offset);
            }
          }
        }
        lastOffset = offset;
        offset += span;
      }
      return lastOffset + lastWrote - firstOffset;
    }
    fromArray(values) {
      const dest = this.makeDestinationObject();
      for (const fd of this.fields) {
        if (fd.property !== undefined && 0 < values.length) {
          dest[fd.property] = values.shift();
        }
      }
      return dest;
    }
    layoutFor(property) {
      if (typeof property !== "string") {
        throw new TypeError("property must be string");
      }
      for (const fd of this.fields) {
        if (fd.property === property) {
          return fd;
        }
      }
      return;
    }
    offsetOf(property) {
      if (typeof property !== "string") {
        throw new TypeError("property must be string");
      }
      let offset = 0;
      for (const fd of this.fields) {
        if (fd.property === property) {
          return offset;
        }
        if (0 > fd.span) {
          offset = -1;
        } else if (0 <= offset) {
          offset += fd.span;
        }
      }
      return;
    }
  }
  exports.Structure = Structure;

  class UnionDiscriminator {
    constructor(property) {
      this.property = property;
    }
    decode(b, offset) {
      throw new Error("UnionDiscriminator is abstract");
    }
    encode(src, b, offset) {
      throw new Error("UnionDiscriminator is abstract");
    }
  }
  exports.UnionDiscriminator = UnionDiscriminator;

  class UnionLayoutDiscriminator extends UnionDiscriminator {
    constructor(layout, property) {
      if (!(layout instanceof ExternalLayout && layout.isCount())) {
        throw new TypeError("layout must be an unsigned integer ExternalLayout");
      }
      super(property || layout.property || "variant");
      this.layout = layout;
    }
    decode(b, offset) {
      return this.layout.decode(b, offset);
    }
    encode(src, b, offset) {
      return this.layout.encode(src, b, offset);
    }
  }
  exports.UnionLayoutDiscriminator = UnionLayoutDiscriminator;

  class Union extends Layout {
    constructor(discr, defaultLayout, property) {
      let discriminator;
      if (discr instanceof UInt || discr instanceof UIntBE) {
        discriminator = new UnionLayoutDiscriminator(new OffsetLayout(discr));
      } else if (discr instanceof ExternalLayout && discr.isCount()) {
        discriminator = new UnionLayoutDiscriminator(discr);
      } else if (!(discr instanceof UnionDiscriminator)) {
        throw new TypeError("discr must be a UnionDiscriminator " + "or an unsigned integer layout");
      } else {
        discriminator = discr;
      }
      if (defaultLayout === undefined) {
        defaultLayout = null;
      }
      if (!(defaultLayout === null || defaultLayout instanceof Layout)) {
        throw new TypeError("defaultLayout must be null or a Layout");
      }
      if (defaultLayout !== null) {
        if (0 > defaultLayout.span) {
          throw new Error("defaultLayout must have constant span");
        }
        if (defaultLayout.property === undefined) {
          defaultLayout = defaultLayout.replicate("content");
        }
      }
      let span = -1;
      if (defaultLayout) {
        span = defaultLayout.span;
        if (0 <= span && (discr instanceof UInt || discr instanceof UIntBE)) {
          span += discriminator.layout.span;
        }
      }
      super(span, property);
      this.discriminator = discriminator;
      this.usesPrefixDiscriminator = discr instanceof UInt || discr instanceof UIntBE;
      this.defaultLayout = defaultLayout;
      this.registry = {};
      let boundGetSourceVariant = this.defaultGetSourceVariant.bind(this);
      this.getSourceVariant = function(src) {
        return boundGetSourceVariant(src);
      };
      this.configGetSourceVariant = function(gsv) {
        boundGetSourceVariant = gsv.bind(this);
      };
    }
    getSpan(b, offset = 0) {
      if (0 <= this.span) {
        return this.span;
      }
      const vlo = this.getVariant(b, offset);
      if (!vlo) {
        throw new Error("unable to determine span for unrecognized variant");
      }
      return vlo.getSpan(b, offset);
    }
    defaultGetSourceVariant(src) {
      if (Object.prototype.hasOwnProperty.call(src, this.discriminator.property)) {
        if (this.defaultLayout && this.defaultLayout.property && Object.prototype.hasOwnProperty.call(src, this.defaultLayout.property)) {
          return;
        }
        const vlo = this.registry[src[this.discriminator.property]];
        if (vlo && (!vlo.layout || vlo.property && Object.prototype.hasOwnProperty.call(src, vlo.property))) {
          return vlo;
        }
      } else {
        for (const tag in this.registry) {
          const vlo = this.registry[tag];
          if (vlo.property && Object.prototype.hasOwnProperty.call(src, vlo.property)) {
            return vlo;
          }
        }
      }
      throw new Error("unable to infer src variant");
    }
    decode(b, offset = 0) {
      let dest;
      const dlo = this.discriminator;
      const discr = dlo.decode(b, offset);
      const clo = this.registry[discr];
      if (clo === undefined) {
        const defaultLayout = this.defaultLayout;
        let contentOffset = 0;
        if (this.usesPrefixDiscriminator) {
          contentOffset = dlo.layout.span;
        }
        dest = this.makeDestinationObject();
        dest[dlo.property] = discr;
        dest[defaultLayout.property] = defaultLayout.decode(b, offset + contentOffset);
      } else {
        dest = clo.decode(b, offset);
      }
      return dest;
    }
    encode(src, b, offset = 0) {
      const vlo = this.getSourceVariant(src);
      if (vlo === undefined) {
        const dlo = this.discriminator;
        const clo = this.defaultLayout;
        let contentOffset = 0;
        if (this.usesPrefixDiscriminator) {
          contentOffset = dlo.layout.span;
        }
        dlo.encode(src[dlo.property], b, offset);
        return contentOffset + clo.encode(src[clo.property], b, offset + contentOffset);
      }
      return vlo.encode(src, b, offset);
    }
    addVariant(variant, layout, property) {
      const rv = new VariantLayout(this, variant, layout, property);
      this.registry[variant] = rv;
      return rv;
    }
    getVariant(vb, offset = 0) {
      let variant;
      if (vb instanceof Uint8Array) {
        variant = this.discriminator.decode(vb, offset);
      } else {
        variant = vb;
      }
      return this.registry[variant];
    }
  }
  exports.Union = Union;

  class VariantLayout extends Layout {
    constructor(union, variant, layout, property) {
      if (!(union instanceof Union)) {
        throw new TypeError("union must be a Union");
      }
      if (!Number.isInteger(variant) || 0 > variant) {
        throw new TypeError("variant must be a (non-negative) integer");
      }
      if (typeof layout === "string" && property === undefined) {
        property = layout;
        layout = null;
      }
      if (layout) {
        if (!(layout instanceof Layout)) {
          throw new TypeError("layout must be a Layout");
        }
        if (union.defaultLayout !== null && 0 <= layout.span && layout.span > union.defaultLayout.span) {
          throw new Error("variant span exceeds span of containing union");
        }
        if (typeof property !== "string") {
          throw new TypeError("variant must have a String property");
        }
      }
      let span = union.span;
      if (0 > union.span) {
        span = layout ? layout.span : 0;
        if (0 <= span && union.usesPrefixDiscriminator) {
          span += union.discriminator.layout.span;
        }
      }
      super(span, property);
      this.union = union;
      this.variant = variant;
      this.layout = layout || null;
    }
    getSpan(b, offset = 0) {
      if (0 <= this.span) {
        return this.span;
      }
      let contentOffset = 0;
      if (this.union.usesPrefixDiscriminator) {
        contentOffset = this.union.discriminator.layout.span;
      }
      let span = 0;
      if (this.layout) {
        span = this.layout.getSpan(b, offset + contentOffset);
      }
      return contentOffset + span;
    }
    decode(b, offset = 0) {
      const dest = this.makeDestinationObject();
      if (this !== this.union.getVariant(b, offset)) {
        throw new Error("variant mismatch");
      }
      let contentOffset = 0;
      if (this.union.usesPrefixDiscriminator) {
        contentOffset = this.union.discriminator.layout.span;
      }
      if (this.layout) {
        dest[this.property] = this.layout.decode(b, offset + contentOffset);
      } else if (this.property) {
        dest[this.property] = true;
      } else if (this.union.usesPrefixDiscriminator) {
        dest[this.union.discriminator.property] = this.variant;
      }
      return dest;
    }
    encode(src, b, offset = 0) {
      let contentOffset = 0;
      if (this.union.usesPrefixDiscriminator) {
        contentOffset = this.union.discriminator.layout.span;
      }
      if (this.layout && !Object.prototype.hasOwnProperty.call(src, this.property)) {
        throw new TypeError("variant lacks property " + this.property);
      }
      this.union.discriminator.encode(this.variant, b, offset);
      let span = contentOffset;
      if (this.layout) {
        this.layout.encode(src[this.property], b, offset + contentOffset);
        span += this.layout.getSpan(b, offset + contentOffset);
        if (0 <= this.union.span && span > this.union.span) {
          throw new Error("encoded variant overruns containing union");
        }
      }
      return span;
    }
    fromArray(values) {
      if (this.layout) {
        return this.layout.fromArray(values);
      }
      return;
    }
  }
  exports.VariantLayout = VariantLayout;
  function fixBitwiseResult(v) {
    if (0 > v) {
      v += 4294967296;
    }
    return v;
  }

  class BitStructure extends Layout {
    constructor(word, msb, property) {
      if (!(word instanceof UInt || word instanceof UIntBE)) {
        throw new TypeError("word must be a UInt or UIntBE layout");
      }
      if (typeof msb === "string" && property === undefined) {
        property = msb;
        msb = false;
      }
      if (4 < word.span) {
        throw new RangeError("word cannot exceed 32 bits");
      }
      super(word.span, property);
      this.word = word;
      this.msb = !!msb;
      this.fields = [];
      let value = 0;
      this._packedSetValue = function(v) {
        value = fixBitwiseResult(v);
        return this;
      };
      this._packedGetValue = function() {
        return value;
      };
    }
    decode(b, offset = 0) {
      const dest = this.makeDestinationObject();
      const value = this.word.decode(b, offset);
      this._packedSetValue(value);
      for (const fd of this.fields) {
        if (fd.property !== undefined) {
          dest[fd.property] = fd.decode(b);
        }
      }
      return dest;
    }
    encode(src, b, offset = 0) {
      const value = this.word.decode(b, offset);
      this._packedSetValue(value);
      for (const fd of this.fields) {
        if (fd.property !== undefined) {
          const fv = src[fd.property];
          if (fv !== undefined) {
            fd.encode(fv);
          }
        }
      }
      return this.word.encode(this._packedGetValue(), b, offset);
    }
    addField(bits, property) {
      const bf = new BitField(this, bits, property);
      this.fields.push(bf);
      return bf;
    }
    addBoolean(property) {
      const bf = new Boolean2(this, property);
      this.fields.push(bf);
      return bf;
    }
    fieldFor(property) {
      if (typeof property !== "string") {
        throw new TypeError("property must be string");
      }
      for (const fd of this.fields) {
        if (fd.property === property) {
          return fd;
        }
      }
      return;
    }
  }
  exports.BitStructure = BitStructure;

  class BitField {
    constructor(container, bits, property) {
      if (!(container instanceof BitStructure)) {
        throw new TypeError("container must be a BitStructure");
      }
      if (!Number.isInteger(bits) || 0 >= bits) {
        throw new TypeError("bits must be positive integer");
      }
      const totalBits = 8 * container.span;
      const usedBits = container.fields.reduce((sum, fd) => sum + fd.bits, 0);
      if (bits + usedBits > totalBits) {
        throw new Error("bits too long for span remainder (" + (totalBits - usedBits) + " of " + totalBits + " remain)");
      }
      this.container = container;
      this.bits = bits;
      this.valueMask = (1 << bits) - 1;
      if (bits === 32) {
        this.valueMask = 4294967295;
      }
      this.start = usedBits;
      if (this.container.msb) {
        this.start = totalBits - usedBits - bits;
      }
      this.wordMask = fixBitwiseResult(this.valueMask << this.start);
      this.property = property;
    }
    decode(b, offset) {
      const word = this.container._packedGetValue();
      const wordValue = fixBitwiseResult(word & this.wordMask);
      const value = wordValue >>> this.start;
      return value;
    }
    encode(value) {
      if (typeof value !== "number" || !Number.isInteger(value) || value !== fixBitwiseResult(value & this.valueMask)) {
        throw new TypeError(nameWithProperty("BitField.encode", this) + " value must be integer not exceeding " + this.valueMask);
      }
      const word = this.container._packedGetValue();
      const wordValue = fixBitwiseResult(value << this.start);
      this.container._packedSetValue(fixBitwiseResult(word & ~this.wordMask) | wordValue);
    }
  }
  exports.BitField = BitField;

  class Boolean2 extends BitField {
    constructor(container, property) {
      super(container, 1, property);
    }
    decode(b, offset) {
      return !!super.decode(b, offset);
    }
    encode(value) {
      if (typeof value === "boolean") {
        value = +value;
      }
      super.encode(value);
    }
  }
  exports.Boolean = Boolean2;

  class Blob extends Layout {
    constructor(length, property) {
      if (!(length instanceof ExternalLayout && length.isCount() || Number.isInteger(length) && 0 <= length)) {
        throw new TypeError("length must be positive integer " + "or an unsigned integer ExternalLayout");
      }
      let span = -1;
      if (!(length instanceof ExternalLayout)) {
        span = length;
      }
      super(span, property);
      this.length = length;
    }
    getSpan(b, offset) {
      let span = this.span;
      if (0 > span) {
        span = this.length.decode(b, offset);
      }
      return span;
    }
    decode(b, offset = 0) {
      let span = this.span;
      if (0 > span) {
        span = this.length.decode(b, offset);
      }
      return uint8ArrayToBuffer(b).slice(offset, offset + span);
    }
    encode(src, b, offset) {
      let span = this.length;
      if (this.length instanceof ExternalLayout) {
        span = src.length;
      }
      if (!(src instanceof Uint8Array && span === src.length)) {
        throw new TypeError(nameWithProperty("Blob.encode", this) + " requires (length " + span + ") Uint8Array as src");
      }
      if (offset + span > b.length) {
        throw new RangeError("encoding overruns Uint8Array");
      }
      const srcBuffer = uint8ArrayToBuffer(src);
      uint8ArrayToBuffer(b).write(srcBuffer.toString("hex"), offset, span, "hex");
      if (this.length instanceof ExternalLayout) {
        this.length.encode(span, b, offset);
      }
      return span;
    }
  }
  exports.Blob = Blob;

  class CString extends Layout {
    constructor(property) {
      super(-1, property);
    }
    getSpan(b, offset = 0) {
      checkUint8Array(b);
      let idx = offset;
      while (idx < b.length && b[idx] !== 0) {
        idx += 1;
      }
      return 1 + idx - offset;
    }
    decode(b, offset = 0) {
      const span = this.getSpan(b, offset);
      return uint8ArrayToBuffer(b).slice(offset, offset + span - 1).toString("utf-8");
    }
    encode(src, b, offset = 0) {
      if (typeof src !== "string") {
        src = String(src);
      }
      const srcb = Buffer2.from(src, "utf8");
      const span = srcb.length;
      if (offset + span > b.length) {
        throw new RangeError("encoding overruns Buffer");
      }
      const buffer = uint8ArrayToBuffer(b);
      srcb.copy(buffer, offset);
      buffer[offset + span] = 0;
      return span + 1;
    }
  }
  exports.CString = CString;

  class UTF8 extends Layout {
    constructor(maxSpan, property) {
      if (typeof maxSpan === "string" && property === undefined) {
        property = maxSpan;
        maxSpan = undefined;
      }
      if (maxSpan === undefined) {
        maxSpan = -1;
      } else if (!Number.isInteger(maxSpan)) {
        throw new TypeError("maxSpan must be an integer");
      }
      super(-1, property);
      this.maxSpan = maxSpan;
    }
    getSpan(b, offset = 0) {
      checkUint8Array(b);
      return b.length - offset;
    }
    decode(b, offset = 0) {
      const span = this.getSpan(b, offset);
      if (0 <= this.maxSpan && this.maxSpan < span) {
        throw new RangeError("text length exceeds maxSpan");
      }
      return uint8ArrayToBuffer(b).slice(offset, offset + span).toString("utf-8");
    }
    encode(src, b, offset = 0) {
      if (typeof src !== "string") {
        src = String(src);
      }
      const srcb = Buffer2.from(src, "utf8");
      const span = srcb.length;
      if (0 <= this.maxSpan && this.maxSpan < span) {
        throw new RangeError("text length exceeds maxSpan");
      }
      if (offset + span > b.length) {
        throw new RangeError("encoding overruns Buffer");
      }
      srcb.copy(uint8ArrayToBuffer(b), offset);
      return span;
    }
  }
  exports.UTF8 = UTF8;

  class Constant extends Layout {
    constructor(value, property) {
      super(0, property);
      this.value = value;
    }
    decode(b, offset) {
      return this.value;
    }
    encode(src, b, offset) {
      return 0;
    }
  }
  exports.Constant = Constant;
  exports.greedy = (elementSpan, property) => new GreedyCount(elementSpan, property);
  exports.offset = (layout, offset, property) => new OffsetLayout(layout, offset, property);
  exports.u8 = (property) => new UInt(1, property);
  exports.u16 = (property) => new UInt(2, property);
  exports.u24 = (property) => new UInt(3, property);
  exports.u32 = (property) => new UInt(4, property);
  exports.u40 = (property) => new UInt(5, property);
  exports.u48 = (property) => new UInt(6, property);
  exports.nu64 = (property) => new NearUInt64(property);
  exports.u16be = (property) => new UIntBE(2, property);
  exports.u24be = (property) => new UIntBE(3, property);
  exports.u32be = (property) => new UIntBE(4, property);
  exports.u40be = (property) => new UIntBE(5, property);
  exports.u48be = (property) => new UIntBE(6, property);
  exports.nu64be = (property) => new NearUInt64BE(property);
  exports.s8 = (property) => new Int(1, property);
  exports.s16 = (property) => new Int(2, property);
  exports.s24 = (property) => new Int(3, property);
  exports.s32 = (property) => new Int(4, property);
  exports.s40 = (property) => new Int(5, property);
  exports.s48 = (property) => new Int(6, property);
  exports.ns64 = (property) => new NearInt64(property);
  exports.s16be = (property) => new IntBE(2, property);
  exports.s24be = (property) => new IntBE(3, property);
  exports.s32be = (property) => new IntBE(4, property);
  exports.s40be = (property) => new IntBE(5, property);
  exports.s48be = (property) => new IntBE(6, property);
  exports.ns64be = (property) => new NearInt64BE(property);
  exports.f32 = (property) => new Float(property);
  exports.f32be = (property) => new FloatBE(property);
  exports.f64 = (property) => new Double(property);
  exports.f64be = (property) => new DoubleBE(property);
  exports.struct = (fields, property, decodePrefixes) => new Structure(fields, property, decodePrefixes);
  exports.bits = (word, msb, property) => new BitStructure(word, msb, property);
  exports.seq = (elementLayout, count, property) => new Sequence(elementLayout, count, property);
  exports.union = (discr, defaultLayout, property) => new Union(discr, defaultLayout, property);
  exports.unionLayoutDiscriminator = (layout, property) => new UnionLayoutDiscriminator(layout, property);
  exports.blob = (length, property) => new Blob(length, property);
  exports.cstr = (property) => new CString(property);
  exports.utf8 = (maxSpan, property) => new UTF8(maxSpan, property);
  exports.constant = (value, property) => new Constant(value, property);
});

// ../../node_modules/.bun/@solana+errors@2.3.0+7524df1edfed9f02/node_modules/@solana/errors/dist/index.browser.mjs
function getHumanReadableErrorMessage(code, context = {}) {
  const messageFormatString = SolanaErrorMessages[code];
  if (messageFormatString.length === 0) {
    return "";
  }
  let state;
  function commitStateUpTo(endIndex) {
    if (state[TYPE] === 2) {
      const variableName = messageFormatString.slice(state[START_INDEX] + 1, endIndex);
      fragments.push(variableName in context ? `${context[variableName]}` : `$${variableName}`);
    } else if (state[TYPE] === 1) {
      fragments.push(messageFormatString.slice(state[START_INDEX], endIndex));
    }
  }
  const fragments = [];
  messageFormatString.split("").forEach((char, ii) => {
    if (ii === 0) {
      state = {
        [START_INDEX]: 0,
        [TYPE]: messageFormatString[0] === "\\" ? 0 : messageFormatString[0] === "$" ? 2 : 1
      };
      return;
    }
    let nextState;
    switch (state[TYPE]) {
      case 0:
        nextState = { [START_INDEX]: ii, [TYPE]: 1 };
        break;
      case 1:
        if (char === "\\") {
          nextState = { [START_INDEX]: ii, [TYPE]: 0 };
        } else if (char === "$") {
          nextState = { [START_INDEX]: ii, [TYPE]: 2 };
        }
        break;
      case 2:
        if (char === "\\") {
          nextState = { [START_INDEX]: ii, [TYPE]: 0 };
        } else if (char === "$") {
          nextState = { [START_INDEX]: ii, [TYPE]: 2 };
        } else if (!char.match(/\w/)) {
          nextState = { [START_INDEX]: ii, [TYPE]: 1 };
        }
        break;
    }
    if (nextState) {
      if (state !== nextState) {
        commitStateUpTo(ii);
      }
      state = nextState;
    }
  });
  commitStateUpTo();
  return fragments.join("");
}
function getErrorMessage(code, context = {}) {
  if (true) {
    return getHumanReadableErrorMessage(code, context);
  }
}
var SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED = 1, SOLANA_ERROR__INVALID_NONCE = 2, SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND = 3, SOLANA_ERROR__BLOCKHASH_STRING_LENGTH_OUT_OF_RANGE = 4, SOLANA_ERROR__INVALID_BLOCKHASH_BYTE_LENGTH = 5, SOLANA_ERROR__LAMPORTS_OUT_OF_RANGE = 6, SOLANA_ERROR__MALFORMED_BIGINT_STRING = 7, SOLANA_ERROR__MALFORMED_NUMBER_STRING = 8, SOLANA_ERROR__TIMESTAMP_OUT_OF_RANGE = 9, SOLANA_ERROR__MALFORMED_JSON_RPC_ERROR = 10, SOLANA_ERROR__JSON_RPC__PARSE_ERROR = -32700, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR = -32603, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS = -32602, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND = -32601, SOLANA_ERROR__JSON_RPC__INVALID_REQUEST = -32600, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED = -32016, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION = -32015, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET = -32014, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH = -32013, SOLANA_ERROR__JSON_RPC__SCAN_ERROR = -32012, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE = -32011, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_KEY_EXCLUDED_FROM_SECONDARY_INDEX = -32010, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED = -32009, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NO_SNAPSHOT = -32008, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED = -32007, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE = -32006, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY = -32005, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE = -32004, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE = -32003, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE = -32002, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_CLEANED_UP = -32001, SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH = 2800000, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE = 2800001, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS = 2800002, SOLANA_ERROR__ADDRESSES__INVALID_ED25519_PUBLIC_KEY = 2800003, SOLANA_ERROR__ADDRESSES__MALFORMED_PDA = 2800004, SOLANA_ERROR__ADDRESSES__PDA_BUMP_SEED_OUT_OF_RANGE = 2800005, SOLANA_ERROR__ADDRESSES__MAX_NUMBER_OF_PDA_SEEDS_EXCEEDED = 2800006, SOLANA_ERROR__ADDRESSES__MAX_PDA_SEED_LENGTH_EXCEEDED = 2800007, SOLANA_ERROR__ADDRESSES__INVALID_SEEDS_POINT_ON_CURVE = 2800008, SOLANA_ERROR__ADDRESSES__FAILED_TO_FIND_VIABLE_PDA_BUMP_SEED = 2800009, SOLANA_ERROR__ADDRESSES__PDA_ENDS_WITH_PDA_MARKER = 2800010, SOLANA_ERROR__ADDRESSES__INVALID_OFF_CURVE_ADDRESS = 2800011, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND = 3230000, SOLANA_ERROR__ACCOUNTS__ONE_OR_MORE_ACCOUNTS_NOT_FOUND = 32300001, SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT = 3230002, SOLANA_ERROR__ACCOUNTS__EXPECTED_DECODED_ACCOUNT = 3230003, SOLANA_ERROR__ACCOUNTS__EXPECTED_ALL_ACCOUNTS_TO_BE_DECODED = 3230004, SOLANA_ERROR__SUBTLE_CRYPTO__DISALLOWED_IN_INSECURE_CONTEXT = 3610000, SOLANA_ERROR__SUBTLE_CRYPTO__DIGEST_UNIMPLEMENTED = 3610001, SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED = 3610002, SOLANA_ERROR__SUBTLE_CRYPTO__EXPORT_FUNCTION_UNIMPLEMENTED = 3610003, SOLANA_ERROR__SUBTLE_CRYPTO__GENERATE_FUNCTION_UNIMPLEMENTED = 3610004, SOLANA_ERROR__SUBTLE_CRYPTO__SIGN_FUNCTION_UNIMPLEMENTED = 3610005, SOLANA_ERROR__SUBTLE_CRYPTO__VERIFY_FUNCTION_UNIMPLEMENTED = 3610006, SOLANA_ERROR__SUBTLE_CRYPTO__CANNOT_EXPORT_NON_EXTRACTABLE_KEY = 3610007, SOLANA_ERROR__CRYPTO__RANDOM_VALUES_FUNCTION_UNIMPLEMENTED = 3611000, SOLANA_ERROR__KEYS__INVALID_KEY_PAIR_BYTE_LENGTH = 3704000, SOLANA_ERROR__KEYS__INVALID_PRIVATE_KEY_BYTE_LENGTH = 3704001, SOLANA_ERROR__KEYS__INVALID_SIGNATURE_BYTE_LENGTH = 3704002, SOLANA_ERROR__KEYS__SIGNATURE_STRING_LENGTH_OUT_OF_RANGE = 3704003, SOLANA_ERROR__KEYS__PUBLIC_KEY_MUST_MATCH_PRIVATE_KEY = 3704004, SOLANA_ERROR__INSTRUCTION__EXPECTED_TO_HAVE_ACCOUNTS = 4128000, SOLANA_ERROR__INSTRUCTION__EXPECTED_TO_HAVE_DATA = 4128001, SOLANA_ERROR__INSTRUCTION__PROGRAM_ID_MISMATCH = 4128002, SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN = 4615000, SOLANA_ERROR__INSTRUCTION_ERROR__GENERIC_ERROR = 4615001, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ARGUMENT = 4615002, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_INSTRUCTION_DATA = 4615003, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ACCOUNT_DATA = 4615004, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_DATA_TOO_SMALL = 4615005, SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS = 4615006, SOLANA_ERROR__INSTRUCTION_ERROR__INCORRECT_PROGRAM_ID = 4615007, SOLANA_ERROR__INSTRUCTION_ERROR__MISSING_REQUIRED_SIGNATURE = 4615008, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED = 4615009, SOLANA_ERROR__INSTRUCTION_ERROR__UNINITIALIZED_ACCOUNT = 4615010, SOLANA_ERROR__INSTRUCTION_ERROR__UNBALANCED_INSTRUCTION = 4615011, SOLANA_ERROR__INSTRUCTION_ERROR__MODIFIED_PROGRAM_ID = 4615012, SOLANA_ERROR__INSTRUCTION_ERROR__EXTERNAL_ACCOUNT_LAMPORT_SPEND = 4615013, SOLANA_ERROR__INSTRUCTION_ERROR__EXTERNAL_ACCOUNT_DATA_MODIFIED = 4615014, SOLANA_ERROR__INSTRUCTION_ERROR__READONLY_LAMPORT_CHANGE = 4615015, SOLANA_ERROR__INSTRUCTION_ERROR__READONLY_DATA_MODIFIED = 4615016, SOLANA_ERROR__INSTRUCTION_ERROR__DUPLICATE_ACCOUNT_INDEX = 4615017, SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_MODIFIED = 4615018, SOLANA_ERROR__INSTRUCTION_ERROR__RENT_EPOCH_MODIFIED = 4615019, SOLANA_ERROR__INSTRUCTION_ERROR__NOT_ENOUGH_ACCOUNT_KEYS = 4615020, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_DATA_SIZE_CHANGED = 4615021, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_NOT_EXECUTABLE = 4615022, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_BORROW_FAILED = 4615023, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_BORROW_OUTSTANDING = 4615024, SOLANA_ERROR__INSTRUCTION_ERROR__DUPLICATE_ACCOUNT_OUT_OF_SYNC = 4615025, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM = 4615026, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ERROR = 4615027, SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_DATA_MODIFIED = 4615028, SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_LAMPORT_CHANGE = 4615029, SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_ACCOUNT_NOT_RENT_EXEMPT = 4615030, SOLANA_ERROR__INSTRUCTION_ERROR__UNSUPPORTED_PROGRAM_ID = 4615031, SOLANA_ERROR__INSTRUCTION_ERROR__CALL_DEPTH = 4615032, SOLANA_ERROR__INSTRUCTION_ERROR__MISSING_ACCOUNT = 4615033, SOLANA_ERROR__INSTRUCTION_ERROR__REENTRANCY_NOT_ALLOWED = 4615034, SOLANA_ERROR__INSTRUCTION_ERROR__MAX_SEED_LENGTH_EXCEEDED = 4615035, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_SEEDS = 4615036, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_REALLOC = 4615037, SOLANA_ERROR__INSTRUCTION_ERROR__COMPUTATIONAL_BUDGET_EXCEEDED = 4615038, SOLANA_ERROR__INSTRUCTION_ERROR__PRIVILEGE_ESCALATION = 4615039, SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_ENVIRONMENT_SETUP_FAILURE = 4615040, SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPLETE = 4615041, SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPILE = 4615042, SOLANA_ERROR__INSTRUCTION_ERROR__IMMUTABLE = 4615043, SOLANA_ERROR__INSTRUCTION_ERROR__INCORRECT_AUTHORITY = 4615044, SOLANA_ERROR__INSTRUCTION_ERROR__BORSH_IO_ERROR = 4615045, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_NOT_RENT_EXEMPT = 4615046, SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ACCOUNT_OWNER = 4615047, SOLANA_ERROR__INSTRUCTION_ERROR__ARITHMETIC_OVERFLOW = 4615048, SOLANA_ERROR__INSTRUCTION_ERROR__UNSUPPORTED_SYSVAR = 4615049, SOLANA_ERROR__INSTRUCTION_ERROR__ILLEGAL_OWNER = 4615050, SOLANA_ERROR__INSTRUCTION_ERROR__MAX_ACCOUNTS_DATA_ALLOCATIONS_EXCEEDED = 4615051, SOLANA_ERROR__INSTRUCTION_ERROR__MAX_ACCOUNTS_EXCEEDED = 4615052, SOLANA_ERROR__INSTRUCTION_ERROR__MAX_INSTRUCTION_TRACE_LENGTH_EXCEEDED = 4615053, SOLANA_ERROR__INSTRUCTION_ERROR__BUILTIN_PROGRAMS_MUST_CONSUME_COMPUTE_UNITS = 4615054, SOLANA_ERROR__SIGNER__ADDRESS_CANNOT_HAVE_MULTIPLE_SIGNERS = 5508000, SOLANA_ERROR__SIGNER__EXPECTED_KEY_PAIR_SIGNER = 5508001, SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_SIGNER = 5508002, SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_MODIFYING_SIGNER = 5508003, SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_PARTIAL_SIGNER = 5508004, SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_SIGNER = 5508005, SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_MODIFYING_SIGNER = 5508006, SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_PARTIAL_SIGNER = 5508007, SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_SENDING_SIGNER = 5508008, SOLANA_ERROR__SIGNER__TRANSACTION_CANNOT_HAVE_MULTIPLE_SENDING_SIGNERS = 5508009, SOLANA_ERROR__SIGNER__TRANSACTION_SENDING_SIGNER_MISSING = 5508010, SOLANA_ERROR__SIGNER__WALLET_MULTISIGN_UNIMPLEMENTED = 5508011, SOLANA_ERROR__TRANSACTION__INVOKED_PROGRAMS_CANNOT_PAY_FEES = 5663000, SOLANA_ERROR__TRANSACTION__INVOKED_PROGRAMS_MUST_NOT_BE_WRITABLE = 5663001, SOLANA_ERROR__TRANSACTION__EXPECTED_BLOCKHASH_LIFETIME = 5663002, SOLANA_ERROR__TRANSACTION__EXPECTED_NONCE_LIFETIME = 5663003, SOLANA_ERROR__TRANSACTION__VERSION_NUMBER_OUT_OF_RANGE = 5663004, SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_CONTENTS_MISSING = 5663005, SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_INDEX_OUT_OF_RANGE = 5663006, SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_INSTRUCTION_PROGRAM_ADDRESS_NOT_FOUND = 5663007, SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_FEE_PAYER_MISSING = 5663008, SOLANA_ERROR__TRANSACTION__SIGNATURES_MISSING = 5663009, SOLANA_ERROR__TRANSACTION__ADDRESS_MISSING = 5663010, SOLANA_ERROR__TRANSACTION__FEE_PAYER_MISSING = 5663011, SOLANA_ERROR__TRANSACTION__FEE_PAYER_SIGNATURE_MISSING = 5663012, SOLANA_ERROR__TRANSACTION__INVALID_NONCE_TRANSACTION_INSTRUCTIONS_MISSING = 5663013, SOLANA_ERROR__TRANSACTION__INVALID_NONCE_TRANSACTION_FIRST_INSTRUCTION_MUST_BE_ADVANCE_NONCE = 5663014, SOLANA_ERROR__TRANSACTION__ADDRESSES_CANNOT_SIGN_TRANSACTION = 5663015, SOLANA_ERROR__TRANSACTION__CANNOT_ENCODE_WITH_EMPTY_SIGNATURES = 5663016, SOLANA_ERROR__TRANSACTION__MESSAGE_SIGNATURES_MISMATCH = 5663017, SOLANA_ERROR__TRANSACTION__FAILED_TO_ESTIMATE_COMPUTE_LIMIT = 5663018, SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_COMPUTE_LIMIT = 5663019, SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT = 5663020, SOLANA_ERROR__TRANSACTION_ERROR__UNKNOWN = 7050000, SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_IN_USE = 7050001, SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_LOADED_TWICE = 7050002, SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND = 7050003, SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND = 7050004, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE = 7050005, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ACCOUNT_FOR_FEE = 7050006, SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED = 7050007, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND = 7050008, SOLANA_ERROR__TRANSACTION_ERROR__CALL_CHAIN_TOO_DEEP = 7050009, SOLANA_ERROR__TRANSACTION_ERROR__MISSING_SIGNATURE_FOR_FEE = 7050010, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ACCOUNT_INDEX = 7050011, SOLANA_ERROR__TRANSACTION_ERROR__SIGNATURE_FAILURE = 7050012, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_PROGRAM_FOR_EXECUTION = 7050013, SOLANA_ERROR__TRANSACTION_ERROR__SANITIZE_FAILURE = 7050014, SOLANA_ERROR__TRANSACTION_ERROR__CLUSTER_MAINTENANCE = 7050015, SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_BORROW_OUTSTANDING = 7050016, SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_BLOCK_COST_LIMIT = 7050017, SOLANA_ERROR__TRANSACTION_ERROR__UNSUPPORTED_VERSION = 7050018, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_WRITABLE_ACCOUNT = 7050019, SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_ACCOUNT_COST_LIMIT = 7050020, SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_ACCOUNT_DATA_BLOCK_LIMIT = 7050021, SOLANA_ERROR__TRANSACTION_ERROR__TOO_MANY_ACCOUNT_LOCKS = 7050022, SOLANA_ERROR__TRANSACTION_ERROR__ADDRESS_LOOKUP_TABLE_NOT_FOUND = 7050023, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_OWNER = 7050024, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_DATA = 7050025, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_INDEX = 7050026, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_RENT_PAYING_ACCOUNT = 7050027, SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_VOTE_COST_LIMIT = 7050028, SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_ACCOUNT_DATA_TOTAL_LIMIT = 7050029, SOLANA_ERROR__TRANSACTION_ERROR__DUPLICATE_INSTRUCTION = 7050030, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT = 7050031, SOLANA_ERROR__TRANSACTION_ERROR__MAX_LOADED_ACCOUNTS_DATA_SIZE_EXCEEDED = 7050032, SOLANA_ERROR__TRANSACTION_ERROR__INVALID_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 7050033, SOLANA_ERROR__TRANSACTION_ERROR__RESANITIZATION_NEEDED = 7050034, SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_EXECUTION_TEMPORARILY_RESTRICTED = 7050035, SOLANA_ERROR__TRANSACTION_ERROR__UNBALANCED_TRANSACTION = 7050036, SOLANA_ERROR__CODECS__CANNOT_DECODE_EMPTY_BYTE_ARRAY = 8078000, SOLANA_ERROR__CODECS__INVALID_BYTE_LENGTH = 8078001, SOLANA_ERROR__CODECS__EXPECTED_FIXED_LENGTH = 8078002, SOLANA_ERROR__CODECS__EXPECTED_VARIABLE_LENGTH = 8078003, SOLANA_ERROR__CODECS__ENCODER_DECODER_SIZE_COMPATIBILITY_MISMATCH = 8078004, SOLANA_ERROR__CODECS__ENCODER_DECODER_FIXED_SIZE_MISMATCH = 8078005, SOLANA_ERROR__CODECS__ENCODER_DECODER_MAX_SIZE_MISMATCH = 8078006, SOLANA_ERROR__CODECS__INVALID_NUMBER_OF_ITEMS = 8078007, SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE = 8078008, SOLANA_ERROR__CODECS__INVALID_DISCRIMINATED_UNION_VARIANT = 8078009, SOLANA_ERROR__CODECS__INVALID_ENUM_VARIANT = 8078010, SOLANA_ERROR__CODECS__NUMBER_OUT_OF_RANGE = 8078011, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE = 8078012, SOLANA_ERROR__CODECS__EXPECTED_POSITIVE_BYTE_LENGTH = 8078013, SOLANA_ERROR__CODECS__OFFSET_OUT_OF_RANGE = 8078014, SOLANA_ERROR__CODECS__INVALID_LITERAL_UNION_VARIANT = 8078015, SOLANA_ERROR__CODECS__LITERAL_UNION_DISCRIMINATOR_OUT_OF_RANGE = 8078016, SOLANA_ERROR__CODECS__UNION_VARIANT_OUT_OF_RANGE = 8078017, SOLANA_ERROR__CODECS__INVALID_CONSTANT = 8078018, SOLANA_ERROR__CODECS__EXPECTED_ZERO_VALUE_TO_MATCH_ITEM_FIXED_SIZE = 8078019, SOLANA_ERROR__CODECS__ENCODED_BYTES_MUST_NOT_INCLUDE_SENTINEL = 8078020, SOLANA_ERROR__CODECS__SENTINEL_MISSING_IN_DECODED_BYTES = 8078021, SOLANA_ERROR__CODECS__CANNOT_USE_LEXICAL_VALUES_AS_ENUM_DISCRIMINATORS = 8078022, SOLANA_ERROR__RPC__INTEGER_OVERFLOW = 8100000, SOLANA_ERROR__RPC__TRANSPORT_HTTP_HEADER_FORBIDDEN = 8100001, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR = 8100002, SOLANA_ERROR__RPC__API_PLAN_MISSING_FOR_RPC_METHOD = 8100003, SOLANA_ERROR__RPC_SUBSCRIPTIONS__CANNOT_CREATE_SUBSCRIPTION_PLAN = 8190000, SOLANA_ERROR__RPC_SUBSCRIPTIONS__EXPECTED_SERVER_SUBSCRIPTION_ID = 8190001, SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CLOSED_BEFORE_MESSAGE_BUFFERED = 8190002, SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED = 8190003, SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_FAILED_TO_CONNECT = 8190004, SOLANA_ERROR__INVARIANT_VIOLATION__SUBSCRIPTION_ITERATOR_STATE_MISSING = 9900000, SOLANA_ERROR__INVARIANT_VIOLATION__SUBSCRIPTION_ITERATOR_MUST_NOT_POLL_BEFORE_RESOLVING_EXISTING_MESSAGE_PROMISE = 9900001, SOLANA_ERROR__INVARIANT_VIOLATION__CACHED_ABORTABLE_ITERABLE_CACHE_ENTRY_MISSING = 9900002, SOLANA_ERROR__INVARIANT_VIOLATION__SWITCH_MUST_BE_EXHAUSTIVE = 9900003, SOLANA_ERROR__INVARIANT_VIOLATION__DATA_PUBLISHER_CHANNEL_UNIMPLEMENTED = 9900004, SolanaErrorMessages, START_INDEX = "i", TYPE = "t", SolanaError;
var init_index_browser = __esm(() => {
  SolanaErrorMessages = {
    [SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND]: "Account not found at address: $address",
    [SOLANA_ERROR__ACCOUNTS__EXPECTED_ALL_ACCOUNTS_TO_BE_DECODED]: "Not all accounts were decoded. Encoded accounts found at addresses: $addresses.",
    [SOLANA_ERROR__ACCOUNTS__EXPECTED_DECODED_ACCOUNT]: "Expected decoded account at address: $address",
    [SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT]: "Failed to decode account data at address: $address",
    [SOLANA_ERROR__ACCOUNTS__ONE_OR_MORE_ACCOUNTS_NOT_FOUND]: "Accounts not found at addresses: $addresses",
    [SOLANA_ERROR__ADDRESSES__FAILED_TO_FIND_VIABLE_PDA_BUMP_SEED]: "Unable to find a viable program address bump seed.",
    [SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS]: "$putativeAddress is not a base58-encoded address.",
    [SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH]: "Expected base58 encoded address to decode to a byte array of length 32. Actual length: $actualLength.",
    [SOLANA_ERROR__ADDRESSES__INVALID_ED25519_PUBLIC_KEY]: "The `CryptoKey` must be an `Ed25519` public key.",
    [SOLANA_ERROR__ADDRESSES__INVALID_OFF_CURVE_ADDRESS]: "$putativeOffCurveAddress is not a base58-encoded off-curve address.",
    [SOLANA_ERROR__ADDRESSES__INVALID_SEEDS_POINT_ON_CURVE]: "Invalid seeds; point must fall off the Ed25519 curve.",
    [SOLANA_ERROR__ADDRESSES__MALFORMED_PDA]: "Expected given program derived address to have the following format: [Address, ProgramDerivedAddressBump].",
    [SOLANA_ERROR__ADDRESSES__MAX_NUMBER_OF_PDA_SEEDS_EXCEEDED]: "A maximum of $maxSeeds seeds, including the bump seed, may be supplied when creating an address. Received: $actual.",
    [SOLANA_ERROR__ADDRESSES__MAX_PDA_SEED_LENGTH_EXCEEDED]: "The seed at index $index with length $actual exceeds the maximum length of $maxSeedLength bytes.",
    [SOLANA_ERROR__ADDRESSES__PDA_BUMP_SEED_OUT_OF_RANGE]: "Expected program derived address bump to be in the range [0, 255], got: $bump.",
    [SOLANA_ERROR__ADDRESSES__PDA_ENDS_WITH_PDA_MARKER]: "Program address cannot end with PDA marker.",
    [SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE]: "Expected base58-encoded address string of length in the range [32, 44]. Actual length: $actualLength.",
    [SOLANA_ERROR__BLOCKHASH_STRING_LENGTH_OUT_OF_RANGE]: "Expected base58-encoded blockash string of length in the range [32, 44]. Actual length: $actualLength.",
    [SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED]: "The network has progressed past the last block for which this transaction could have been committed.",
    [SOLANA_ERROR__CODECS__CANNOT_DECODE_EMPTY_BYTE_ARRAY]: "Codec [$codecDescription] cannot decode empty byte arrays.",
    [SOLANA_ERROR__CODECS__CANNOT_USE_LEXICAL_VALUES_AS_ENUM_DISCRIMINATORS]: "Enum codec cannot use lexical values [$stringValues] as discriminators. Either remove all lexical values or set `useValuesAsDiscriminators` to `false`.",
    [SOLANA_ERROR__CODECS__ENCODED_BYTES_MUST_NOT_INCLUDE_SENTINEL]: "Sentinel [$hexSentinel] must not be present in encoded bytes [$hexEncodedBytes].",
    [SOLANA_ERROR__CODECS__ENCODER_DECODER_FIXED_SIZE_MISMATCH]: "Encoder and decoder must have the same fixed size, got [$encoderFixedSize] and [$decoderFixedSize].",
    [SOLANA_ERROR__CODECS__ENCODER_DECODER_MAX_SIZE_MISMATCH]: "Encoder and decoder must have the same max size, got [$encoderMaxSize] and [$decoderMaxSize].",
    [SOLANA_ERROR__CODECS__ENCODER_DECODER_SIZE_COMPATIBILITY_MISMATCH]: "Encoder and decoder must either both be fixed-size or variable-size.",
    [SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE]: "Enum discriminator out of range. Expected a number in [$formattedValidDiscriminators], got $discriminator.",
    [SOLANA_ERROR__CODECS__EXPECTED_FIXED_LENGTH]: "Expected a fixed-size codec, got a variable-size one.",
    [SOLANA_ERROR__CODECS__EXPECTED_POSITIVE_BYTE_LENGTH]: "Codec [$codecDescription] expected a positive byte length, got $bytesLength.",
    [SOLANA_ERROR__CODECS__EXPECTED_VARIABLE_LENGTH]: "Expected a variable-size codec, got a fixed-size one.",
    [SOLANA_ERROR__CODECS__EXPECTED_ZERO_VALUE_TO_MATCH_ITEM_FIXED_SIZE]: "Codec [$codecDescription] expected zero-value [$hexZeroValue] to have the same size as the provided fixed-size item [$expectedSize bytes].",
    [SOLANA_ERROR__CODECS__INVALID_BYTE_LENGTH]: "Codec [$codecDescription] expected $expected bytes, got $bytesLength.",
    [SOLANA_ERROR__CODECS__INVALID_CONSTANT]: "Expected byte array constant [$hexConstant] to be present in data [$hexData] at offset [$offset].",
    [SOLANA_ERROR__CODECS__INVALID_DISCRIMINATED_UNION_VARIANT]: "Invalid discriminated union variant. Expected one of [$variants], got $value.",
    [SOLANA_ERROR__CODECS__INVALID_ENUM_VARIANT]: "Invalid enum variant. Expected one of [$stringValues] or a number in [$formattedNumericalValues], got $variant.",
    [SOLANA_ERROR__CODECS__INVALID_LITERAL_UNION_VARIANT]: "Invalid literal union variant. Expected one of [$variants], got $value.",
    [SOLANA_ERROR__CODECS__INVALID_NUMBER_OF_ITEMS]: "Expected [$codecDescription] to have $expected items, got $actual.",
    [SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE]: "Invalid value $value for base $base with alphabet $alphabet.",
    [SOLANA_ERROR__CODECS__LITERAL_UNION_DISCRIMINATOR_OUT_OF_RANGE]: "Literal union discriminator out of range. Expected a number between $minRange and $maxRange, got $discriminator.",
    [SOLANA_ERROR__CODECS__NUMBER_OUT_OF_RANGE]: "Codec [$codecDescription] expected number to be in the range [$min, $max], got $value.",
    [SOLANA_ERROR__CODECS__OFFSET_OUT_OF_RANGE]: "Codec [$codecDescription] expected offset to be in the range [0, $bytesLength], got $offset.",
    [SOLANA_ERROR__CODECS__SENTINEL_MISSING_IN_DECODED_BYTES]: "Expected sentinel [$hexSentinel] to be present in decoded bytes [$hexDecodedBytes].",
    [SOLANA_ERROR__CODECS__UNION_VARIANT_OUT_OF_RANGE]: "Union variant out of range. Expected an index between $minRange and $maxRange, got $variant.",
    [SOLANA_ERROR__CRYPTO__RANDOM_VALUES_FUNCTION_UNIMPLEMENTED]: "No random values implementation could be found.",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED]: "instruction requires an uninitialized account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_BORROW_FAILED]: "instruction tries to borrow reference for an account which is already borrowed",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_BORROW_OUTSTANDING]: "instruction left account with an outstanding borrowed reference",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_DATA_SIZE_CHANGED]: "program other than the account's owner changed the size of the account data",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_DATA_TOO_SMALL]: "account data too small for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_NOT_EXECUTABLE]: "instruction expected an executable account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_NOT_RENT_EXEMPT]: "An account does not have enough lamports to be rent-exempt",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ARITHMETIC_OVERFLOW]: "Program arithmetic overflowed",
    [SOLANA_ERROR__INSTRUCTION_ERROR__BORSH_IO_ERROR]: "Failed to serialize or deserialize account data: $encodedData",
    [SOLANA_ERROR__INSTRUCTION_ERROR__BUILTIN_PROGRAMS_MUST_CONSUME_COMPUTE_UNITS]: "Builtin programs must consume compute units",
    [SOLANA_ERROR__INSTRUCTION_ERROR__CALL_DEPTH]: "Cross-program invocation call depth too deep",
    [SOLANA_ERROR__INSTRUCTION_ERROR__COMPUTATIONAL_BUDGET_EXCEEDED]: "Computational budget exceeded",
    [SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM]: "custom program error: #$code",
    [SOLANA_ERROR__INSTRUCTION_ERROR__DUPLICATE_ACCOUNT_INDEX]: "instruction contains duplicate accounts",
    [SOLANA_ERROR__INSTRUCTION_ERROR__DUPLICATE_ACCOUNT_OUT_OF_SYNC]: "instruction modifications of multiply-passed account differ",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_ACCOUNT_NOT_RENT_EXEMPT]: "executable accounts must be rent exempt",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_DATA_MODIFIED]: "instruction changed executable accounts data",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_LAMPORT_CHANGE]: "instruction changed the balance of an executable account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXECUTABLE_MODIFIED]: "instruction changed executable bit of an account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXTERNAL_ACCOUNT_DATA_MODIFIED]: "instruction modified data of an account it does not own",
    [SOLANA_ERROR__INSTRUCTION_ERROR__EXTERNAL_ACCOUNT_LAMPORT_SPEND]: "instruction spent from the balance of an account it does not own",
    [SOLANA_ERROR__INSTRUCTION_ERROR__GENERIC_ERROR]: "generic instruction error",
    [SOLANA_ERROR__INSTRUCTION_ERROR__ILLEGAL_OWNER]: "Provided owner is not allowed",
    [SOLANA_ERROR__INSTRUCTION_ERROR__IMMUTABLE]: "Account is immutable",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INCORRECT_AUTHORITY]: "Incorrect authority provided",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INCORRECT_PROGRAM_ID]: "incorrect program id for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS]: "insufficient funds for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ACCOUNT_DATA]: "invalid account data for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ACCOUNT_OWNER]: "Invalid account owner",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ARGUMENT]: "invalid program argument",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_ERROR]: "program returned invalid error code",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_INSTRUCTION_DATA]: "invalid instruction data",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_REALLOC]: "Failed to reallocate account data",
    [SOLANA_ERROR__INSTRUCTION_ERROR__INVALID_SEEDS]: "Provided seeds do not result in a valid address",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MAX_ACCOUNTS_DATA_ALLOCATIONS_EXCEEDED]: "Accounts data allocations exceeded the maximum allowed per transaction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MAX_ACCOUNTS_EXCEEDED]: "Max accounts exceeded",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MAX_INSTRUCTION_TRACE_LENGTH_EXCEEDED]: "Max instruction trace length exceeded",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MAX_SEED_LENGTH_EXCEEDED]: "Length of the seed is too long for address generation",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MISSING_ACCOUNT]: "An account required by the instruction is missing",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MISSING_REQUIRED_SIGNATURE]: "missing required signature for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__MODIFIED_PROGRAM_ID]: "instruction illegally modified the program id of an account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__NOT_ENOUGH_ACCOUNT_KEYS]: "insufficient account keys for instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__PRIVILEGE_ESCALATION]: "Cross-program invocation with unauthorized signer or writable account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_ENVIRONMENT_SETUP_FAILURE]: "Failed to create program execution environment",
    [SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPILE]: "Program failed to compile",
    [SOLANA_ERROR__INSTRUCTION_ERROR__PROGRAM_FAILED_TO_COMPLETE]: "Program failed to complete",
    [SOLANA_ERROR__INSTRUCTION_ERROR__READONLY_DATA_MODIFIED]: "instruction modified data of a read-only account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__READONLY_LAMPORT_CHANGE]: "instruction changed the balance of a read-only account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__REENTRANCY_NOT_ALLOWED]: "Cross-program invocation reentrancy not allowed for this instruction",
    [SOLANA_ERROR__INSTRUCTION_ERROR__RENT_EPOCH_MODIFIED]: "instruction modified rent epoch of an account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__UNBALANCED_INSTRUCTION]: "sum of account balances before and after instruction do not match",
    [SOLANA_ERROR__INSTRUCTION_ERROR__UNINITIALIZED_ACCOUNT]: "instruction requires an initialized account",
    [SOLANA_ERROR__INSTRUCTION_ERROR__UNKNOWN]: "",
    [SOLANA_ERROR__INSTRUCTION_ERROR__UNSUPPORTED_PROGRAM_ID]: "Unsupported program id",
    [SOLANA_ERROR__INSTRUCTION_ERROR__UNSUPPORTED_SYSVAR]: "Unsupported sysvar",
    [SOLANA_ERROR__INSTRUCTION__EXPECTED_TO_HAVE_ACCOUNTS]: "The instruction does not have any accounts.",
    [SOLANA_ERROR__INSTRUCTION__EXPECTED_TO_HAVE_DATA]: "The instruction does not have any data.",
    [SOLANA_ERROR__INSTRUCTION__PROGRAM_ID_MISMATCH]: "Expected instruction to have progress address $expectedProgramAddress, got $actualProgramAddress.",
    [SOLANA_ERROR__INVALID_BLOCKHASH_BYTE_LENGTH]: "Expected base58 encoded blockhash to decode to a byte array of length 32. Actual length: $actualLength.",
    [SOLANA_ERROR__INVALID_NONCE]: "The nonce `$expectedNonceValue` is no longer valid. It has advanced to `$actualNonceValue`",
    [SOLANA_ERROR__INVARIANT_VIOLATION__CACHED_ABORTABLE_ITERABLE_CACHE_ENTRY_MISSING]: "Invariant violation: Found no abortable iterable cache entry for key `$cacheKey`. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",
    [SOLANA_ERROR__INVARIANT_VIOLATION__DATA_PUBLISHER_CHANNEL_UNIMPLEMENTED]: "Invariant violation: This data publisher does not publish to the channel named `$channelName`. Supported channels include $supportedChannelNames.",
    [SOLANA_ERROR__INVARIANT_VIOLATION__SUBSCRIPTION_ITERATOR_MUST_NOT_POLL_BEFORE_RESOLVING_EXISTING_MESSAGE_PROMISE]: "Invariant violation: WebSocket message iterator state is corrupt; iterated without first resolving existing message promise. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",
    [SOLANA_ERROR__INVARIANT_VIOLATION__SUBSCRIPTION_ITERATOR_STATE_MISSING]: "Invariant violation: WebSocket message iterator is missing state storage. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",
    [SOLANA_ERROR__INVARIANT_VIOLATION__SWITCH_MUST_BE_EXHAUSTIVE]: "Invariant violation: Switch statement non-exhaustive. Received unexpected value `$unexpectedValue`. It should be impossible to hit this error; please file an issue at https://sola.na/web3invariant",
    [SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR]: "JSON-RPC error: Internal JSON-RPC error ($__serverMessage)",
    [SOLANA_ERROR__JSON_RPC__INVALID_PARAMS]: "JSON-RPC error: Invalid method parameter(s) ($__serverMessage)",
    [SOLANA_ERROR__JSON_RPC__INVALID_REQUEST]: "JSON-RPC error: The JSON sent is not a valid `Request` object ($__serverMessage)",
    [SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND]: "JSON-RPC error: The method does not exist / is not available ($__serverMessage)",
    [SOLANA_ERROR__JSON_RPC__PARSE_ERROR]: "JSON-RPC error: An error occurred on the server while parsing the JSON text ($__serverMessage)",
    [SOLANA_ERROR__JSON_RPC__SCAN_ERROR]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_CLEANED_UP]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_KEY_EXCLUDED_FROM_SECONDARY_INDEX]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED]: "Minimum context slot has not been reached",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY]: "Node is unhealthy; behind by $numSlotsBehind slots",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NO_SNAPSHOT]: "No snapshot",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE]: "Transaction simulation failed",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE]: "Transaction history is not available from this node",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_PRECOMPILE_VERIFICATION_FAILURE]: "$__serverMessage",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_LEN_MISMATCH]: "Transaction signature length mismatch",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE]: "Transaction signature verification failure",
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION]: "$__serverMessage",
    [SOLANA_ERROR__KEYS__INVALID_KEY_PAIR_BYTE_LENGTH]: "Key pair bytes must be of length 64, got $byteLength.",
    [SOLANA_ERROR__KEYS__INVALID_PRIVATE_KEY_BYTE_LENGTH]: "Expected private key bytes with length 32. Actual length: $actualLength.",
    [SOLANA_ERROR__KEYS__INVALID_SIGNATURE_BYTE_LENGTH]: "Expected base58-encoded signature to decode to a byte array of length 64. Actual length: $actualLength.",
    [SOLANA_ERROR__KEYS__PUBLIC_KEY_MUST_MATCH_PRIVATE_KEY]: "The provided private key does not match the provided public key.",
    [SOLANA_ERROR__KEYS__SIGNATURE_STRING_LENGTH_OUT_OF_RANGE]: "Expected base58-encoded signature string of length in the range [64, 88]. Actual length: $actualLength.",
    [SOLANA_ERROR__LAMPORTS_OUT_OF_RANGE]: "Lamports value must be in the range [0, 2e64-1]",
    [SOLANA_ERROR__MALFORMED_BIGINT_STRING]: "`$value` cannot be parsed as a `BigInt`",
    [SOLANA_ERROR__MALFORMED_JSON_RPC_ERROR]: "$message",
    [SOLANA_ERROR__MALFORMED_NUMBER_STRING]: "`$value` cannot be parsed as a `Number`",
    [SOLANA_ERROR__NONCE_ACCOUNT_NOT_FOUND]: "No nonce account could be found at address `$nonceAccountAddress`",
    [SOLANA_ERROR__RPC_SUBSCRIPTIONS__CANNOT_CREATE_SUBSCRIPTION_PLAN]: "The notification name must end in 'Notifications' and the API must supply a subscription plan creator function for the notification '$notificationName'.",
    [SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CLOSED_BEFORE_MESSAGE_BUFFERED]: "WebSocket was closed before payload could be added to the send buffer",
    [SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_CONNECTION_CLOSED]: "WebSocket connection closed",
    [SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_FAILED_TO_CONNECT]: "WebSocket failed to connect",
    [SOLANA_ERROR__RPC_SUBSCRIPTIONS__EXPECTED_SERVER_SUBSCRIPTION_ID]: "Failed to obtain a subscription id from the server",
    [SOLANA_ERROR__RPC__API_PLAN_MISSING_FOR_RPC_METHOD]: "Could not find an API plan for RPC method: `$method`",
    [SOLANA_ERROR__RPC__INTEGER_OVERFLOW]: "The $argumentLabel argument to the `$methodName` RPC method$optionalPathLabel was `$value`. This number is unsafe for use with the Solana JSON-RPC because it exceeds `Number.MAX_SAFE_INTEGER`.",
    [SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR]: "HTTP error ($statusCode): $message",
    [SOLANA_ERROR__RPC__TRANSPORT_HTTP_HEADER_FORBIDDEN]: "HTTP header(s) forbidden: $headers. Learn more at https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name.",
    [SOLANA_ERROR__SIGNER__ADDRESS_CANNOT_HAVE_MULTIPLE_SIGNERS]: "Multiple distinct signers were identified for address `$address`. Please ensure that you are using the same signer instance for each address.",
    [SOLANA_ERROR__SIGNER__EXPECTED_KEY_PAIR_SIGNER]: "The provided value does not implement the `KeyPairSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_MODIFYING_SIGNER]: "The provided value does not implement the `MessageModifyingSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_PARTIAL_SIGNER]: "The provided value does not implement the `MessagePartialSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_MESSAGE_SIGNER]: "The provided value does not implement any of the `MessageSigner` interfaces",
    [SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_MODIFYING_SIGNER]: "The provided value does not implement the `TransactionModifyingSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_PARTIAL_SIGNER]: "The provided value does not implement the `TransactionPartialSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_SENDING_SIGNER]: "The provided value does not implement the `TransactionSendingSigner` interface",
    [SOLANA_ERROR__SIGNER__EXPECTED_TRANSACTION_SIGNER]: "The provided value does not implement any of the `TransactionSigner` interfaces",
    [SOLANA_ERROR__SIGNER__TRANSACTION_CANNOT_HAVE_MULTIPLE_SENDING_SIGNERS]: "More than one `TransactionSendingSigner` was identified.",
    [SOLANA_ERROR__SIGNER__TRANSACTION_SENDING_SIGNER_MISSING]: "No `TransactionSendingSigner` was identified. Please provide a valid `TransactionWithSingleSendingSigner` transaction.",
    [SOLANA_ERROR__SIGNER__WALLET_MULTISIGN_UNIMPLEMENTED]: "Wallet account signers do not support signing multiple messages/transactions in a single operation",
    [SOLANA_ERROR__SUBTLE_CRYPTO__CANNOT_EXPORT_NON_EXTRACTABLE_KEY]: "Cannot export a non-extractable key.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__DIGEST_UNIMPLEMENTED]: "No digest implementation could be found.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__DISALLOWED_IN_INSECURE_CONTEXT]: "Cryptographic operations are only allowed in secure browser contexts. Read more here: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED]: `This runtime does not support the generation of Ed25519 key pairs.

Install @solana/webcrypto-ed25519-polyfill and call its \`install\` function before generating keys in environments that do not support Ed25519.

For a list of runtimes that currently support Ed25519 operations, visit https://github.com/WICG/webcrypto-secure-curves/issues/20.`,
    [SOLANA_ERROR__SUBTLE_CRYPTO__EXPORT_FUNCTION_UNIMPLEMENTED]: "No signature verification implementation could be found.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__GENERATE_FUNCTION_UNIMPLEMENTED]: "No key generation implementation could be found.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__SIGN_FUNCTION_UNIMPLEMENTED]: "No signing implementation could be found.",
    [SOLANA_ERROR__SUBTLE_CRYPTO__VERIFY_FUNCTION_UNIMPLEMENTED]: "No key export implementation could be found.",
    [SOLANA_ERROR__TIMESTAMP_OUT_OF_RANGE]: "Timestamp value must be in the range [-(2n ** 63n), (2n ** 63n) - 1]. `$value` given",
    [SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_BORROW_OUTSTANDING]: "Transaction processing left an account with an outstanding borrowed reference",
    [SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_IN_USE]: "Account in use",
    [SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_LOADED_TWICE]: "Account loaded twice",
    [SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND]: "Attempt to debit an account but found no record of a prior credit.",
    [SOLANA_ERROR__TRANSACTION_ERROR__ADDRESS_LOOKUP_TABLE_NOT_FOUND]: "Transaction loads an address table account that doesn't exist",
    [SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED]: "This transaction has already been processed",
    [SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND]: "Blockhash not found",
    [SOLANA_ERROR__TRANSACTION_ERROR__CALL_CHAIN_TOO_DEEP]: "Loader call chain is too deep",
    [SOLANA_ERROR__TRANSACTION_ERROR__CLUSTER_MAINTENANCE]: "Transactions are currently disabled due to cluster maintenance",
    [SOLANA_ERROR__TRANSACTION_ERROR__DUPLICATE_INSTRUCTION]: "Transaction contains a duplicate instruction ($index) that is not allowed",
    [SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE]: "Insufficient funds for fee",
    [SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT]: "Transaction results in an account ($accountIndex) with insufficient funds for rent",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ACCOUNT_FOR_FEE]: "This account may not be used to pay transaction fees",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ACCOUNT_INDEX]: "Transaction contains an invalid account reference",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_DATA]: "Transaction loads an address table account with invalid data",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_INDEX]: "Transaction address table lookup uses an invalid index",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_ADDRESS_LOOKUP_TABLE_OWNER]: "Transaction loads an address table account with an invalid owner",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_LOADED_ACCOUNTS_DATA_SIZE_LIMIT]: "LoadedAccountsDataSizeLimit set for transaction must be greater than 0.",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_PROGRAM_FOR_EXECUTION]: "This program may not be used for executing instructions",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_RENT_PAYING_ACCOUNT]: "Transaction leaves an account with a lower balance than rent-exempt minimum",
    [SOLANA_ERROR__TRANSACTION_ERROR__INVALID_WRITABLE_ACCOUNT]: "Transaction loads a writable account that cannot be written",
    [SOLANA_ERROR__TRANSACTION_ERROR__MAX_LOADED_ACCOUNTS_DATA_SIZE_EXCEEDED]: "Transaction exceeded max loaded accounts data size cap",
    [SOLANA_ERROR__TRANSACTION_ERROR__MISSING_SIGNATURE_FOR_FEE]: "Transaction requires a fee but has no signature present",
    [SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_ACCOUNT_NOT_FOUND]: "Attempt to load a program that does not exist",
    [SOLANA_ERROR__TRANSACTION_ERROR__PROGRAM_EXECUTION_TEMPORARILY_RESTRICTED]: "Execution of the program referenced by account at index $accountIndex is temporarily restricted.",
    [SOLANA_ERROR__TRANSACTION_ERROR__RESANITIZATION_NEEDED]: "ResanitizationNeeded",
    [SOLANA_ERROR__TRANSACTION_ERROR__SANITIZE_FAILURE]: "Transaction failed to sanitize accounts offsets correctly",
    [SOLANA_ERROR__TRANSACTION_ERROR__SIGNATURE_FAILURE]: "Transaction did not pass signature verification",
    [SOLANA_ERROR__TRANSACTION_ERROR__TOO_MANY_ACCOUNT_LOCKS]: "Transaction locked too many accounts",
    [SOLANA_ERROR__TRANSACTION_ERROR__UNBALANCED_TRANSACTION]: "Sum of account balances before and after transaction do not match",
    [SOLANA_ERROR__TRANSACTION_ERROR__UNKNOWN]: "The transaction failed with the error `$errorName`",
    [SOLANA_ERROR__TRANSACTION_ERROR__UNSUPPORTED_VERSION]: "Transaction version is unsupported",
    [SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_ACCOUNT_DATA_BLOCK_LIMIT]: "Transaction would exceed account data limit within the block",
    [SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_ACCOUNT_DATA_TOTAL_LIMIT]: "Transaction would exceed total account data limit",
    [SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_ACCOUNT_COST_LIMIT]: "Transaction would exceed max account limit within the block",
    [SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_BLOCK_COST_LIMIT]: "Transaction would exceed max Block Cost Limit",
    [SOLANA_ERROR__TRANSACTION_ERROR__WOULD_EXCEED_MAX_VOTE_COST_LIMIT]: "Transaction would exceed max Vote Cost Limit",
    [SOLANA_ERROR__TRANSACTION__ADDRESSES_CANNOT_SIGN_TRANSACTION]: "Attempted to sign a transaction with an address that is not a signer for it",
    [SOLANA_ERROR__TRANSACTION__ADDRESS_MISSING]: "Transaction is missing an address at index: $index.",
    [SOLANA_ERROR__TRANSACTION__CANNOT_ENCODE_WITH_EMPTY_SIGNATURES]: "Transaction has no expected signers therefore it cannot be encoded",
    [SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT]: "Transaction size $transactionSize exceeds limit of $transactionSizeLimit bytes",
    [SOLANA_ERROR__TRANSACTION__EXPECTED_BLOCKHASH_LIFETIME]: "Transaction does not have a blockhash lifetime",
    [SOLANA_ERROR__TRANSACTION__EXPECTED_NONCE_LIFETIME]: "Transaction is not a durable nonce transaction",
    [SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_CONTENTS_MISSING]: "Contents of these address lookup tables unknown: $lookupTableAddresses",
    [SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_INDEX_OUT_OF_RANGE]: "Lookup of address at index $highestRequestedIndex failed for lookup table `$lookupTableAddress`. Highest known index is $highestKnownIndex. The lookup table may have been extended since its contents were retrieved",
    [SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_FEE_PAYER_MISSING]: "No fee payer set in CompiledTransaction",
    [SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_INSTRUCTION_PROGRAM_ADDRESS_NOT_FOUND]: "Could not find program address at index $index",
    [SOLANA_ERROR__TRANSACTION__FAILED_TO_ESTIMATE_COMPUTE_LIMIT]: "Failed to estimate the compute unit consumption for this transaction message. This is likely because simulating the transaction failed. Inspect the `cause` property of this error to learn more",
    [SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_COMPUTE_LIMIT]: "Transaction failed when it was simulated in order to estimate the compute unit consumption. The compute unit estimate provided is for a transaction that failed when simulated and may not be representative of the compute units this transaction would consume if successful. Inspect the `cause` property of this error to learn more",
    [SOLANA_ERROR__TRANSACTION__FEE_PAYER_MISSING]: "Transaction is missing a fee payer.",
    [SOLANA_ERROR__TRANSACTION__FEE_PAYER_SIGNATURE_MISSING]: "Could not determine this transaction's signature. Make sure that the transaction has been signed by its fee payer.",
    [SOLANA_ERROR__TRANSACTION__INVALID_NONCE_TRANSACTION_FIRST_INSTRUCTION_MUST_BE_ADVANCE_NONCE]: "Transaction first instruction is not advance nonce account instruction.",
    [SOLANA_ERROR__TRANSACTION__INVALID_NONCE_TRANSACTION_INSTRUCTIONS_MISSING]: "Transaction with no instructions cannot be durable nonce transaction.",
    [SOLANA_ERROR__TRANSACTION__INVOKED_PROGRAMS_CANNOT_PAY_FEES]: "This transaction includes an address (`$programAddress`) which is both invoked and set as the fee payer. Program addresses may not pay fees",
    [SOLANA_ERROR__TRANSACTION__INVOKED_PROGRAMS_MUST_NOT_BE_WRITABLE]: "This transaction includes an address (`$programAddress`) which is both invoked and marked writable. Program addresses may not be writable",
    [SOLANA_ERROR__TRANSACTION__MESSAGE_SIGNATURES_MISMATCH]: "The transaction message expected the transaction to have $signerAddressesLength signatures, got $signaturesLength.",
    [SOLANA_ERROR__TRANSACTION__SIGNATURES_MISSING]: "Transaction is missing signatures for addresses: $addresses.",
    [SOLANA_ERROR__TRANSACTION__VERSION_NUMBER_OUT_OF_RANGE]: "Transaction version must be in the range [0, 127]. `$actualVersion` given"
  };
  SolanaError = class extends Error {
    cause = this.cause;
    context;
    constructor(...[code, contextAndErrorOptions]) {
      let context;
      let errorOptions;
      if (contextAndErrorOptions) {
        const { cause, ...contextRest } = contextAndErrorOptions;
        if (cause) {
          errorOptions = { cause };
        }
        if (Object.keys(contextRest).length > 0) {
          context = contextRest;
        }
      }
      const message = getErrorMessage(code, context);
      super(message, errorOptions);
      this.context = {
        __code: code,
        ...context
      };
      this.name = "SolanaError";
    }
  };
});

// ../../node_modules/.bun/@solana+codecs-core@2.3.0+7524df1edfed9f02/node_modules/@solana/codecs-core/dist/index.browser.mjs
function getEncodedSize(value, encoder) {
  return "fixedSize" in encoder ? encoder.fixedSize : encoder.getSizeFromValue(value);
}
function createEncoder(encoder) {
  return Object.freeze({
    ...encoder,
    encode: (value) => {
      const bytes = new Uint8Array(getEncodedSize(value, encoder));
      encoder.write(value, bytes, 0);
      return bytes;
    }
  });
}
function createDecoder(decoder) {
  return Object.freeze({
    ...decoder,
    decode: (bytes, offset = 0) => decoder.read(bytes, offset)[0]
  });
}
function isFixedSize(codec) {
  return "fixedSize" in codec && typeof codec.fixedSize === "number";
}
function combineCodec(encoder, decoder) {
  if (isFixedSize(encoder) !== isFixedSize(decoder)) {
    throw new SolanaError(SOLANA_ERROR__CODECS__ENCODER_DECODER_SIZE_COMPATIBILITY_MISMATCH);
  }
  if (isFixedSize(encoder) && isFixedSize(decoder) && encoder.fixedSize !== decoder.fixedSize) {
    throw new SolanaError(SOLANA_ERROR__CODECS__ENCODER_DECODER_FIXED_SIZE_MISMATCH, {
      decoderFixedSize: decoder.fixedSize,
      encoderFixedSize: encoder.fixedSize
    });
  }
  if (!isFixedSize(encoder) && !isFixedSize(decoder) && encoder.maxSize !== decoder.maxSize) {
    throw new SolanaError(SOLANA_ERROR__CODECS__ENCODER_DECODER_MAX_SIZE_MISMATCH, {
      decoderMaxSize: decoder.maxSize,
      encoderMaxSize: encoder.maxSize
    });
  }
  return {
    ...decoder,
    ...encoder,
    decode: decoder.decode,
    encode: encoder.encode,
    read: decoder.read,
    write: encoder.write
  };
}
function assertByteArrayIsNotEmptyForCodec(codecDescription, bytes, offset = 0) {
  if (bytes.length - offset <= 0) {
    throw new SolanaError(SOLANA_ERROR__CODECS__CANNOT_DECODE_EMPTY_BYTE_ARRAY, {
      codecDescription
    });
  }
}
function assertByteArrayHasEnoughBytesForCodec(codecDescription, expected, bytes, offset = 0) {
  const bytesLength = bytes.length - offset;
  if (bytesLength < expected) {
    throw new SolanaError(SOLANA_ERROR__CODECS__INVALID_BYTE_LENGTH, {
      bytesLength,
      codecDescription,
      expected
    });
  }
}
var init_index_browser2 = __esm(() => {
  init_index_browser();
});

// ../../node_modules/.bun/@solana+codecs-numbers@2.3.0+7524df1edfed9f02/node_modules/@solana/codecs-numbers/dist/index.browser.mjs
function assertNumberIsBetweenForCodec(codecDescription, min, max, value) {
  if (value < min || value > max) {
    throw new SolanaError(SOLANA_ERROR__CODECS__NUMBER_OUT_OF_RANGE, {
      codecDescription,
      max,
      min,
      value
    });
  }
}
function isLittleEndian(config) {
  return config?.endian === 1 ? false : true;
}
function numberEncoderFactory(input) {
  return createEncoder({
    fixedSize: input.size,
    write(value, bytes, offset) {
      if (input.range) {
        assertNumberIsBetweenForCodec(input.name, input.range[0], input.range[1], value);
      }
      const arrayBuffer = new ArrayBuffer(input.size);
      input.set(new DataView(arrayBuffer), value, isLittleEndian(input.config));
      bytes.set(new Uint8Array(arrayBuffer), offset);
      return offset + input.size;
    }
  });
}
function numberDecoderFactory(input) {
  return createDecoder({
    fixedSize: input.size,
    read(bytes, offset = 0) {
      assertByteArrayIsNotEmptyForCodec(input.name, bytes, offset);
      assertByteArrayHasEnoughBytesForCodec(input.name, input.size, bytes, offset);
      const view = new DataView(toArrayBuffer(bytes, offset, input.size));
      return [input.get(view, isLittleEndian(input.config)), offset + input.size];
    }
  });
}
function toArrayBuffer(bytes, offset, length) {
  const bytesOffset = bytes.byteOffset + (offset ?? 0);
  const bytesLength = length ?? bytes.byteLength;
  return bytes.buffer.slice(bytesOffset, bytesOffset + bytesLength);
}
var getU64Encoder = (config = {}) => numberEncoderFactory({
  config,
  name: "u64",
  range: [0n, BigInt("0xffffffffffffffff")],
  set: (view, value, le) => view.setBigUint64(0, BigInt(value), le),
  size: 8
}), getU64Decoder = (config = {}) => numberDecoderFactory({
  config,
  get: (view, le) => view.getBigUint64(0, le),
  name: "u64",
  size: 8
}), getU64Codec = (config = {}) => combineCodec(getU64Encoder(config), getU64Decoder(config));
var init_index_browser3 = __esm(() => {
  init_index_browser();
  init_index_browser2();
});

// ../../node_modules/.bun/superstruct@2.0.2/node_modules/superstruct/dist/index.mjs
function isIterable(x) {
  return isObject(x) && typeof x[Symbol.iterator] === "function";
}
function isObject(x) {
  return typeof x === "object" && x != null;
}
function isNonArrayObject(x) {
  return isObject(x) && !Array.isArray(x);
}
function print(value) {
  if (typeof value === "symbol") {
    return value.toString();
  }
  return typeof value === "string" ? JSON.stringify(value) : `${value}`;
}
function shiftIterator(input) {
  const { done, value } = input.next();
  return done ? undefined : value;
}
function toFailure(result, context, struct, value) {
  if (result === true) {
    return;
  } else if (result === false) {
    result = {};
  } else if (typeof result === "string") {
    result = { message: result };
  }
  const { path, branch } = context;
  const { type } = struct;
  const { refinement, message = `Expected a value of type \`${type}\`${refinement ? ` with refinement \`${refinement}\`` : ""}, but received: \`${print(value)}\`` } = result;
  return {
    value,
    type,
    refinement,
    key: path[path.length - 1],
    path,
    branch,
    ...result,
    message
  };
}
function* toFailures(result, context, struct, value) {
  if (!isIterable(result)) {
    result = [result];
  }
  for (const r of result) {
    const failure = toFailure(r, context, struct, value);
    if (failure) {
      yield failure;
    }
  }
}
function* run(value, struct, options = {}) {
  const { path = [], branch = [value], coerce = false, mask = false } = options;
  const ctx = { path, branch, mask };
  if (coerce) {
    value = struct.coercer(value, ctx);
  }
  let status = "valid";
  for (const failure of struct.validator(value, ctx)) {
    failure.explanation = options.message;
    status = "not_valid";
    yield [failure, undefined];
  }
  for (let [k, v, s] of struct.entries(value, ctx)) {
    const ts = run(v, s, {
      path: k === undefined ? path : [...path, k],
      branch: k === undefined ? branch : [...branch, v],
      coerce,
      mask,
      message: options.message
    });
    for (const t of ts) {
      if (t[0]) {
        status = t[0].refinement != null ? "not_refined" : "not_valid";
        yield [t[0], undefined];
      } else if (coerce) {
        v = t[1];
        if (k === undefined) {
          value = v;
        } else if (value instanceof Map) {
          value.set(k, v);
        } else if (value instanceof Set) {
          value.add(v);
        } else if (isObject(value)) {
          if (v !== undefined || k in value)
            value[k] = v;
        }
      }
    }
  }
  if (status !== "not_valid") {
    for (const failure of struct.refiner(value, ctx)) {
      failure.explanation = options.message;
      status = "not_refined";
      yield [failure, undefined];
    }
  }
  if (status === "valid") {
    yield [undefined, value];
  }
}

class Struct {
  constructor(props) {
    const { type, schema, validator, refiner, coercer = (value) => value, entries = function* () {} } = props;
    this.type = type;
    this.schema = schema;
    this.entries = entries;
    this.coercer = coercer;
    if (validator) {
      this.validator = (value, context) => {
        const result = validator(value, context);
        return toFailures(result, context, this, value);
      };
    } else {
      this.validator = () => [];
    }
    if (refiner) {
      this.refiner = (value, context) => {
        const result = refiner(value, context);
        return toFailures(result, context, this, value);
      };
    } else {
      this.refiner = () => [];
    }
  }
  assert(value, message) {
    return assert(value, this, message);
  }
  create(value, message) {
    return create(value, this, message);
  }
  is(value) {
    return is(value, this);
  }
  mask(value, message) {
    return mask(value, this, message);
  }
  validate(value, options = {}) {
    return validate(value, this, options);
  }
}
function assert(value, struct, message) {
  const result = validate(value, struct, { message });
  if (result[0]) {
    throw result[0];
  }
}
function create(value, struct, message) {
  const result = validate(value, struct, { coerce: true, message });
  if (result[0]) {
    throw result[0];
  } else {
    return result[1];
  }
}
function mask(value, struct, message) {
  const result = validate(value, struct, { coerce: true, mask: true, message });
  if (result[0]) {
    throw result[0];
  } else {
    return result[1];
  }
}
function is(value, struct) {
  const result = validate(value, struct);
  return !result[0];
}
function validate(value, struct, options = {}) {
  const tuples = run(value, struct, options);
  const tuple = shiftIterator(tuples);
  if (tuple[0]) {
    const error = new StructError(tuple[0], function* () {
      for (const t of tuples) {
        if (t[0]) {
          yield t[0];
        }
      }
    });
    return [error, undefined];
  } else {
    const v = tuple[1];
    return [undefined, v];
  }
}
function define(name, validator) {
  return new Struct({ type: name, schema: null, validator });
}
function any() {
  return define("any", () => true);
}
function array(Element) {
  return new Struct({
    type: "array",
    schema: Element,
    *entries(value) {
      if (Element && Array.isArray(value)) {
        for (const [i, v] of value.entries()) {
          yield [i, v, Element];
        }
      }
    },
    coercer(value) {
      return Array.isArray(value) ? value.slice() : value;
    },
    validator(value) {
      return Array.isArray(value) || `Expected an array value, but received: ${print(value)}`;
    }
  });
}
function boolean() {
  return define("boolean", (value) => {
    return typeof value === "boolean";
  });
}
function instance(Class) {
  return define("instance", (value) => {
    return value instanceof Class || `Expected a \`${Class.name}\` instance, but received: ${print(value)}`;
  });
}
function literal(constant) {
  const description = print(constant);
  const t = typeof constant;
  return new Struct({
    type: "literal",
    schema: t === "string" || t === "number" || t === "boolean" ? constant : null,
    validator(value) {
      return value === constant || `Expected the literal \`${description}\`, but received: ${print(value)}`;
    }
  });
}
function never() {
  return define("never", () => false);
}
function nullable(struct) {
  return new Struct({
    ...struct,
    validator: (value, ctx) => value === null || struct.validator(value, ctx),
    refiner: (value, ctx) => value === null || struct.refiner(value, ctx)
  });
}
function number() {
  return define("number", (value) => {
    return typeof value === "number" && !isNaN(value) || `Expected a number, but received: ${print(value)}`;
  });
}
function optional(struct) {
  return new Struct({
    ...struct,
    validator: (value, ctx) => value === undefined || struct.validator(value, ctx),
    refiner: (value, ctx) => value === undefined || struct.refiner(value, ctx)
  });
}
function record(Key, Value) {
  return new Struct({
    type: "record",
    schema: null,
    *entries(value) {
      if (isObject(value)) {
        for (const k in value) {
          const v = value[k];
          yield [k, k, Key];
          yield [k, v, Value];
        }
      }
    },
    validator(value) {
      return isNonArrayObject(value) || `Expected an object, but received: ${print(value)}`;
    },
    coercer(value) {
      return isNonArrayObject(value) ? { ...value } : value;
    }
  });
}
function string() {
  return define("string", (value) => {
    return typeof value === "string" || `Expected a string, but received: ${print(value)}`;
  });
}
function tuple(Structs) {
  const Never = never();
  return new Struct({
    type: "tuple",
    schema: null,
    *entries(value) {
      if (Array.isArray(value)) {
        const length = Math.max(Structs.length, value.length);
        for (let i = 0;i < length; i++) {
          yield [i, value[i], Structs[i] || Never];
        }
      }
    },
    validator(value) {
      return Array.isArray(value) || `Expected an array, but received: ${print(value)}`;
    },
    coercer(value) {
      return Array.isArray(value) ? value.slice() : value;
    }
  });
}
function type(schema) {
  const keys = Object.keys(schema);
  return new Struct({
    type: "type",
    schema,
    *entries(value) {
      if (isObject(value)) {
        for (const k of keys) {
          yield [k, value[k], schema[k]];
        }
      }
    },
    validator(value) {
      return isNonArrayObject(value) || `Expected an object, but received: ${print(value)}`;
    },
    coercer(value) {
      return isNonArrayObject(value) ? { ...value } : value;
    }
  });
}
function union(Structs) {
  const description = Structs.map((s) => s.type).join(" | ");
  return new Struct({
    type: "union",
    schema: null,
    coercer(value, ctx) {
      for (const S of Structs) {
        const [error, coerced] = S.validate(value, {
          coerce: true,
          mask: ctx.mask
        });
        if (!error) {
          return coerced;
        }
      }
      return value;
    },
    validator(value, ctx) {
      const failures = [];
      for (const S of Structs) {
        const [...tuples] = run(value, S, ctx);
        const [first] = tuples;
        if (!first[0]) {
          return [];
        } else {
          for (const [failure] of tuples) {
            if (failure) {
              failures.push(failure);
            }
          }
        }
      }
      return [
        `Expected the value to satisfy a union of \`${description}\`, but received: ${print(value)}`,
        ...failures
      ];
    }
  });
}
function unknown() {
  return define("unknown", () => true);
}
function coerce(struct, condition, coercer) {
  return new Struct({
    ...struct,
    coercer: (value, ctx) => {
      return is(value, condition) ? struct.coercer(coercer(value, ctx), ctx) : struct.coercer(value, ctx);
    }
  });
}
var StructError;
var init_dist = __esm(() => {
  StructError = class StructError extends TypeError {
    constructor(failure, failures) {
      let cached;
      const { message, explanation, ...rest } = failure;
      const { path } = failure;
      const msg = path.length === 0 ? message : `At path: ${path.join(".")} -- ${message}`;
      super(explanation ?? msg);
      if (explanation != null)
        this.cause = msg;
      Object.assign(this, rest);
      this.name = this.constructor.name;
      this.failures = () => {
        return cached ?? (cached = [failure, ...failures()]);
      };
    }
  };
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/rng.js
function rng() {
  if (!getRandomValues) {
    getRandomValues = typeof crypto !== "undefined" && crypto.getRandomValues && crypto.getRandomValues.bind(crypto) || typeof msCrypto !== "undefined" && typeof msCrypto.getRandomValues === "function" && msCrypto.getRandomValues.bind(msCrypto);
    if (!getRandomValues) {
      throw new Error("crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported");
    }
  }
  return getRandomValues(rnds8);
}
var getRandomValues, rnds8;
var init_rng = __esm(() => {
  rnds8 = new Uint8Array(16);
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/regex.js
var regex_default;
var init_regex = __esm(() => {
  regex_default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/validate.js
function validate2(uuid) {
  return typeof uuid === "string" && regex_default.test(uuid);
}
var validate_default;
var init_validate = __esm(() => {
  init_regex();
  validate_default = validate2;
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/stringify.js
function stringify(arr) {
  var offset = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
  var uuid = (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
  if (!validate_default(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
var byteToHex, i2, stringify_default;
var init_stringify = __esm(() => {
  init_validate();
  byteToHex = [];
  for (i2 = 0;i2 < 256; ++i2) {
    byteToHex.push((i2 + 256).toString(16).substr(1));
  }
  stringify_default = stringify;
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/v4.js
function v4(options, buf, offset) {
  options = options || {};
  var rnds = options.random || (options.rng || rng)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (var i = 0;i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return stringify_default(rnds);
}
var v4_default;
var init_v4 = __esm(() => {
  init_rng();
  init_stringify();
  v4_default = v4;
});

// ../../node_modules/.bun/uuid@8.3.2/node_modules/uuid/dist/esm-browser/index.js
var exports_esm_browser = {};
__export(exports_esm_browser, {
  v4: () => v4_default
});
var init_esm_browser = __esm(() => {
  init_v4();
});

// ../../node_modules/.bun/jayson@4.3.0+4789783d1fa00420/node_modules/jayson/lib/generateRequest.js
var require_generateRequest = __commonJS(function(exports, module) {
  var uuid = (init_esm_browser(), __toCommonJS(exports_esm_browser)).v4;
  var generateRequest = function(method, params, id, options) {
    if (typeof method !== "string") {
      throw new TypeError(method + " must be a string");
    }
    options = options || {};
    const version = typeof options.version === "number" ? options.version : 2;
    if (version !== 1 && version !== 2) {
      throw new TypeError(version + " must be 1 or 2");
    }
    const request = {
      method
    };
    if (version === 2) {
      request.jsonrpc = "2.0";
    }
    if (params) {
      if (typeof params !== "object" && !Array.isArray(params)) {
        throw new TypeError(params + " must be an object, array or omitted");
      }
      request.params = params;
    }
    if (typeof id === "undefined") {
      const generator = typeof options.generator === "function" ? options.generator : function() {
        return uuid();
      };
      request.id = generator(request, options);
    } else if (version === 2 && id === null) {
      if (options.notificationIdNull) {
        request.id = null;
      }
    } else {
      request.id = id;
    }
    return request;
  };
  module.exports = generateRequest;
});

// ../../node_modules/.bun/jayson@4.3.0+4789783d1fa00420/node_modules/jayson/lib/client/browser/index.js
var require_browser = __commonJS(function(exports, module) {
  var uuid = (init_esm_browser(), __toCommonJS(exports_esm_browser)).v4;
  var generateRequest = require_generateRequest();
  var ClientBrowser = function(callServer, options) {
    if (!(this instanceof ClientBrowser)) {
      return new ClientBrowser(callServer, options);
    }
    if (!options) {
      options = {};
    }
    this.options = {
      reviver: typeof options.reviver !== "undefined" ? options.reviver : null,
      replacer: typeof options.replacer !== "undefined" ? options.replacer : null,
      generator: typeof options.generator !== "undefined" ? options.generator : function() {
        return uuid();
      },
      version: typeof options.version !== "undefined" ? options.version : 2,
      notificationIdNull: typeof options.notificationIdNull === "boolean" ? options.notificationIdNull : false
    };
    this.callServer = callServer;
  };
  module.exports = ClientBrowser;
  ClientBrowser.prototype.request = function(method, params, id, callback) {
    const self = this;
    let request = null;
    const isBatch = Array.isArray(method) && typeof params === "function";
    if (this.options.version === 1 && isBatch) {
      throw new TypeError("JSON-RPC 1.0 does not support batching");
    }
    const isRaw = !isBatch && method && typeof method === "object" && typeof params === "function";
    if (isBatch || isRaw) {
      callback = params;
      request = method;
    } else {
      if (typeof id === "function") {
        callback = id;
        id = undefined;
      }
      const hasCallback = typeof callback === "function";
      try {
        request = generateRequest(method, params, id, {
          generator: this.options.generator,
          version: this.options.version,
          notificationIdNull: this.options.notificationIdNull
        });
      } catch (err) {
        if (hasCallback) {
          callback(err);
          return;
        }
        throw err;
      }
      if (!hasCallback) {
        return request;
      }
    }
    let message;
    try {
      message = JSON.stringify(request, this.options.replacer);
    } catch (err) {
      callback(err);
      return;
    }
    this.callServer(message, function(err, response) {
      self._parseResponse(err, response, callback);
    });
    return request;
  };
  ClientBrowser.prototype._parseResponse = function(err, responseText, callback) {
    if (err) {
      callback(err);
      return;
    }
    if (!responseText) {
      callback();
      return;
    }
    let response;
    try {
      response = JSON.parse(responseText, this.options.reviver);
    } catch (err) {
      callback(err);
      return;
    }
    if (callback.length === 3) {
      if (Array.isArray(response)) {
        const isError = function(res) {
          return typeof res.error !== "undefined";
        };
        const isNotError = function(res) {
          return !isError(res);
        };
        callback(null, response.filter(isError), response.filter(isNotError));
        return;
      } else {
        callback(null, response.error, response.result);
        return;
      }
    }
    callback(null, response);
  };
});

// ../../node_modules/.bun/rpc-websockets@9.3.10/node_modules/rpc-websockets/dist/index.browser.mjs
var init_index_browser4 = __esm(() => {
  init_buffer();
  init_eventemitter3();
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha3.js
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds;round < 24; round++) {
    for (let x = 0;x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0;x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0;y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0;t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0;y < 50; y += 10) {
      for (let x = 0;x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0;x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var _0n6, _1n6, _2n4, _7n2, _256n, _0x71n, SHA3_PI, SHA3_ROTL, _SHA3_IOTA, IOTAS, SHA3_IOTA_H, SHA3_IOTA_L, rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s), rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s), Keccak, gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen)), keccak_256;
var init_sha3 = __esm(() => {
  init__u64();
  init_utils();
  _0n6 = BigInt(0);
  _1n6 = BigInt(1);
  _2n4 = BigInt(2);
  _7n2 = BigInt(7);
  _256n = BigInt(256);
  _0x71n = BigInt(113);
  SHA3_PI = [];
  SHA3_ROTL = [];
  _SHA3_IOTA = [];
  for (let round = 0, R = _1n6, x = 1, y = 0;round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n6;
    for (let j = 0;j < 7; j++) {
      R = (R << _1n6 ^ (R >> _7n2) * _0x71n) % _256n;
      if (R & _2n4)
        t ^= _1n6 << (_1n6 << /* @__PURE__ */ BigInt(j)) - _1n6;
    }
    _SHA3_IOTA.push(t);
  }
  IOTAS = split(_SHA3_IOTA, true);
  SHA3_IOTA_H = IOTAS[0];
  SHA3_IOTA_L = IOTAS[1];
  Keccak = class Keccak extends Hash {
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
      super();
      this.pos = 0;
      this.posOut = 0;
      this.finished = false;
      this.destroyed = false;
      this.enableXOF = false;
      this.blockLen = blockLen;
      this.suffix = suffix;
      this.outputLen = outputLen;
      this.enableXOF = enableXOF;
      this.rounds = rounds;
      anumber(outputLen);
      if (!(0 < blockLen && blockLen < 200))
        throw new Error("only keccak-f1600 function is supported");
      this.state = new Uint8Array(200);
      this.state32 = u32(this.state);
    }
    clone() {
      return this._cloneInto();
    }
    keccak() {
      swap32IfBE(this.state32);
      keccakP(this.state32, this.rounds);
      swap32IfBE(this.state32);
      this.posOut = 0;
      this.pos = 0;
    }
    update(data) {
      aexists(this);
      data = toBytes(data);
      abytes(data);
      const { blockLen, state } = this;
      const len = data.length;
      for (let pos = 0;pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        for (let i = 0;i < take; i++)
          state[this.pos++] ^= data[pos++];
        if (this.pos === blockLen)
          this.keccak();
      }
      return this;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      const { state, suffix, pos, blockLen } = this;
      state[pos] ^= suffix;
      if ((suffix & 128) !== 0 && pos === blockLen - 1)
        this.keccak();
      state[blockLen - 1] ^= 128;
      this.keccak();
    }
    writeInto(out) {
      aexists(this, false);
      abytes(out);
      this.finish();
      const bufferOut = this.state;
      const { blockLen } = this;
      for (let pos = 0, len = out.length;pos < len; ) {
        if (this.posOut >= blockLen)
          this.keccak();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible for this instance");
      return this.writeInto(out);
    }
    xof(bytes) {
      anumber(bytes);
      return this.xofInto(new Uint8Array(bytes));
    }
    digestInto(out) {
      aoutput(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.writeInto(out);
      this.destroy();
      return out;
    }
    digest() {
      return this.digestInto(new Uint8Array(this.outputLen));
    }
    destroy() {
      this.destroyed = true;
      clean(this.state);
    }
    _cloneInto(to) {
      const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
      to || (to = new Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
      to.state32.set(this.state32);
      to.pos = this.pos;
      to.posOut = this.posOut;
      to.finished = this.finished;
      to.rounds = rounds;
      to.suffix = suffix;
      to.outputLen = outputLen;
      to.enableXOF = enableXOF;
      to.destroyed = this.destroyed;
      return to;
    }
  };
  keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();
});

// ../../node_modules/.bun/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/hmac.js
var HMAC, hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
var init_hmac = __esm(() => {
  init_utils();
  HMAC = class HMAC extends Hash {
    constructor(hash, _key) {
      super();
      this.finished = false;
      this.destroyed = false;
      ahash(hash);
      const key = toBytes(_key);
      this.iHash = hash.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
      for (let i = 0;i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash.create();
      for (let i = 0;i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      clean(pad);
    }
    update(buf) {
      aexists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      aexists(this);
      abytes(out, this.outputLen);
      this.finished = true;
      this.iHash.digestInto(out);
      this.oHash.update(out);
      this.oHash.digestInto(out);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to || (to = Object.create(Object.getPrototypeOf(this), {}));
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  hmac.create = (hash, key) => new HMAC(hash, key);
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/abstract/weierstrass.js
function _splitEndoScalar(k, basis, n) {
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n7;
  const k2neg = k2 < _0n7;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n7;
  if (k1 < _0n7 || k1 >= MAX_NUM || k2 < _0n7 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed, k=" + k);
  }
  return { k1neg, k1, k2neg, k2 };
}
function validateSigFormat(format) {
  if (!["compact", "recovered", "der"].includes(format))
    throw new Error('Signature format must be "compact", "recovered", or "der"');
  return format;
}
function validateSigOpts(opts, def) {
  const optsn = {};
  for (let optName of Object.keys(def)) {
    optsn[optName] = opts[optName] === undefined ? def[optName] : opts[optName];
  }
  _abool2(optsn.lowS, "lowS");
  _abool2(optsn.prehash, "prehash");
  if (optsn.format !== undefined)
    validateSigFormat(optsn.format);
  return optsn;
}
function _normFnElement(Fn, key) {
  const { BYTES: expected } = Fn;
  let num;
  if (typeof key === "bigint") {
    num = key;
  } else {
    let bytes = ensureBytes("private key", key);
    try {
      num = Fn.fromBytes(bytes);
    } catch (error) {
      throw new Error(`invalid private key: expected ui8a of size ${expected}, got ${typeof key}`);
    }
  }
  if (!Fn.isValidNot0(num))
    throw new Error("invalid private key: out of range [1..N-1]");
  return num;
}
function weierstrassN(params, extraOpts = {}) {
  const validated = _createCurveFields("weierstrass", params, extraOpts);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  _validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object",
    wrapPrivateKey: "boolean"
  });
  const { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    _abool2(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    _abytes2(bytes, undefined, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const isYOdd = Fp.isOdd(y);
      const isHeadOdd = (head & 1) === 1;
      if (isHeadOdd !== isYOdd)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = extraOpts.toBytes || pointToBytes;
  const decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n3), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ProjectivePoint expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE))
      return { x: X, y: Y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(Z);
    const x = Fp.mul(X, iz);
    const y = Fp.mul(Y, iz);
    const zz = Fp.mul(Z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }

  class Point {
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(_abytes2(bytes, undefined, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex) {
      return Point.fromBytes(ensureBytes("pointHex", hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_3n3);
      return this;
    }
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n3);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n3);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    multiply(scalar) {
      const { endo } = extraOpts;
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
        const { p: k1p, f: k1f } = mul(k1);
        const { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul(scalar);
        point = p;
        fake = f;
      }
      return normalizeZ(Point, [point, fake])[0];
    }
    multiplyUnsafe(sc) {
      const { endo } = extraOpts;
      const p = this;
      if (!Fn.isValid(sc))
        throw new Error("invalid scalar: out of range");
      if (sc === _0n7 || p.is0())
        return Point.ZERO;
      if (sc === _1n7)
        return p;
      if (wnaf.hasCache(this))
        return this.multiply(sc);
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
        const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.unsafe(p, sc);
      }
    }
    multiplyAndAddUnsafe(Q, a, b) {
      const sum = this.multiplyUnsafe(a).add(Q.multiplyUnsafe(b));
      return sum.is0() ? undefined : sum;
    }
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    isTorsionFree() {
      const { isTorsionFree } = extraOpts;
      if (cofactor === _1n7)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      const { clearCofactor } = extraOpts;
      if (cofactor === _1n7)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = true) {
      _abool2(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
    get px() {
      return this.X;
    }
    get py() {
      return this.X;
    }
    get pz() {
      return this.Z;
    }
    toRawBytes(isCompressed = true) {
      return this.toBytes(isCompressed);
    }
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    static normalizeZ(points) {
      return normalizeZ(Point, points);
    }
    static msm(points, scalars) {
      return pippenger(Point, Fn, points, scalars);
    }
    static fromPrivateKey(privateKey) {
      return Point.BASE.multiply(_normFnElement(Fn, privateKey));
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point.ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
  Point.Fp = Fp;
  Point.Fn = Fn;
  const bits = Fn.BITS;
  const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  Point.BASE.precompute(8);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}
function ecdh(Point, ecdhOpts = {}) {
  const { Fn } = Point;
  const randomBytes_ = ecdhOpts.randomBytes || randomBytes;
  const lengths = Object.assign(getWLengths(Point.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });
  function isValidSecretKey(secretKey) {
    try {
      return !!_normFnElement(Fn, secretKey);
    } catch (error) {
      return false;
    }
  }
  function isValidPublicKey(publicKey, isCompressed) {
    const { publicKey: comp, publicKeyUncompressed } = lengths;
    try {
      const l = publicKey.length;
      if (isCompressed === true && l !== comp)
        return false;
      if (isCompressed === false && l !== publicKeyUncompressed)
        return false;
      return !!Point.fromBytes(publicKey);
    } catch (error) {
      return false;
    }
  }
  function randomSecretKey(seed = randomBytes_(lengths.seed)) {
    return mapHashToField(_abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
  }
  function getPublicKey(secretKey, isCompressed = true) {
    return Point.BASE.multiply(_normFnElement(Fn, secretKey)).toBytes(isCompressed);
  }
  function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  }
  function isProbPub(item) {
    if (typeof item === "bigint")
      return false;
    if (item instanceof Point)
      return true;
    const { secretKey, publicKey, publicKeyUncompressed } = lengths;
    if (Fn.allowedLengths || secretKey === publicKey)
      return;
    const l = ensureBytes("key", item).length;
    return l === publicKey || l === publicKeyUncompressed;
  }
  function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
    if (isProbPub(secretKeyA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicKeyB) === false)
      throw new Error("second arg must be public key");
    const s = _normFnElement(Fn, secretKeyA);
    const b = Point.fromHex(publicKeyB);
    return b.multiply(s).toBytes(isCompressed);
  }
  const utils = {
    isValidSecretKey,
    isValidPublicKey,
    randomSecretKey,
    isValidPrivateKey: isValidSecretKey,
    randomPrivateKey: randomSecretKey,
    normPrivateKeyToScalar: (key) => _normFnElement(Fn, key),
    precompute(windowSize = 8, point = Point.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
}
function ecdsa(Point, hash, ecdsaOpts = {}) {
  ahash(hash);
  _validateObject(ecdsaOpts, {}, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  const randomBytes2 = ecdsaOpts.randomBytes || randomBytes;
  const hmac2 = ecdsaOpts.hmac || ((key, ...msgs) => hmac(hash, key, concatBytes(...msgs)));
  const { Fp, Fn } = Point;
  const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
  const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, ecdsaOpts);
  const defaultSigOpts = {
    prehash: false,
    lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : false,
    format: undefined,
    extraEntropy: false
  };
  const defaultSigOpts_format = "compact";
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n7;
    return number > HALF;
  }
  function validateRS(title, num) {
    if (!Fn.isValidNot0(num))
      throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
    return num;
  }
  function validateSigLength(bytes, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : undefined;
    return _abytes2(bytes, sizer, `${format} signature`);
  }

  class Signature {
    constructor(r, s, recovery) {
      this.r = validateRS("r", r);
      this.s = validateRS("s", s);
      if (recovery != null)
        this.recovery = recovery;
      Object.freeze(this);
    }
    static fromBytes(bytes, format = defaultSigOpts_format) {
      validateSigLength(bytes, format);
      let recid;
      if (format === "der") {
        const { r, s } = DER.toSig(_abytes2(bytes));
        return new Signature(r, s);
      }
      if (format === "recovered") {
        recid = bytes[0];
        format = "compact";
        bytes = bytes.subarray(1);
      }
      const L = Fn.BYTES;
      const r = bytes.subarray(0, L);
      const s = bytes.subarray(L, L * 2);
      return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
    }
    static fromHex(hex, format) {
      return this.fromBytes(hexToBytes(hex), format);
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(messageHash) {
      const FIELD_ORDER = Fp.ORDER;
      const { r, s, recovery: rec } = this;
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const hasCofactor = CURVE_ORDER * _2n5 < FIELD_ORDER;
      if (hasCofactor && rec > 1)
        throw new Error("recovery id is ambiguous for h>1 curve");
      const radj = rec === 2 || rec === 3 ? r + CURVE_ORDER : r;
      if (!Fp.isValid(radj))
        throw new Error("recovery id 2 or 3 invalid");
      const x = Fp.toBytes(radj);
      const R = Point.fromBytes(concatBytes(pprefix((rec & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(ensureBytes("msgHash", messageHash));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
      if (Q.is0())
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    toBytes(format = defaultSigOpts_format) {
      validateSigFormat(format);
      if (format === "der")
        return hexToBytes(DER.hexFromSig(this));
      const r = Fn.toBytes(this.r);
      const s = Fn.toBytes(this.s);
      if (format === "recovered") {
        if (this.recovery == null)
          throw new Error("recovery bit must be present");
        return concatBytes(Uint8Array.of(this.recovery), r, s);
      }
      return concatBytes(r, s);
    }
    toHex(format) {
      return bytesToHex(this.toBytes(format));
    }
    assertValidity() {}
    static fromCompact(hex) {
      return Signature.fromBytes(ensureBytes("sig", hex), "compact");
    }
    static fromDER(hex) {
      return Signature.fromBytes(ensureBytes("sig", hex), "der");
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, Fn.neg(this.s), this.recovery) : this;
    }
    toDERRawBytes() {
      return this.toBytes("der");
    }
    toDERHex() {
      return bytesToHex(this.toBytes("der"));
    }
    toCompactRawBytes() {
      return this.toBytes("compact");
    }
    toCompactHex() {
      return bytesToHex(this.toBytes("compact"));
    }
  }
  const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {
    return Fn.create(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num) {
    aInRange("num < 2^" + fnBits, num, _0n7, ORDER_MASK);
    return Fn.toBytes(num);
  }
  function validateMsgAndHash(message, prehash) {
    _abytes2(message, undefined, "message");
    return prehash ? _abytes2(hash(message), undefined, "prehashed message") : message;
  }
  function prepSig(message, privateKey, opts) {
    if (["recovered", "canonical"].some((k) => (k in opts)))
      throw new Error("sign() legacy options not supported");
    const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    const h1int = bits2int_modN(message);
    const d = _normFnElement(Fn, privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes2(lengths.secretKey) : extraEntropy;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const ik = Fn.inv(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n7)
        return;
      const s = Fn.create(ik * Fn.create(m + r * d));
      if (s === _0n7)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n7);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = Fn.neg(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  function sign(message, secretKey, opts = {}) {
    message = ensureBytes("message", message);
    const { seed, k2sig } = prepSig(message, secretKey, opts);
    const drbg = createHmacDrbg(hash.outputLen, Fn.BYTES, hmac2);
    const sig = drbg(seed, k2sig);
    return sig;
  }
  function tryParsingSig(sg) {
    let sig = undefined;
    const isHex = typeof sg === "string" || isBytes(sg);
    const isObj = !isHex && sg !== null && typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    if (isObj) {
      sig = new Signature(sg.r, sg.s);
    } else if (isHex) {
      try {
        sig = Signature.fromBytes(ensureBytes("sig", sg), "der");
      } catch (derError) {
        if (!(derError instanceof DER.Err))
          throw derError;
      }
      if (!sig) {
        try {
          sig = Signature.fromBytes(ensureBytes("sig", sg), "compact");
        } catch (error) {
          return false;
        }
      }
    }
    if (!sig)
      return false;
    return sig;
  }
  function verify(signature, message, publicKey, opts = {}) {
    const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
    publicKey = ensureBytes("publicKey", publicKey);
    message = validateMsgAndHash(ensureBytes("message", message), prehash);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    const sig = format === undefined ? tryParsingSig(signature) : Signature.fromBytes(ensureBytes("sig", signature), format);
    if (sig === false)
      return false;
    try {
      const P = Point.fromBytes(publicKey);
      if (lowS && sig.hasHighS())
        return false;
      const { r, s } = sig;
      const h = bits2int_modN(message);
      const is = Fn.inv(s);
      const u1 = Fn.create(h * is);
      const u2 = Fn.create(r * is);
      const R = Point.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
      if (R.is0())
        return false;
      const v = Fn.create(R.x);
      return v === r;
    } catch (e) {
      return false;
    }
  }
  function recoverPublicKey(signature, message, opts = {}) {
    const { prehash } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
  }
  return Object.freeze({
    keygen,
    getPublicKey,
    getSharedSecret,
    utils,
    lengths,
    Point,
    sign,
    verify,
    recoverPublicKey,
    Signature,
    hash
  });
}
function _weierstrass_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    b: c.b,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp = c.Fp;
  let allowedLengths = c.allowedPrivateKeyLengths ? Array.from(new Set(c.allowedPrivateKeyLengths.map((l) => Math.ceil(l / 2)))) : undefined;
  const Fn = Field(CURVE.n, {
    BITS: c.nBitLength,
    allowedLengths,
    modFromBytes: c.wrapPrivateKey
  });
  const curveOpts = {
    Fp,
    Fn,
    allowInfinityPoint: c.allowInfinityPoint,
    endo: c.endo,
    isTorsionFree: c.isTorsionFree,
    clearCofactor: c.clearCofactor,
    fromBytes: c.fromBytes,
    toBytes: c.toBytes
  };
  return { CURVE, curveOpts };
}
function _ecdsa_legacy_opts_to_new(c) {
  const { CURVE, curveOpts } = _weierstrass_legacy_opts_to_new(c);
  const ecdsaOpts = {
    hmac: c.hmac,
    randomBytes: c.randomBytes,
    lowS: c.lowS,
    bits2int: c.bits2int,
    bits2int_modN: c.bits2int_modN
  };
  return { CURVE, curveOpts, hash: c.hash, ecdsaOpts };
}
function _ecdsa_new_output_to_legacy(c, _ecdsa) {
  const Point = _ecdsa.Point;
  return Object.assign({}, _ecdsa, {
    ProjectivePoint: Point,
    CURVE: Object.assign({}, c, nLength(Point.Fn.ORDER, Point.Fn.BITS))
  });
}
function weierstrass(c) {
  const { CURVE, curveOpts, hash, ecdsaOpts } = _ecdsa_legacy_opts_to_new(c);
  const Point = weierstrassN(CURVE, curveOpts);
  const signs = ecdsa(Point, hash, ecdsaOpts);
  return _ecdsa_new_output_to_legacy(c, signs);
}
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n5) / den, DERErr, DER, _0n7, _1n7, _2n5, _3n3, _4n2;
var init_weierstrass = __esm(() => {
  init_hmac();
  init_utils();
  init_utils2();
  init_curve();
  init_modular();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  DERErr = class DERErr extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  DER = {
    Err: DERErr,
    _tlv: {
      encode: (tag, data) => {
        const { Err: E } = DER;
        if (tag < 0 || tag > 256)
          throw new E("tlv.encode: wrong tag");
        if (data.length & 1)
          throw new E("tlv.encode: unpadded data");
        const dataLen = data.length / 2;
        const len = numberToHexUnpadded(dataLen);
        if (len.length / 2 & 128)
          throw new E("tlv.encode: long form length too big");
        const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
        const t = numberToHexUnpadded(tag);
        return t + lenLen + len + data;
      },
      decode(tag, data) {
        const { Err: E } = DER;
        let pos = 0;
        if (tag < 0 || tag > 256)
          throw new E("tlv.encode: wrong tag");
        if (data.length < 2 || data[pos++] !== tag)
          throw new E("tlv.decode: wrong tlv");
        const first = data[pos++];
        const isLong = !!(first & 128);
        let length = 0;
        if (!isLong)
          length = first;
        else {
          const lenLen = first & 127;
          if (!lenLen)
            throw new E("tlv.decode(long): indefinite length not supported");
          if (lenLen > 4)
            throw new E("tlv.decode(long): byte length is too big");
          const lengthBytes = data.subarray(pos, pos + lenLen);
          if (lengthBytes.length !== lenLen)
            throw new E("tlv.decode: length bytes not complete");
          if (lengthBytes[0] === 0)
            throw new E("tlv.decode(long): zero leftmost byte");
          for (const b of lengthBytes)
            length = length << 8 | b;
          pos += lenLen;
          if (length < 128)
            throw new E("tlv.decode(long): not minimal encoding");
        }
        const v = data.subarray(pos, pos + length);
        if (v.length !== length)
          throw new E("tlv.decode: wrong value length");
        return { v, l: data.subarray(pos + length) };
      }
    },
    _int: {
      encode(num) {
        const { Err: E } = DER;
        if (num < _0n7)
          throw new E("integer: negative integers are not allowed");
        let hex = numberToHexUnpadded(num);
        if (Number.parseInt(hex[0], 16) & 8)
          hex = "00" + hex;
        if (hex.length & 1)
          throw new E("unexpected DER parsing assertion: unpadded hex");
        return hex;
      },
      decode(data) {
        const { Err: E } = DER;
        if (data[0] & 128)
          throw new E("invalid signature integer: negative");
        if (data[0] === 0 && !(data[1] & 128))
          throw new E("invalid signature integer: unnecessary leading zero");
        return bytesToNumberBE(data);
      }
    },
    toSig(hex) {
      const { Err: E, _int: int, _tlv: tlv } = DER;
      const data = ensureBytes("signature", hex);
      const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
      if (seqLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
      const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
      if (sLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      return { r: int.decode(rBytes), s: int.decode(sBytes) };
    },
    hexFromSig(sig) {
      const { _tlv: tlv, _int: int } = DER;
      const rs = tlv.encode(2, int.encode(sig.r));
      const ss = tlv.encode(2, int.encode(sig.s));
      const seq = rs + ss;
      return tlv.encode(48, seq);
    }
  };
  _0n7 = BigInt(0);
  _1n7 = BigInt(1);
  _2n5 = BigInt(2);
  _3n3 = BigInt(3);
  _4n2 = BigInt(4);
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/_shortw_utils.js
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, hash });
  return { ...create(defHash), create };
}
var init__shortw_utils = __esm(() => {
  init_weierstrass();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
});

// ../../node_modules/.bun/@noble+curves@1.9.7/node_modules/@noble/curves/esm/secp256k1.js
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n, P) * b3 % P;
  const b9 = pow2(b6, _3n, P) * b3 % P;
  const b11 = pow2(b9, _2n6, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n6, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var secp256k1_CURVE, secp256k1_ENDO, _2n6, Fpk1, secp256k1;
var init_secp256k1 = __esm(() => {
  init_sha2();
  init__shortw_utils();
  init_modular();
  /*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
  secp256k1_CURVE = {
    p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
    n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
    h: BigInt(1),
    a: BigInt(0),
    b: BigInt(7),
    Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
    Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
  };
  secp256k1_ENDO = {
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    basises: [
      [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
      [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
    ]
  };
  _2n6 = /* @__PURE__ */ BigInt(2);
  Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
  secp256k1 = createCurve({ ...secp256k1_CURVE, Fp: Fpk1, lowS: true, endo: secp256k1_ENDO }, sha256);
});

// ../../node_modules/.bun/@solana+web3.js@1.98.4+009971104ee2239c/node_modules/@solana/web3.js/lib/index.browser.esm.js
function isOnCurve(publicKey) {
  try {
    ed25519.ExtendedPoint.fromHex(publicKey);
    return true;
  } catch {
    return false;
  }
}

class Struct2 {
  constructor(properties) {
    Object.assign(this, properties);
  }
  encode() {
    return Buffer2.from(import_borsh.serialize(SOLANA_SCHEMA, this));
  }
  static decode(data) {
    return import_borsh.deserialize(SOLANA_SCHEMA, this, data);
  }
  static decodeUnchecked(data) {
    return import_borsh.deserializeUnchecked(SOLANA_SCHEMA, this, data);
  }
}
function isPublicKeyData(value) {
  return value._bn !== undefined;
}

class MessageAccountKeys {
  constructor(staticAccountKeys, accountKeysFromLookups) {
    this.staticAccountKeys = undefined;
    this.accountKeysFromLookups = undefined;
    this.staticAccountKeys = staticAccountKeys;
    this.accountKeysFromLookups = accountKeysFromLookups;
  }
  keySegments() {
    const keySegments = [this.staticAccountKeys];
    if (this.accountKeysFromLookups) {
      keySegments.push(this.accountKeysFromLookups.writable);
      keySegments.push(this.accountKeysFromLookups.readonly);
    }
    return keySegments;
  }
  get(index) {
    for (const keySegment of this.keySegments()) {
      if (index < keySegment.length) {
        return keySegment[index];
      } else {
        index -= keySegment.length;
      }
    }
    return;
  }
  get length() {
    return this.keySegments().flat().length;
  }
  compileInstructions(instructions) {
    const U8_MAX = 255;
    if (this.length > U8_MAX + 1) {
      throw new Error("Account index overflow encountered during compilation");
    }
    const keyIndexMap = new Map;
    this.keySegments().flat().forEach((key, index) => {
      keyIndexMap.set(key.toBase58(), index);
    });
    const findKeyIndex = (key) => {
      const keyIndex = keyIndexMap.get(key.toBase58());
      if (keyIndex === undefined)
        throw new Error("Encountered an unknown instruction account key during compilation");
      return keyIndex;
    };
    return instructions.map((instruction) => {
      return {
        programIdIndex: findKeyIndex(instruction.programId),
        accountKeyIndexes: instruction.keys.map((meta) => findKeyIndex(meta.pubkey)),
        data: instruction.data
      };
    });
  }
}
function getAlloc(type, fields) {
  const getItemAlloc = (item) => {
    if (item.span >= 0) {
      return item.span;
    } else if (typeof item.alloc === "function") {
      return item.alloc(fields[item.property]);
    } else if ("count" in item && "elementLayout" in item) {
      const field = fields[item.property];
      if (Array.isArray(field)) {
        return field.length * getItemAlloc(item.elementLayout);
      }
    } else if ("fields" in item) {
      return getAlloc({
        layout: item
      }, fields[item.property]);
    }
    return 0;
  };
  let alloc = 0;
  type.layout.fields.forEach((item) => {
    alloc += getItemAlloc(item);
  });
  return alloc;
}
function decodeLength(bytes) {
  let len = 0;
  let size = 0;
  for (;; ) {
    let elem = bytes.shift();
    len |= (elem & 127) << size * 7;
    size += 1;
    if ((elem & 128) === 0) {
      break;
    }
  }
  return len;
}
function encodeLength(bytes, len) {
  let rem_len = len;
  for (;; ) {
    let elem = rem_len & 127;
    rem_len >>= 7;
    if (rem_len == 0) {
      bytes.push(elem);
      break;
    } else {
      elem |= 128;
      bytes.push(elem);
    }
  }
}
function assert2(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

class CompiledKeys {
  constructor(payer, keyMetaMap) {
    this.payer = undefined;
    this.keyMetaMap = undefined;
    this.payer = payer;
    this.keyMetaMap = keyMetaMap;
  }
  static compile(instructions, payer) {
    const keyMetaMap = new Map;
    const getOrInsertDefault = (pubkey) => {
      const address = pubkey.toBase58();
      let keyMeta = keyMetaMap.get(address);
      if (keyMeta === undefined) {
        keyMeta = {
          isSigner: false,
          isWritable: false,
          isInvoked: false
        };
        keyMetaMap.set(address, keyMeta);
      }
      return keyMeta;
    };
    const payerKeyMeta = getOrInsertDefault(payer);
    payerKeyMeta.isSigner = true;
    payerKeyMeta.isWritable = true;
    for (const ix of instructions) {
      getOrInsertDefault(ix.programId).isInvoked = true;
      for (const accountMeta of ix.keys) {
        const keyMeta = getOrInsertDefault(accountMeta.pubkey);
        keyMeta.isSigner ||= accountMeta.isSigner;
        keyMeta.isWritable ||= accountMeta.isWritable;
      }
    }
    return new CompiledKeys(payer, keyMetaMap);
  }
  getMessageComponents() {
    const mapEntries = [...this.keyMetaMap.entries()];
    assert2(mapEntries.length <= 256, "Max static account keys length exceeded");
    const writableSigners = mapEntries.filter(([, meta]) => meta.isSigner && meta.isWritable);
    const readonlySigners = mapEntries.filter(([, meta]) => meta.isSigner && !meta.isWritable);
    const writableNonSigners = mapEntries.filter(([, meta]) => !meta.isSigner && meta.isWritable);
    const readonlyNonSigners = mapEntries.filter(([, meta]) => !meta.isSigner && !meta.isWritable);
    const header = {
      numRequiredSignatures: writableSigners.length + readonlySigners.length,
      numReadonlySignedAccounts: readonlySigners.length,
      numReadonlyUnsignedAccounts: readonlyNonSigners.length
    };
    {
      assert2(writableSigners.length > 0, "Expected at least one writable signer key");
      const [payerAddress] = writableSigners[0];
      assert2(payerAddress === this.payer.toBase58(), "Expected first writable signer key to be the fee payer");
    }
    const staticAccountKeys = [...writableSigners.map(([address]) => new PublicKey(address)), ...readonlySigners.map(([address]) => new PublicKey(address)), ...writableNonSigners.map(([address]) => new PublicKey(address)), ...readonlyNonSigners.map(([address]) => new PublicKey(address))];
    return [header, staticAccountKeys];
  }
  extractTableLookup(lookupTable) {
    const [writableIndexes, drainedWritableKeys] = this.drainKeysFoundInLookupTable(lookupTable.state.addresses, (keyMeta) => !keyMeta.isSigner && !keyMeta.isInvoked && keyMeta.isWritable);
    const [readonlyIndexes, drainedReadonlyKeys] = this.drainKeysFoundInLookupTable(lookupTable.state.addresses, (keyMeta) => !keyMeta.isSigner && !keyMeta.isInvoked && !keyMeta.isWritable);
    if (writableIndexes.length === 0 && readonlyIndexes.length === 0) {
      return;
    }
    return [{
      accountKey: lookupTable.key,
      writableIndexes,
      readonlyIndexes
    }, {
      writable: drainedWritableKeys,
      readonly: drainedReadonlyKeys
    }];
  }
  drainKeysFoundInLookupTable(lookupTableEntries, keyMetaFilter) {
    const lookupTableIndexes = new Array;
    const drainedKeys = new Array;
    for (const [address, keyMeta] of this.keyMetaMap.entries()) {
      if (keyMetaFilter(keyMeta)) {
        const key = new PublicKey(address);
        const lookupTableIndex = lookupTableEntries.findIndex((entry) => entry.equals(key));
        if (lookupTableIndex >= 0) {
          assert2(lookupTableIndex < 256, "Max lookup table index exceeded");
          lookupTableIndexes.push(lookupTableIndex);
          drainedKeys.push(key);
          this.keyMetaMap.delete(address);
        }
      }
    }
    return [lookupTableIndexes, drainedKeys];
  }
}
function guardedShift(byteArray) {
  if (byteArray.length === 0) {
    throw new Error(END_OF_BUFFER_ERROR_MESSAGE);
  }
  return byteArray.shift();
}
function guardedSplice(byteArray, ...args) {
  const [start] = args;
  if (args.length === 2 ? start + (args[1] ?? 0) > byteArray.length : start >= byteArray.length) {
    throw new Error(END_OF_BUFFER_ERROR_MESSAGE);
  }
  return byteArray.splice(...args);
}

class Message {
  constructor(args) {
    this.header = undefined;
    this.accountKeys = undefined;
    this.recentBlockhash = undefined;
    this.instructions = undefined;
    this.indexToProgramIds = new Map;
    this.header = args.header;
    this.accountKeys = args.accountKeys.map((account) => new PublicKey(account));
    this.recentBlockhash = args.recentBlockhash;
    this.instructions = args.instructions;
    this.instructions.forEach((ix) => this.indexToProgramIds.set(ix.programIdIndex, this.accountKeys[ix.programIdIndex]));
  }
  get version() {
    return "legacy";
  }
  get staticAccountKeys() {
    return this.accountKeys;
  }
  get compiledInstructions() {
    return this.instructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountKeyIndexes: ix.accounts,
      data: import_bs58.default.decode(ix.data)
    }));
  }
  get addressTableLookups() {
    return [];
  }
  getAccountKeys() {
    return new MessageAccountKeys(this.staticAccountKeys);
  }
  static compile(args) {
    const compiledKeys = CompiledKeys.compile(args.instructions, args.payerKey);
    const [header, staticAccountKeys] = compiledKeys.getMessageComponents();
    const accountKeys = new MessageAccountKeys(staticAccountKeys);
    const instructions = accountKeys.compileInstructions(args.instructions).map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accountKeyIndexes,
      data: import_bs58.default.encode(ix.data)
    }));
    return new Message({
      header,
      accountKeys: staticAccountKeys,
      recentBlockhash: args.recentBlockhash,
      instructions
    });
  }
  isAccountSigner(index) {
    return index < this.header.numRequiredSignatures;
  }
  isAccountWritable(index) {
    const numSignedAccounts = this.header.numRequiredSignatures;
    if (index >= this.header.numRequiredSignatures) {
      const unsignedAccountIndex = index - numSignedAccounts;
      const numUnsignedAccounts = this.accountKeys.length - numSignedAccounts;
      const numWritableUnsignedAccounts = numUnsignedAccounts - this.header.numReadonlyUnsignedAccounts;
      return unsignedAccountIndex < numWritableUnsignedAccounts;
    } else {
      const numWritableSignedAccounts = numSignedAccounts - this.header.numReadonlySignedAccounts;
      return index < numWritableSignedAccounts;
    }
  }
  isProgramId(index) {
    return this.indexToProgramIds.has(index);
  }
  programIds() {
    return [...this.indexToProgramIds.values()];
  }
  nonProgramIds() {
    return this.accountKeys.filter((_, index) => !this.isProgramId(index));
  }
  serialize() {
    const numKeys = this.accountKeys.length;
    let keyCount = [];
    encodeLength(keyCount, numKeys);
    const instructions = this.instructions.map((instruction) => {
      const {
        accounts,
        programIdIndex
      } = instruction;
      const data = Array.from(import_bs58.default.decode(instruction.data));
      let keyIndicesCount = [];
      encodeLength(keyIndicesCount, accounts.length);
      let dataCount = [];
      encodeLength(dataCount, data.length);
      return {
        programIdIndex,
        keyIndicesCount: Buffer2.from(keyIndicesCount),
        keyIndices: accounts,
        dataLength: Buffer2.from(dataCount),
        data
      };
    });
    let instructionCount = [];
    encodeLength(instructionCount, instructions.length);
    let instructionBuffer = Buffer2.alloc(PACKET_DATA_SIZE);
    Buffer2.from(instructionCount).copy(instructionBuffer);
    let instructionBufferLength = instructionCount.length;
    instructions.forEach((instruction) => {
      const instructionLayout = BufferLayout.struct([BufferLayout.u8("programIdIndex"), BufferLayout.blob(instruction.keyIndicesCount.length, "keyIndicesCount"), BufferLayout.seq(BufferLayout.u8("keyIndex"), instruction.keyIndices.length, "keyIndices"), BufferLayout.blob(instruction.dataLength.length, "dataLength"), BufferLayout.seq(BufferLayout.u8("userdatum"), instruction.data.length, "data")]);
      const length = instructionLayout.encode(instruction, instructionBuffer, instructionBufferLength);
      instructionBufferLength += length;
    });
    instructionBuffer = instructionBuffer.slice(0, instructionBufferLength);
    const signDataLayout = BufferLayout.struct([BufferLayout.blob(1, "numRequiredSignatures"), BufferLayout.blob(1, "numReadonlySignedAccounts"), BufferLayout.blob(1, "numReadonlyUnsignedAccounts"), BufferLayout.blob(keyCount.length, "keyCount"), BufferLayout.seq(publicKey("key"), numKeys, "keys"), publicKey("recentBlockhash")]);
    const transaction = {
      numRequiredSignatures: Buffer2.from([this.header.numRequiredSignatures]),
      numReadonlySignedAccounts: Buffer2.from([this.header.numReadonlySignedAccounts]),
      numReadonlyUnsignedAccounts: Buffer2.from([this.header.numReadonlyUnsignedAccounts]),
      keyCount: Buffer2.from(keyCount),
      keys: this.accountKeys.map((key) => toBuffer(key.toBytes())),
      recentBlockhash: import_bs58.default.decode(this.recentBlockhash)
    };
    let signData = Buffer2.alloc(2048);
    const length = signDataLayout.encode(transaction, signData);
    instructionBuffer.copy(signData, length);
    return signData.slice(0, length + instructionBuffer.length);
  }
  static from(buffer) {
    let byteArray = [...buffer];
    const numRequiredSignatures = guardedShift(byteArray);
    if (numRequiredSignatures !== (numRequiredSignatures & VERSION_PREFIX_MASK)) {
      throw new Error("Versioned messages must be deserialized with VersionedMessage.deserialize()");
    }
    const numReadonlySignedAccounts = guardedShift(byteArray);
    const numReadonlyUnsignedAccounts = guardedShift(byteArray);
    const accountCount = decodeLength(byteArray);
    let accountKeys = [];
    for (let i = 0;i < accountCount; i++) {
      const account = guardedSplice(byteArray, 0, PUBLIC_KEY_LENGTH);
      accountKeys.push(new PublicKey(Buffer2.from(account)));
    }
    const recentBlockhash = guardedSplice(byteArray, 0, PUBLIC_KEY_LENGTH);
    const instructionCount = decodeLength(byteArray);
    let instructions = [];
    for (let i = 0;i < instructionCount; i++) {
      const programIdIndex = guardedShift(byteArray);
      const accountCount = decodeLength(byteArray);
      const accounts = guardedSplice(byteArray, 0, accountCount);
      const dataLength = decodeLength(byteArray);
      const dataSlice = guardedSplice(byteArray, 0, dataLength);
      const data = import_bs58.default.encode(Buffer2.from(dataSlice));
      instructions.push({
        programIdIndex,
        accounts,
        data
      });
    }
    const messageArgs = {
      header: {
        numRequiredSignatures,
        numReadonlySignedAccounts,
        numReadonlyUnsignedAccounts
      },
      recentBlockhash: import_bs58.default.encode(Buffer2.from(recentBlockhash)),
      accountKeys,
      instructions
    };
    return new Message(messageArgs);
  }
}

class MessageV0 {
  constructor(args) {
    this.header = undefined;
    this.staticAccountKeys = undefined;
    this.recentBlockhash = undefined;
    this.compiledInstructions = undefined;
    this.addressTableLookups = undefined;
    this.header = args.header;
    this.staticAccountKeys = args.staticAccountKeys;
    this.recentBlockhash = args.recentBlockhash;
    this.compiledInstructions = args.compiledInstructions;
    this.addressTableLookups = args.addressTableLookups;
  }
  get version() {
    return 0;
  }
  get numAccountKeysFromLookups() {
    let count = 0;
    for (const lookup of this.addressTableLookups) {
      count += lookup.readonlyIndexes.length + lookup.writableIndexes.length;
    }
    return count;
  }
  getAccountKeys(args) {
    let accountKeysFromLookups;
    if (args && "accountKeysFromLookups" in args && args.accountKeysFromLookups) {
      if (this.numAccountKeysFromLookups != args.accountKeysFromLookups.writable.length + args.accountKeysFromLookups.readonly.length) {
        throw new Error("Failed to get account keys because of a mismatch in the number of account keys from lookups");
      }
      accountKeysFromLookups = args.accountKeysFromLookups;
    } else if (args && "addressLookupTableAccounts" in args && args.addressLookupTableAccounts) {
      accountKeysFromLookups = this.resolveAddressTableLookups(args.addressLookupTableAccounts);
    } else if (this.addressTableLookups.length > 0) {
      throw new Error("Failed to get account keys because address table lookups were not resolved");
    }
    return new MessageAccountKeys(this.staticAccountKeys, accountKeysFromLookups);
  }
  isAccountSigner(index) {
    return index < this.header.numRequiredSignatures;
  }
  isAccountWritable(index) {
    const numSignedAccounts = this.header.numRequiredSignatures;
    const numStaticAccountKeys = this.staticAccountKeys.length;
    if (index >= numStaticAccountKeys) {
      const lookupAccountKeysIndex = index - numStaticAccountKeys;
      const numWritableLookupAccountKeys = this.addressTableLookups.reduce((count, lookup) => count + lookup.writableIndexes.length, 0);
      return lookupAccountKeysIndex < numWritableLookupAccountKeys;
    } else if (index >= this.header.numRequiredSignatures) {
      const unsignedAccountIndex = index - numSignedAccounts;
      const numUnsignedAccounts = numStaticAccountKeys - numSignedAccounts;
      const numWritableUnsignedAccounts = numUnsignedAccounts - this.header.numReadonlyUnsignedAccounts;
      return unsignedAccountIndex < numWritableUnsignedAccounts;
    } else {
      const numWritableSignedAccounts = numSignedAccounts - this.header.numReadonlySignedAccounts;
      return index < numWritableSignedAccounts;
    }
  }
  resolveAddressTableLookups(addressLookupTableAccounts) {
    const accountKeysFromLookups = {
      writable: [],
      readonly: []
    };
    for (const tableLookup of this.addressTableLookups) {
      const tableAccount = addressLookupTableAccounts.find((account) => account.key.equals(tableLookup.accountKey));
      if (!tableAccount) {
        throw new Error(`Failed to find address lookup table account for table key ${tableLookup.accountKey.toBase58()}`);
      }
      for (const index of tableLookup.writableIndexes) {
        if (index < tableAccount.state.addresses.length) {
          accountKeysFromLookups.writable.push(tableAccount.state.addresses[index]);
        } else {
          throw new Error(`Failed to find address for index ${index} in address lookup table ${tableLookup.accountKey.toBase58()}`);
        }
      }
      for (const index of tableLookup.readonlyIndexes) {
        if (index < tableAccount.state.addresses.length) {
          accountKeysFromLookups.readonly.push(tableAccount.state.addresses[index]);
        } else {
          throw new Error(`Failed to find address for index ${index} in address lookup table ${tableLookup.accountKey.toBase58()}`);
        }
      }
    }
    return accountKeysFromLookups;
  }
  static compile(args) {
    const compiledKeys = CompiledKeys.compile(args.instructions, args.payerKey);
    const addressTableLookups = new Array;
    const accountKeysFromLookups = {
      writable: new Array,
      readonly: new Array
    };
    const lookupTableAccounts = args.addressLookupTableAccounts || [];
    for (const lookupTable of lookupTableAccounts) {
      const extractResult = compiledKeys.extractTableLookup(lookupTable);
      if (extractResult !== undefined) {
        const [addressTableLookup, {
          writable,
          readonly
        }] = extractResult;
        addressTableLookups.push(addressTableLookup);
        accountKeysFromLookups.writable.push(...writable);
        accountKeysFromLookups.readonly.push(...readonly);
      }
    }
    const [header, staticAccountKeys] = compiledKeys.getMessageComponents();
    const accountKeys = new MessageAccountKeys(staticAccountKeys, accountKeysFromLookups);
    const compiledInstructions = accountKeys.compileInstructions(args.instructions);
    return new MessageV0({
      header,
      staticAccountKeys,
      recentBlockhash: args.recentBlockhash,
      compiledInstructions,
      addressTableLookups
    });
  }
  serialize() {
    const encodedStaticAccountKeysLength = Array();
    encodeLength(encodedStaticAccountKeysLength, this.staticAccountKeys.length);
    const serializedInstructions = this.serializeInstructions();
    const encodedInstructionsLength = Array();
    encodeLength(encodedInstructionsLength, this.compiledInstructions.length);
    const serializedAddressTableLookups = this.serializeAddressTableLookups();
    const encodedAddressTableLookupsLength = Array();
    encodeLength(encodedAddressTableLookupsLength, this.addressTableLookups.length);
    const messageLayout = BufferLayout.struct([BufferLayout.u8("prefix"), BufferLayout.struct([BufferLayout.u8("numRequiredSignatures"), BufferLayout.u8("numReadonlySignedAccounts"), BufferLayout.u8("numReadonlyUnsignedAccounts")], "header"), BufferLayout.blob(encodedStaticAccountKeysLength.length, "staticAccountKeysLength"), BufferLayout.seq(publicKey(), this.staticAccountKeys.length, "staticAccountKeys"), publicKey("recentBlockhash"), BufferLayout.blob(encodedInstructionsLength.length, "instructionsLength"), BufferLayout.blob(serializedInstructions.length, "serializedInstructions"), BufferLayout.blob(encodedAddressTableLookupsLength.length, "addressTableLookupsLength"), BufferLayout.blob(serializedAddressTableLookups.length, "serializedAddressTableLookups")]);
    const serializedMessage = new Uint8Array(PACKET_DATA_SIZE);
    const MESSAGE_VERSION_0_PREFIX = 1 << 7;
    const serializedMessageLength = messageLayout.encode({
      prefix: MESSAGE_VERSION_0_PREFIX,
      header: this.header,
      staticAccountKeysLength: new Uint8Array(encodedStaticAccountKeysLength),
      staticAccountKeys: this.staticAccountKeys.map((key) => key.toBytes()),
      recentBlockhash: import_bs58.default.decode(this.recentBlockhash),
      instructionsLength: new Uint8Array(encodedInstructionsLength),
      serializedInstructions,
      addressTableLookupsLength: new Uint8Array(encodedAddressTableLookupsLength),
      serializedAddressTableLookups
    }, serializedMessage);
    return serializedMessage.slice(0, serializedMessageLength);
  }
  serializeInstructions() {
    let serializedLength = 0;
    const serializedInstructions = new Uint8Array(PACKET_DATA_SIZE);
    for (const instruction of this.compiledInstructions) {
      const encodedAccountKeyIndexesLength = Array();
      encodeLength(encodedAccountKeyIndexesLength, instruction.accountKeyIndexes.length);
      const encodedDataLength = Array();
      encodeLength(encodedDataLength, instruction.data.length);
      const instructionLayout = BufferLayout.struct([BufferLayout.u8("programIdIndex"), BufferLayout.blob(encodedAccountKeyIndexesLength.length, "encodedAccountKeyIndexesLength"), BufferLayout.seq(BufferLayout.u8(), instruction.accountKeyIndexes.length, "accountKeyIndexes"), BufferLayout.blob(encodedDataLength.length, "encodedDataLength"), BufferLayout.blob(instruction.data.length, "data")]);
      serializedLength += instructionLayout.encode({
        programIdIndex: instruction.programIdIndex,
        encodedAccountKeyIndexesLength: new Uint8Array(encodedAccountKeyIndexesLength),
        accountKeyIndexes: instruction.accountKeyIndexes,
        encodedDataLength: new Uint8Array(encodedDataLength),
        data: instruction.data
      }, serializedInstructions, serializedLength);
    }
    return serializedInstructions.slice(0, serializedLength);
  }
  serializeAddressTableLookups() {
    let serializedLength = 0;
    const serializedAddressTableLookups = new Uint8Array(PACKET_DATA_SIZE);
    for (const lookup of this.addressTableLookups) {
      const encodedWritableIndexesLength = Array();
      encodeLength(encodedWritableIndexesLength, lookup.writableIndexes.length);
      const encodedReadonlyIndexesLength = Array();
      encodeLength(encodedReadonlyIndexesLength, lookup.readonlyIndexes.length);
      const addressTableLookupLayout = BufferLayout.struct([publicKey("accountKey"), BufferLayout.blob(encodedWritableIndexesLength.length, "encodedWritableIndexesLength"), BufferLayout.seq(BufferLayout.u8(), lookup.writableIndexes.length, "writableIndexes"), BufferLayout.blob(encodedReadonlyIndexesLength.length, "encodedReadonlyIndexesLength"), BufferLayout.seq(BufferLayout.u8(), lookup.readonlyIndexes.length, "readonlyIndexes")]);
      serializedLength += addressTableLookupLayout.encode({
        accountKey: lookup.accountKey.toBytes(),
        encodedWritableIndexesLength: new Uint8Array(encodedWritableIndexesLength),
        writableIndexes: lookup.writableIndexes,
        encodedReadonlyIndexesLength: new Uint8Array(encodedReadonlyIndexesLength),
        readonlyIndexes: lookup.readonlyIndexes
      }, serializedAddressTableLookups, serializedLength);
    }
    return serializedAddressTableLookups.slice(0, serializedLength);
  }
  static deserialize(serializedMessage) {
    let byteArray = [...serializedMessage];
    const prefix = guardedShift(byteArray);
    const maskedPrefix = prefix & VERSION_PREFIX_MASK;
    assert2(prefix !== maskedPrefix, `Expected versioned message but received legacy message`);
    const version = maskedPrefix;
    assert2(version === 0, `Expected versioned message with version 0 but found version ${version}`);
    const header = {
      numRequiredSignatures: guardedShift(byteArray),
      numReadonlySignedAccounts: guardedShift(byteArray),
      numReadonlyUnsignedAccounts: guardedShift(byteArray)
    };
    const staticAccountKeys = [];
    const staticAccountKeysLength = decodeLength(byteArray);
    for (let i = 0;i < staticAccountKeysLength; i++) {
      staticAccountKeys.push(new PublicKey(guardedSplice(byteArray, 0, PUBLIC_KEY_LENGTH)));
    }
    const recentBlockhash = import_bs58.default.encode(guardedSplice(byteArray, 0, PUBLIC_KEY_LENGTH));
    const instructionCount = decodeLength(byteArray);
    const compiledInstructions = [];
    for (let i = 0;i < instructionCount; i++) {
      const programIdIndex = guardedShift(byteArray);
      const accountKeyIndexesLength = decodeLength(byteArray);
      const accountKeyIndexes = guardedSplice(byteArray, 0, accountKeyIndexesLength);
      const dataLength = decodeLength(byteArray);
      const data = new Uint8Array(guardedSplice(byteArray, 0, dataLength));
      compiledInstructions.push({
        programIdIndex,
        accountKeyIndexes,
        data
      });
    }
    const addressTableLookupsCount = decodeLength(byteArray);
    const addressTableLookups = [];
    for (let i = 0;i < addressTableLookupsCount; i++) {
      const accountKey = new PublicKey(guardedSplice(byteArray, 0, PUBLIC_KEY_LENGTH));
      const writableIndexesLength = decodeLength(byteArray);
      const writableIndexes = guardedSplice(byteArray, 0, writableIndexesLength);
      const readonlyIndexesLength = decodeLength(byteArray);
      const readonlyIndexes = guardedSplice(byteArray, 0, readonlyIndexesLength);
      addressTableLookups.push({
        accountKey,
        writableIndexes,
        readonlyIndexes
      });
    }
    return new MessageV0({
      header,
      staticAccountKeys,
      recentBlockhash,
      compiledInstructions,
      addressTableLookups
    });
  }
}

class TransactionInstruction {
  constructor(opts) {
    this.keys = undefined;
    this.programId = undefined;
    this.data = Buffer2.alloc(0);
    this.programId = opts.programId;
    this.keys = opts.keys;
    if (opts.data) {
      this.data = opts.data;
    }
  }
  toJSON() {
    return {
      keys: this.keys.map(({
        pubkey,
        isSigner,
        isWritable
      }) => ({
        pubkey: pubkey.toJSON(),
        isSigner,
        isWritable
      })),
      programId: this.programId.toJSON(),
      data: [...this.data]
    };
  }
}

class Transaction {
  get signature() {
    if (this.signatures.length > 0) {
      return this.signatures[0].signature;
    }
    return null;
  }
  constructor(opts) {
    this.signatures = [];
    this.feePayer = undefined;
    this.instructions = [];
    this.recentBlockhash = undefined;
    this.lastValidBlockHeight = undefined;
    this.nonceInfo = undefined;
    this.minNonceContextSlot = undefined;
    this._message = undefined;
    this._json = undefined;
    if (!opts) {
      return;
    }
    if (opts.feePayer) {
      this.feePayer = opts.feePayer;
    }
    if (opts.signatures) {
      this.signatures = opts.signatures;
    }
    if (Object.prototype.hasOwnProperty.call(opts, "nonceInfo")) {
      const {
        minContextSlot,
        nonceInfo
      } = opts;
      this.minNonceContextSlot = minContextSlot;
      this.nonceInfo = nonceInfo;
    } else if (Object.prototype.hasOwnProperty.call(opts, "lastValidBlockHeight")) {
      const {
        blockhash,
        lastValidBlockHeight
      } = opts;
      this.recentBlockhash = blockhash;
      this.lastValidBlockHeight = lastValidBlockHeight;
    } else {
      const {
        recentBlockhash,
        nonceInfo
      } = opts;
      if (nonceInfo) {
        this.nonceInfo = nonceInfo;
      }
      this.recentBlockhash = recentBlockhash;
    }
  }
  toJSON() {
    return {
      recentBlockhash: this.recentBlockhash || null,
      feePayer: this.feePayer ? this.feePayer.toJSON() : null,
      nonceInfo: this.nonceInfo ? {
        nonce: this.nonceInfo.nonce,
        nonceInstruction: this.nonceInfo.nonceInstruction.toJSON()
      } : null,
      instructions: this.instructions.map((instruction) => instruction.toJSON()),
      signers: this.signatures.map(({
        publicKey
      }) => {
        return publicKey.toJSON();
      })
    };
  }
  add(...items) {
    if (items.length === 0) {
      throw new Error("No instructions");
    }
    items.forEach((item) => {
      if ("instructions" in item) {
        this.instructions = this.instructions.concat(item.instructions);
      } else if ("data" in item && "programId" in item && "keys" in item) {
        this.instructions.push(item);
      } else {
        this.instructions.push(new TransactionInstruction(item));
      }
    });
    return this;
  }
  compileMessage() {
    if (this._message && JSON.stringify(this.toJSON()) === JSON.stringify(this._json)) {
      return this._message;
    }
    let recentBlockhash;
    let instructions;
    if (this.nonceInfo) {
      recentBlockhash = this.nonceInfo.nonce;
      if (this.instructions[0] != this.nonceInfo.nonceInstruction) {
        instructions = [this.nonceInfo.nonceInstruction, ...this.instructions];
      } else {
        instructions = this.instructions;
      }
    } else {
      recentBlockhash = this.recentBlockhash;
      instructions = this.instructions;
    }
    if (!recentBlockhash) {
      throw new Error("Transaction recentBlockhash required");
    }
    if (instructions.length < 1) {
      console.warn("No instructions provided");
    }
    let feePayer;
    if (this.feePayer) {
      feePayer = this.feePayer;
    } else if (this.signatures.length > 0 && this.signatures[0].publicKey) {
      feePayer = this.signatures[0].publicKey;
    } else {
      throw new Error("Transaction fee payer required");
    }
    for (let i = 0;i < instructions.length; i++) {
      if (instructions[i].programId === undefined) {
        throw new Error(`Transaction instruction index ${i} has undefined program id`);
      }
    }
    const programIds = [];
    const accountMetas = [];
    instructions.forEach((instruction) => {
      instruction.keys.forEach((accountMeta) => {
        accountMetas.push({
          ...accountMeta
        });
      });
      const programId = instruction.programId.toString();
      if (!programIds.includes(programId)) {
        programIds.push(programId);
      }
    });
    programIds.forEach((programId) => {
      accountMetas.push({
        pubkey: new PublicKey(programId),
        isSigner: false,
        isWritable: false
      });
    });
    const uniqueMetas = [];
    accountMetas.forEach((accountMeta) => {
      const pubkeyString = accountMeta.pubkey.toString();
      const uniqueIndex = uniqueMetas.findIndex((x) => {
        return x.pubkey.toString() === pubkeyString;
      });
      if (uniqueIndex > -1) {
        uniqueMetas[uniqueIndex].isWritable = uniqueMetas[uniqueIndex].isWritable || accountMeta.isWritable;
        uniqueMetas[uniqueIndex].isSigner = uniqueMetas[uniqueIndex].isSigner || accountMeta.isSigner;
      } else {
        uniqueMetas.push(accountMeta);
      }
    });
    uniqueMetas.sort(function(x, y) {
      if (x.isSigner !== y.isSigner) {
        return x.isSigner ? -1 : 1;
      }
      if (x.isWritable !== y.isWritable) {
        return x.isWritable ? -1 : 1;
      }
      const options = {
        localeMatcher: "best fit",
        usage: "sort",
        sensitivity: "variant",
        ignorePunctuation: false,
        numeric: false,
        caseFirst: "lower"
      };
      return x.pubkey.toBase58().localeCompare(y.pubkey.toBase58(), "en", options);
    });
    const feePayerIndex = uniqueMetas.findIndex((x) => {
      return x.pubkey.equals(feePayer);
    });
    if (feePayerIndex > -1) {
      const [payerMeta] = uniqueMetas.splice(feePayerIndex, 1);
      payerMeta.isSigner = true;
      payerMeta.isWritable = true;
      uniqueMetas.unshift(payerMeta);
    } else {
      uniqueMetas.unshift({
        pubkey: feePayer,
        isSigner: true,
        isWritable: true
      });
    }
    for (const signature of this.signatures) {
      const uniqueIndex = uniqueMetas.findIndex((x) => {
        return x.pubkey.equals(signature.publicKey);
      });
      if (uniqueIndex > -1) {
        if (!uniqueMetas[uniqueIndex].isSigner) {
          uniqueMetas[uniqueIndex].isSigner = true;
          console.warn("Transaction references a signature that is unnecessary, " + "only the fee payer and instruction signer accounts should sign a transaction. " + "This behavior is deprecated and will throw an error in the next major version release.");
        }
      } else {
        throw new Error(`unknown signer: ${signature.publicKey.toString()}`);
      }
    }
    let numRequiredSignatures = 0;
    let numReadonlySignedAccounts = 0;
    let numReadonlyUnsignedAccounts = 0;
    const signedKeys = [];
    const unsignedKeys = [];
    uniqueMetas.forEach(({
      pubkey,
      isSigner,
      isWritable
    }) => {
      if (isSigner) {
        signedKeys.push(pubkey.toString());
        numRequiredSignatures += 1;
        if (!isWritable) {
          numReadonlySignedAccounts += 1;
        }
      } else {
        unsignedKeys.push(pubkey.toString());
        if (!isWritable) {
          numReadonlyUnsignedAccounts += 1;
        }
      }
    });
    const accountKeys = signedKeys.concat(unsignedKeys);
    const compiledInstructions = instructions.map((instruction) => {
      const {
        data,
        programId
      } = instruction;
      return {
        programIdIndex: accountKeys.indexOf(programId.toString()),
        accounts: instruction.keys.map((meta) => accountKeys.indexOf(meta.pubkey.toString())),
        data: import_bs58.default.encode(data)
      };
    });
    compiledInstructions.forEach((instruction) => {
      assert2(instruction.programIdIndex >= 0);
      instruction.accounts.forEach((keyIndex) => assert2(keyIndex >= 0));
    });
    return new Message({
      header: {
        numRequiredSignatures,
        numReadonlySignedAccounts,
        numReadonlyUnsignedAccounts
      },
      accountKeys,
      recentBlockhash,
      instructions: compiledInstructions
    });
  }
  _compile() {
    const message = this.compileMessage();
    const signedKeys = message.accountKeys.slice(0, message.header.numRequiredSignatures);
    if (this.signatures.length === signedKeys.length) {
      const valid = this.signatures.every((pair, index) => {
        return signedKeys[index].equals(pair.publicKey);
      });
      if (valid)
        return message;
    }
    this.signatures = signedKeys.map((publicKey) => ({
      signature: null,
      publicKey
    }));
    return message;
  }
  serializeMessage() {
    return this._compile().serialize();
  }
  async getEstimatedFee(connection) {
    return (await connection.getFeeForMessage(this.compileMessage())).value;
  }
  setSigners(...signers) {
    if (signers.length === 0) {
      throw new Error("No signers");
    }
    const seen = new Set;
    this.signatures = signers.filter((publicKey) => {
      const key = publicKey.toString();
      if (seen.has(key)) {
        return false;
      } else {
        seen.add(key);
        return true;
      }
    }).map((publicKey) => ({
      signature: null,
      publicKey
    }));
  }
  sign(...signers) {
    if (signers.length === 0) {
      throw new Error("No signers");
    }
    const seen = new Set;
    const uniqueSigners = [];
    for (const signer of signers) {
      const key = signer.publicKey.toString();
      if (seen.has(key)) {
        continue;
      } else {
        seen.add(key);
        uniqueSigners.push(signer);
      }
    }
    this.signatures = uniqueSigners.map((signer) => ({
      signature: null,
      publicKey: signer.publicKey
    }));
    const message = this._compile();
    this._partialSign(message, ...uniqueSigners);
  }
  partialSign(...signers) {
    if (signers.length === 0) {
      throw new Error("No signers");
    }
    const seen = new Set;
    const uniqueSigners = [];
    for (const signer of signers) {
      const key = signer.publicKey.toString();
      if (seen.has(key)) {
        continue;
      } else {
        seen.add(key);
        uniqueSigners.push(signer);
      }
    }
    const message = this._compile();
    this._partialSign(message, ...uniqueSigners);
  }
  _partialSign(message, ...signers) {
    const signData = message.serialize();
    signers.forEach((signer) => {
      const signature = sign(signData, signer.secretKey);
      this._addSignature(signer.publicKey, toBuffer(signature));
    });
  }
  addSignature(pubkey, signature) {
    this._compile();
    this._addSignature(pubkey, signature);
  }
  _addSignature(pubkey, signature) {
    assert2(signature.length === 64);
    const index = this.signatures.findIndex((sigpair) => pubkey.equals(sigpair.publicKey));
    if (index < 0) {
      throw new Error(`unknown signer: ${pubkey.toString()}`);
    }
    this.signatures[index].signature = Buffer2.from(signature);
  }
  verifySignatures(requireAllSignatures = true) {
    const signatureErrors = this._getMessageSignednessErrors(this.serializeMessage(), requireAllSignatures);
    return !signatureErrors;
  }
  _getMessageSignednessErrors(message, requireAllSignatures) {
    const errors = {};
    for (const {
      signature,
      publicKey
    } of this.signatures) {
      if (signature === null) {
        if (requireAllSignatures) {
          (errors.missing ||= []).push(publicKey);
        }
      } else {
        if (!verify(signature, message, publicKey.toBytes())) {
          (errors.invalid ||= []).push(publicKey);
        }
      }
    }
    return errors.invalid || errors.missing ? errors : undefined;
  }
  serialize(config) {
    const {
      requireAllSignatures,
      verifySignatures
    } = Object.assign({
      requireAllSignatures: true,
      verifySignatures: true
    }, config);
    const signData = this.serializeMessage();
    if (verifySignatures) {
      const sigErrors = this._getMessageSignednessErrors(signData, requireAllSignatures);
      if (sigErrors) {
        let errorMessage = "Signature verification failed.";
        if (sigErrors.invalid) {
          errorMessage += `
Invalid signature for public key${sigErrors.invalid.length === 1 ? "" : "(s)"} [\`${sigErrors.invalid.map((p) => p.toBase58()).join("`, `")}\`].`;
        }
        if (sigErrors.missing) {
          errorMessage += `
Missing signature for public key${sigErrors.missing.length === 1 ? "" : "(s)"} [\`${sigErrors.missing.map((p) => p.toBase58()).join("`, `")}\`].`;
        }
        throw new Error(errorMessage);
      }
    }
    return this._serialize(signData);
  }
  _serialize(signData) {
    const {
      signatures
    } = this;
    const signatureCount = [];
    encodeLength(signatureCount, signatures.length);
    const transactionLength = signatureCount.length + signatures.length * 64 + signData.length;
    const wireTransaction = Buffer2.alloc(transactionLength);
    assert2(signatures.length < 256);
    Buffer2.from(signatureCount).copy(wireTransaction, 0);
    signatures.forEach(({
      signature
    }, index) => {
      if (signature !== null) {
        assert2(signature.length === 64, `signature has invalid length`);
        Buffer2.from(signature).copy(wireTransaction, signatureCount.length + index * 64);
      }
    });
    signData.copy(wireTransaction, signatureCount.length + signatures.length * 64);
    assert2(wireTransaction.length <= PACKET_DATA_SIZE, `Transaction too large: ${wireTransaction.length} > ${PACKET_DATA_SIZE}`);
    return wireTransaction;
  }
  get keys() {
    assert2(this.instructions.length === 1);
    return this.instructions[0].keys.map((keyObj) => keyObj.pubkey);
  }
  get programId() {
    assert2(this.instructions.length === 1);
    return this.instructions[0].programId;
  }
  get data() {
    assert2(this.instructions.length === 1);
    return this.instructions[0].data;
  }
  static from(buffer) {
    let byteArray = [...buffer];
    const signatureCount = decodeLength(byteArray);
    let signatures = [];
    for (let i = 0;i < signatureCount; i++) {
      const signature = guardedSplice(byteArray, 0, SIGNATURE_LENGTH_IN_BYTES);
      signatures.push(import_bs58.default.encode(Buffer2.from(signature)));
    }
    return Transaction.populate(Message.from(byteArray), signatures);
  }
  static populate(message, signatures = []) {
    const transaction = new Transaction;
    transaction.recentBlockhash = message.recentBlockhash;
    if (message.header.numRequiredSignatures > 0) {
      transaction.feePayer = message.accountKeys[0];
    }
    signatures.forEach((signature, index) => {
      const sigPubkeyPair = {
        signature: signature == import_bs58.default.encode(DEFAULT_SIGNATURE) ? null : import_bs58.default.decode(signature),
        publicKey: message.accountKeys[index]
      };
      transaction.signatures.push(sigPubkeyPair);
    });
    message.instructions.forEach((instruction) => {
      const keys = instruction.accounts.map((account) => {
        const pubkey = message.accountKeys[account];
        return {
          pubkey,
          isSigner: transaction.signatures.some((keyObj) => keyObj.publicKey.toString() === pubkey.toString()) || message.isAccountSigner(account),
          isWritable: message.isAccountWritable(account)
        };
      });
      transaction.instructions.push(new TransactionInstruction({
        keys,
        programId: message.accountKeys[instruction.programIdIndex],
        data: import_bs58.default.decode(instruction.data)
      }));
    });
    transaction._message = message;
    transaction._json = transaction.toJSON();
    return transaction;
  }
}

class VersionedTransaction {
  get version() {
    return this.message.version;
  }
  constructor(message, signatures) {
    this.signatures = undefined;
    this.message = undefined;
    if (signatures !== undefined) {
      assert2(signatures.length === message.header.numRequiredSignatures, "Expected signatures length to be equal to the number of required signatures");
      this.signatures = signatures;
    } else {
      const defaultSignatures = [];
      for (let i = 0;i < message.header.numRequiredSignatures; i++) {
        defaultSignatures.push(new Uint8Array(SIGNATURE_LENGTH_IN_BYTES));
      }
      this.signatures = defaultSignatures;
    }
    this.message = message;
  }
  serialize() {
    const serializedMessage = this.message.serialize();
    const encodedSignaturesLength = Array();
    encodeLength(encodedSignaturesLength, this.signatures.length);
    const transactionLayout = BufferLayout.struct([BufferLayout.blob(encodedSignaturesLength.length, "encodedSignaturesLength"), BufferLayout.seq(signature(), this.signatures.length, "signatures"), BufferLayout.blob(serializedMessage.length, "serializedMessage")]);
    const serializedTransaction = new Uint8Array(2048);
    const serializedTransactionLength = transactionLayout.encode({
      encodedSignaturesLength: new Uint8Array(encodedSignaturesLength),
      signatures: this.signatures,
      serializedMessage
    }, serializedTransaction);
    return serializedTransaction.slice(0, serializedTransactionLength);
  }
  static deserialize(serializedTransaction) {
    let byteArray = [...serializedTransaction];
    const signatures = [];
    const signaturesLength = decodeLength(byteArray);
    for (let i = 0;i < signaturesLength; i++) {
      signatures.push(new Uint8Array(guardedSplice(byteArray, 0, SIGNATURE_LENGTH_IN_BYTES)));
    }
    const message = VersionedMessage.deserialize(new Uint8Array(byteArray));
    return new VersionedTransaction(message, signatures);
  }
  sign(signers) {
    const messageData = this.message.serialize();
    const signerPubkeys = this.message.staticAccountKeys.slice(0, this.message.header.numRequiredSignatures);
    for (const signer of signers) {
      const signerIndex = signerPubkeys.findIndex((pubkey) => pubkey.equals(signer.publicKey));
      assert2(signerIndex >= 0, `Cannot sign with non signer key ${signer.publicKey.toBase58()}`);
      this.signatures[signerIndex] = sign(messageData, signer.secretKey);
    }
  }
  addSignature(publicKey, signature) {
    assert2(signature.byteLength === 64, "Signature must be 64 bytes long");
    const signerPubkeys = this.message.staticAccountKeys.slice(0, this.message.header.numRequiredSignatures);
    const signerIndex = signerPubkeys.findIndex((pubkey) => pubkey.equals(publicKey));
    assert2(signerIndex >= 0, `Can not add signature; \`${publicKey.toBase58()}\` is not required to sign this transaction`);
    this.signatures[signerIndex] = signature;
  }
}
async function sendAndConfirmTransaction(connection, transaction, signers, options) {
  const sendOptions = options && {
    skipPreflight: options.skipPreflight,
    preflightCommitment: options.preflightCommitment || options.commitment,
    maxRetries: options.maxRetries,
    minContextSlot: options.minContextSlot
  };
  const signature = await connection.sendTransaction(transaction, signers, sendOptions);
  let status;
  if (transaction.recentBlockhash != null && transaction.lastValidBlockHeight != null) {
    status = (await connection.confirmTransaction({
      abortSignal: options?.abortSignal,
      signature,
      blockhash: transaction.recentBlockhash,
      lastValidBlockHeight: transaction.lastValidBlockHeight
    }, options && options.commitment)).value;
  } else if (transaction.minNonceContextSlot != null && transaction.nonceInfo != null) {
    const {
      nonceInstruction
    } = transaction.nonceInfo;
    const nonceAccountPubkey = nonceInstruction.keys[0].pubkey;
    status = (await connection.confirmTransaction({
      abortSignal: options?.abortSignal,
      minContextSlot: transaction.minNonceContextSlot,
      nonceAccountPubkey,
      nonceValue: transaction.nonceInfo.nonce,
      signature
    }, options && options.commitment)).value;
  } else {
    if (options?.abortSignal != null) {
      console.warn("sendAndConfirmTransaction(): A transaction with a deprecated confirmation strategy was " + "supplied along with an `abortSignal`. Only transactions having `lastValidBlockHeight` " + "or a combination of `nonceInfo` and `minNonceContextSlot` are abortable.");
    }
    status = (await connection.confirmTransaction(signature, options && options.commitment)).value;
  }
  if (status.err) {
    if (signature != null) {
      throw new SendTransactionError({
        action: "send",
        signature,
        transactionMessage: `Status: (${JSON.stringify(status)})`
      });
    }
    throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
  }
  return signature;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function encodeData(type, fields) {
  const allocLength = type.layout.span >= 0 ? type.layout.span : getAlloc(type, fields);
  const data = Buffer2.alloc(allocLength);
  const layoutFields = Object.assign({
    instruction: type.index
  }, fields);
  type.layout.encode(layoutFields, data);
  return data;
}
function u64(property) {
  const layout = import_buffer_layout.blob(8, property);
  const decode = layout.decode.bind(layout);
  const encode = layout.encode.bind(layout);
  const bigIntLayout = layout;
  const codec = getU64Codec();
  bigIntLayout.decode = (buffer, offset) => {
    const src = decode(buffer, offset);
    return codec.decode(src);
  };
  bigIntLayout.encode = (bigInt, buffer, offset) => {
    const src = codec.encode(bigInt);
    return encode(src, buffer, offset);
  };
  return bigIntLayout;
}

class SystemProgram {
  constructor() {}
  static createAccount(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.Create;
    const data = encodeData(type, {
      lamports: params.lamports,
      space: params.space,
      programId: toBuffer(params.programId.toBuffer())
    });
    return new TransactionInstruction({
      keys: [{
        pubkey: params.fromPubkey,
        isSigner: true,
        isWritable: true
      }, {
        pubkey: params.newAccountPubkey,
        isSigner: true,
        isWritable: true
      }],
      programId: this.programId,
      data
    });
  }
  static transfer(params) {
    let data;
    let keys;
    if ("basePubkey" in params) {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.TransferWithSeed;
      data = encodeData(type, {
        lamports: BigInt(params.lamports),
        seed: params.seed,
        programId: toBuffer(params.programId.toBuffer())
      });
      keys = [{
        pubkey: params.fromPubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: params.basePubkey,
        isSigner: true,
        isWritable: false
      }, {
        pubkey: params.toPubkey,
        isSigner: false,
        isWritable: true
      }];
    } else {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.Transfer;
      data = encodeData(type, {
        lamports: BigInt(params.lamports)
      });
      keys = [{
        pubkey: params.fromPubkey,
        isSigner: true,
        isWritable: true
      }, {
        pubkey: params.toPubkey,
        isSigner: false,
        isWritable: true
      }];
    }
    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data
    });
  }
  static assign(params) {
    let data;
    let keys;
    if ("basePubkey" in params) {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.AssignWithSeed;
      data = encodeData(type, {
        base: toBuffer(params.basePubkey.toBuffer()),
        seed: params.seed,
        programId: toBuffer(params.programId.toBuffer())
      });
      keys = [{
        pubkey: params.accountPubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: params.basePubkey,
        isSigner: true,
        isWritable: false
      }];
    } else {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.Assign;
      data = encodeData(type, {
        programId: toBuffer(params.programId.toBuffer())
      });
      keys = [{
        pubkey: params.accountPubkey,
        isSigner: true,
        isWritable: true
      }];
    }
    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data
    });
  }
  static createAccountWithSeed(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.CreateWithSeed;
    const data = encodeData(type, {
      base: toBuffer(params.basePubkey.toBuffer()),
      seed: params.seed,
      lamports: params.lamports,
      space: params.space,
      programId: toBuffer(params.programId.toBuffer())
    });
    let keys = [{
      pubkey: params.fromPubkey,
      isSigner: true,
      isWritable: true
    }, {
      pubkey: params.newAccountPubkey,
      isSigner: false,
      isWritable: true
    }];
    if (!params.basePubkey.equals(params.fromPubkey)) {
      keys.push({
        pubkey: params.basePubkey,
        isSigner: true,
        isWritable: false
      });
    }
    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data
    });
  }
  static createNonceAccount(params) {
    const transaction = new Transaction;
    if ("basePubkey" in params && "seed" in params) {
      transaction.add(SystemProgram.createAccountWithSeed({
        fromPubkey: params.fromPubkey,
        newAccountPubkey: params.noncePubkey,
        basePubkey: params.basePubkey,
        seed: params.seed,
        lamports: params.lamports,
        space: NONCE_ACCOUNT_LENGTH,
        programId: this.programId
      }));
    } else {
      transaction.add(SystemProgram.createAccount({
        fromPubkey: params.fromPubkey,
        newAccountPubkey: params.noncePubkey,
        lamports: params.lamports,
        space: NONCE_ACCOUNT_LENGTH,
        programId: this.programId
      }));
    }
    const initParams = {
      noncePubkey: params.noncePubkey,
      authorizedPubkey: params.authorizedPubkey
    };
    transaction.add(this.nonceInitialize(initParams));
    return transaction;
  }
  static nonceInitialize(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.InitializeNonceAccount;
    const data = encodeData(type, {
      authorized: toBuffer(params.authorizedPubkey.toBuffer())
    });
    const instructionData = {
      keys: [{
        pubkey: params.noncePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false
      }],
      programId: this.programId,
      data
    };
    return new TransactionInstruction(instructionData);
  }
  static nonceAdvance(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.AdvanceNonceAccount;
    const data = encodeData(type);
    const instructionData = {
      keys: [{
        pubkey: params.noncePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: params.authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    };
    return new TransactionInstruction(instructionData);
  }
  static nonceWithdraw(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.WithdrawNonceAccount;
    const data = encodeData(type, {
      lamports: params.lamports
    });
    return new TransactionInstruction({
      keys: [{
        pubkey: params.noncePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: params.toPubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: params.authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
  static nonceAuthorize(params) {
    const type = SYSTEM_INSTRUCTION_LAYOUTS.AuthorizeNonceAccount;
    const data = encodeData(type, {
      authorized: toBuffer(params.newAuthorizedPubkey.toBuffer())
    });
    return new TransactionInstruction({
      keys: [{
        pubkey: params.noncePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: params.authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
  static allocate(params) {
    let data;
    let keys;
    if ("basePubkey" in params) {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.AllocateWithSeed;
      data = encodeData(type, {
        base: toBuffer(params.basePubkey.toBuffer()),
        seed: params.seed,
        space: params.space,
        programId: toBuffer(params.programId.toBuffer())
      });
      keys = [{
        pubkey: params.accountPubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: params.basePubkey,
        isSigner: true,
        isWritable: false
      }];
    } else {
      const type = SYSTEM_INSTRUCTION_LAYOUTS.Allocate;
      data = encodeData(type, {
        space: params.space
      });
      keys = [{
        pubkey: params.accountPubkey,
        isSigner: true,
        isWritable: true
      }];
    }
    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data
    });
  }
}

class Loader {
  constructor() {}
  static getMinNumSignatures(dataLength) {
    return 2 * (Math.ceil(dataLength / Loader.chunkSize) + 1 + 1);
  }
  static async load(connection, payer, program, programId, data) {
    {
      const balanceNeeded = await connection.getMinimumBalanceForRentExemption(data.length);
      const programInfo = await connection.getAccountInfo(program.publicKey, "confirmed");
      let transaction = null;
      if (programInfo !== null) {
        if (programInfo.executable) {
          console.error("Program load failed, account is already executable");
          return false;
        }
        if (programInfo.data.length !== data.length) {
          transaction = transaction || new Transaction;
          transaction.add(SystemProgram.allocate({
            accountPubkey: program.publicKey,
            space: data.length
          }));
        }
        if (!programInfo.owner.equals(programId)) {
          transaction = transaction || new Transaction;
          transaction.add(SystemProgram.assign({
            accountPubkey: program.publicKey,
            programId
          }));
        }
        if (programInfo.lamports < balanceNeeded) {
          transaction = transaction || new Transaction;
          transaction.add(SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: program.publicKey,
            lamports: balanceNeeded - programInfo.lamports
          }));
        }
      } else {
        transaction = new Transaction().add(SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: program.publicKey,
          lamports: balanceNeeded > 0 ? balanceNeeded : 1,
          space: data.length,
          programId
        }));
      }
      if (transaction !== null) {
        await sendAndConfirmTransaction(connection, transaction, [payer, program], {
          commitment: "confirmed"
        });
      }
    }
    const dataLayout = BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.u32("offset"), BufferLayout.u32("bytesLength"), BufferLayout.u32("bytesLengthPadding"), BufferLayout.seq(BufferLayout.u8("byte"), BufferLayout.offset(BufferLayout.u32(), -8), "bytes")]);
    const chunkSize = Loader.chunkSize;
    let offset2 = 0;
    let array = data;
    let transactions = [];
    while (array.length > 0) {
      const bytes = array.slice(0, chunkSize);
      const data = Buffer2.alloc(chunkSize + 16);
      dataLayout.encode({
        instruction: 0,
        offset: offset2,
        bytes,
        bytesLength: 0,
        bytesLengthPadding: 0
      }, data);
      const transaction = new Transaction().add({
        keys: [{
          pubkey: program.publicKey,
          isSigner: true,
          isWritable: true
        }],
        programId,
        data
      });
      transactions.push(sendAndConfirmTransaction(connection, transaction, [payer, program], {
        commitment: "confirmed"
      }));
      if (connection._rpcEndpoint.includes("solana.com")) {
        const REQUESTS_PER_SECOND = 4;
        await sleep(1000 / REQUESTS_PER_SECOND);
      }
      offset2 += chunkSize;
      array = array.slice(chunkSize);
    }
    await Promise.all(transactions);
    {
      const dataLayout = BufferLayout.struct([BufferLayout.u32("instruction")]);
      const data = Buffer2.alloc(dataLayout.span);
      dataLayout.encode({
        instruction: 1
      }, data);
      const transaction = new Transaction().add({
        keys: [{
          pubkey: program.publicKey,
          isSigner: true,
          isWritable: true
        }, {
          pubkey: SYSVAR_RENT_PUBKEY,
          isSigner: false,
          isWritable: false
        }],
        programId,
        data
      });
      const deployCommitment = "processed";
      const finalizeSignature = await connection.sendTransaction(transaction, [payer, program], {
        preflightCommitment: deployCommitment
      });
      const {
        context,
        value
      } = await connection.confirmTransaction({
        signature: finalizeSignature,
        lastValidBlockHeight: transaction.lastValidBlockHeight,
        blockhash: transaction.recentBlockhash
      }, deployCommitment);
      if (value.err) {
        throw new Error(`Transaction ${finalizeSignature} failed (${JSON.stringify(value)})`);
      }
      while (true) {
        try {
          const currentSlot = await connection.getSlot({
            commitment: deployCommitment
          });
          if (currentSlot > context.slot) {
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, Math.round(MS_PER_SLOT / 2)));
      }
    }
    return true;
  }
}
function createRpcResult(result) {
  return union([type({
    jsonrpc: literal("2.0"),
    id: string(),
    result
  }), type({
    jsonrpc: literal("2.0"),
    id: string(),
    error: type({
      code: unknown(),
      message: string(),
      data: optional(any())
    })
  })]);
}
function jsonRpcResult(schema) {
  return coerce(createRpcResult(schema), UnknownRpcResult, (value) => {
    if ("error" in value) {
      return value;
    } else {
      return {
        ...value,
        result: create(value.result, schema)
      };
    }
  });
}
function jsonRpcResultAndContext(value) {
  return jsonRpcResult(type({
    context: type({
      slot: number()
    }),
    value
  }));
}
function notificationResultAndContext(value) {
  return type({
    context: type({
      slot: number()
    }),
    value
  });
}

class Keypair {
  constructor(keypair) {
    this._keypair = undefined;
    this._keypair = keypair ?? generateKeypair();
  }
  static generate() {
    return new Keypair(generateKeypair());
  }
  static fromSecretKey(secretKey, options) {
    if (secretKey.byteLength !== 64) {
      throw new Error("bad secret key size");
    }
    const publicKey = secretKey.slice(32, 64);
    if (!options || !options.skipValidation) {
      const privateScalar = secretKey.slice(0, 32);
      const computedPublicKey = getPublicKey(privateScalar);
      for (let ii = 0;ii < 32; ii++) {
        if (publicKey[ii] !== computedPublicKey[ii]) {
          throw new Error("provided secretKey is invalid");
        }
      }
    }
    return new Keypair({
      publicKey,
      secretKey
    });
  }
  static fromSeed(seed) {
    const publicKey = getPublicKey(seed);
    const secretKey = new Uint8Array(64);
    secretKey.set(seed);
    secretKey.set(publicKey, 32);
    return new Keypair({
      publicKey,
      secretKey
    });
  }
  get publicKey() {
    return new PublicKey(this._keypair.publicKey);
  }
  get secretKey() {
    return new Uint8Array(this._keypair.secretKey);
  }
}

class AddressLookupTableProgram {
  constructor() {}
  static createLookupTable(params) {
    const [lookupTableAddress, bumpSeed] = PublicKey.findProgramAddressSync([params.authority.toBuffer(), getU64Encoder().encode(params.recentSlot)], this.programId);
    const type = LOOKUP_TABLE_INSTRUCTION_LAYOUTS.CreateLookupTable;
    const data = encodeData(type, {
      recentSlot: BigInt(params.recentSlot),
      bumpSeed
    });
    const keys = [{
      pubkey: lookupTableAddress,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: params.authority,
      isSigner: true,
      isWritable: false
    }, {
      pubkey: params.payer,
      isSigner: true,
      isWritable: true
    }, {
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false
    }];
    return [new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    }), lookupTableAddress];
  }
  static freezeLookupTable(params) {
    const type = LOOKUP_TABLE_INSTRUCTION_LAYOUTS.FreezeLookupTable;
    const data = encodeData(type);
    const keys = [{
      pubkey: params.lookupTable,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: params.authority,
      isSigner: true,
      isWritable: false
    }];
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    });
  }
  static extendLookupTable(params) {
    const type = LOOKUP_TABLE_INSTRUCTION_LAYOUTS.ExtendLookupTable;
    const data = encodeData(type, {
      addresses: params.addresses.map((addr) => addr.toBytes())
    });
    const keys = [{
      pubkey: params.lookupTable,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: params.authority,
      isSigner: true,
      isWritable: false
    }];
    if (params.payer) {
      keys.push({
        pubkey: params.payer,
        isSigner: true,
        isWritable: true
      }, {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false
      });
    }
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    });
  }
  static deactivateLookupTable(params) {
    const type = LOOKUP_TABLE_INSTRUCTION_LAYOUTS.DeactivateLookupTable;
    const data = encodeData(type);
    const keys = [{
      pubkey: params.lookupTable,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: params.authority,
      isSigner: true,
      isWritable: false
    }];
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    });
  }
  static closeLookupTable(params) {
    const type = LOOKUP_TABLE_INSTRUCTION_LAYOUTS.CloseLookupTable;
    const data = encodeData(type);
    const keys = [{
      pubkey: params.lookupTable,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: params.authority,
      isSigner: true,
      isWritable: false
    }, {
      pubkey: params.recipient,
      isSigner: false,
      isWritable: true
    }];
    return new TransactionInstruction({
      programId: this.programId,
      keys,
      data
    });
  }
}

class ComputeBudgetProgram {
  constructor() {}
  static requestUnits(params) {
    const type = COMPUTE_BUDGET_INSTRUCTION_LAYOUTS.RequestUnits;
    const data = encodeData(type, params);
    return new TransactionInstruction({
      keys: [],
      programId: this.programId,
      data
    });
  }
  static requestHeapFrame(params) {
    const type = COMPUTE_BUDGET_INSTRUCTION_LAYOUTS.RequestHeapFrame;
    const data = encodeData(type, params);
    return new TransactionInstruction({
      keys: [],
      programId: this.programId,
      data
    });
  }
  static setComputeUnitLimit(params) {
    const type = COMPUTE_BUDGET_INSTRUCTION_LAYOUTS.SetComputeUnitLimit;
    const data = encodeData(type, params);
    return new TransactionInstruction({
      keys: [],
      programId: this.programId,
      data
    });
  }
  static setComputeUnitPrice(params) {
    const type = COMPUTE_BUDGET_INSTRUCTION_LAYOUTS.SetComputeUnitPrice;
    const data = encodeData(type, {
      microLamports: BigInt(params.microLamports)
    });
    return new TransactionInstruction({
      keys: [],
      programId: this.programId,
      data
    });
  }
}

class Ed25519Program {
  constructor() {}
  static createInstructionWithPublicKey(params) {
    const {
      publicKey,
      message,
      signature,
      instructionIndex
    } = params;
    assert2(publicKey.length === PUBLIC_KEY_BYTES$1, `Public Key must be ${PUBLIC_KEY_BYTES$1} bytes but received ${publicKey.length} bytes`);
    assert2(signature.length === SIGNATURE_BYTES, `Signature must be ${SIGNATURE_BYTES} bytes but received ${signature.length} bytes`);
    const publicKeyOffset = ED25519_INSTRUCTION_LAYOUT.span;
    const signatureOffset = publicKeyOffset + publicKey.length;
    const messageDataOffset = signatureOffset + signature.length;
    const numSignatures = 1;
    const instructionData = Buffer2.alloc(messageDataOffset + message.length);
    const index = instructionIndex == null ? 65535 : instructionIndex;
    ED25519_INSTRUCTION_LAYOUT.encode({
      numSignatures,
      padding: 0,
      signatureOffset,
      signatureInstructionIndex: index,
      publicKeyOffset,
      publicKeyInstructionIndex: index,
      messageDataOffset,
      messageDataSize: message.length,
      messageInstructionIndex: index
    }, instructionData);
    instructionData.fill(publicKey, publicKeyOffset);
    instructionData.fill(signature, signatureOffset);
    instructionData.fill(message, messageDataOffset);
    return new TransactionInstruction({
      keys: [],
      programId: Ed25519Program.programId,
      data: instructionData
    });
  }
  static createInstructionWithPrivateKey(params) {
    const {
      privateKey,
      message,
      instructionIndex
    } = params;
    assert2(privateKey.length === PRIVATE_KEY_BYTES$1, `Private key must be ${PRIVATE_KEY_BYTES$1} bytes but received ${privateKey.length} bytes`);
    try {
      const keypair = Keypair.fromSecretKey(privateKey);
      const publicKey = keypair.publicKey.toBytes();
      const signature = sign(message, keypair.secretKey);
      return this.createInstructionWithPublicKey({
        publicKey,
        message,
        signature,
        instructionIndex
      });
    } catch (error) {
      throw new Error(`Error creating instruction; ${error}`);
    }
  }
}

class Secp256k1Program {
  constructor() {}
  static publicKeyToEthAddress(publicKey) {
    assert2(publicKey.length === PUBLIC_KEY_BYTES, `Public key must be ${PUBLIC_KEY_BYTES} bytes but received ${publicKey.length} bytes`);
    try {
      return Buffer2.from(keccak_256(toBuffer(publicKey))).slice(-ETHEREUM_ADDRESS_BYTES);
    } catch (error) {
      throw new Error(`Error constructing Ethereum address: ${error}`);
    }
  }
  static createInstructionWithPublicKey(params) {
    const {
      publicKey,
      message,
      signature,
      recoveryId,
      instructionIndex
    } = params;
    return Secp256k1Program.createInstructionWithEthAddress({
      ethAddress: Secp256k1Program.publicKeyToEthAddress(publicKey),
      message,
      signature,
      recoveryId,
      instructionIndex
    });
  }
  static createInstructionWithEthAddress(params) {
    const {
      ethAddress: rawAddress,
      message,
      signature,
      recoveryId,
      instructionIndex = 0
    } = params;
    let ethAddress;
    if (typeof rawAddress === "string") {
      if (rawAddress.startsWith("0x")) {
        ethAddress = Buffer2.from(rawAddress.substr(2), "hex");
      } else {
        ethAddress = Buffer2.from(rawAddress, "hex");
      }
    } else {
      ethAddress = rawAddress;
    }
    assert2(ethAddress.length === ETHEREUM_ADDRESS_BYTES, `Address must be ${ETHEREUM_ADDRESS_BYTES} bytes but received ${ethAddress.length} bytes`);
    const dataStart = 1 + SIGNATURE_OFFSETS_SERIALIZED_SIZE;
    const ethAddressOffset = dataStart;
    const signatureOffset = dataStart + ethAddress.length;
    const messageDataOffset = signatureOffset + signature.length + 1;
    const numSignatures = 1;
    const instructionData = Buffer2.alloc(SECP256K1_INSTRUCTION_LAYOUT.span + message.length);
    SECP256K1_INSTRUCTION_LAYOUT.encode({
      numSignatures,
      signatureOffset,
      signatureInstructionIndex: instructionIndex,
      ethAddressOffset,
      ethAddressInstructionIndex: instructionIndex,
      messageDataOffset,
      messageDataSize: message.length,
      messageInstructionIndex: instructionIndex,
      signature: toBuffer(signature),
      ethAddress: toBuffer(ethAddress),
      recoveryId
    }, instructionData);
    instructionData.fill(toBuffer(message), SECP256K1_INSTRUCTION_LAYOUT.span);
    return new TransactionInstruction({
      keys: [],
      programId: Secp256k1Program.programId,
      data: instructionData
    });
  }
  static createInstructionWithPrivateKey(params) {
    const {
      privateKey: pkey,
      message,
      instructionIndex
    } = params;
    assert2(pkey.length === PRIVATE_KEY_BYTES, `Private key must be ${PRIVATE_KEY_BYTES} bytes but received ${pkey.length} bytes`);
    try {
      const privateKey = toBuffer(pkey);
      const publicKey = publicKeyCreate(privateKey, false).slice(1);
      const messageHash = Buffer2.from(keccak_256(toBuffer(message)));
      const [signature, recoveryId] = ecdsaSign(messageHash, privateKey);
      return this.createInstructionWithPublicKey({
        publicKey,
        message,
        signature,
        recoveryId,
        instructionIndex
      });
    } catch (error) {
      throw new Error(`Error creating instruction; ${error}`);
    }
  }
}

class Lockup {
  constructor(unixTimestamp, epoch, custodian) {
    this.unixTimestamp = undefined;
    this.epoch = undefined;
    this.custodian = undefined;
    this.unixTimestamp = unixTimestamp;
    this.epoch = epoch;
    this.custodian = custodian;
  }
}

class StakeProgram {
  constructor() {}
  static initialize(params) {
    const {
      stakePubkey,
      authorized,
      lockup: maybeLockup
    } = params;
    const lockup = maybeLockup || Lockup.default;
    const type = STAKE_INSTRUCTION_LAYOUTS.Initialize;
    const data = encodeData(type, {
      authorized: {
        staker: toBuffer(authorized.staker.toBuffer()),
        withdrawer: toBuffer(authorized.withdrawer.toBuffer())
      },
      lockup: {
        unixTimestamp: lockup.unixTimestamp,
        epoch: lockup.epoch,
        custodian: toBuffer(lockup.custodian.toBuffer())
      }
    });
    const instructionData = {
      keys: [{
        pubkey: stakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false
      }],
      programId: this.programId,
      data
    };
    return new TransactionInstruction(instructionData);
  }
  static createAccountWithSeed(params) {
    const transaction = new Transaction;
    transaction.add(SystemProgram.createAccountWithSeed({
      fromPubkey: params.fromPubkey,
      newAccountPubkey: params.stakePubkey,
      basePubkey: params.basePubkey,
      seed: params.seed,
      lamports: params.lamports,
      space: this.space,
      programId: this.programId
    }));
    const {
      stakePubkey,
      authorized,
      lockup
    } = params;
    return transaction.add(this.initialize({
      stakePubkey,
      authorized,
      lockup
    }));
  }
  static createAccount(params) {
    const transaction = new Transaction;
    transaction.add(SystemProgram.createAccount({
      fromPubkey: params.fromPubkey,
      newAccountPubkey: params.stakePubkey,
      lamports: params.lamports,
      space: this.space,
      programId: this.programId
    }));
    const {
      stakePubkey,
      authorized,
      lockup
    } = params;
    return transaction.add(this.initialize({
      stakePubkey,
      authorized,
      lockup
    }));
  }
  static delegate(params) {
    const {
      stakePubkey,
      authorizedPubkey,
      votePubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Delegate;
    const data = encodeData(type);
    return new Transaction().add({
      keys: [{
        pubkey: stakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: votePubkey,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_CLOCK_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_STAKE_HISTORY_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: STAKE_CONFIG_ID,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
  static authorize(params) {
    const {
      stakePubkey,
      authorizedPubkey,
      newAuthorizedPubkey,
      stakeAuthorizationType,
      custodianPubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Authorize;
    const data = encodeData(type, {
      newAuthorized: toBuffer(newAuthorizedPubkey.toBuffer()),
      stakeAuthorizationType: stakeAuthorizationType.index
    });
    const keys = [{
      pubkey: stakePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: SYSVAR_CLOCK_PUBKEY,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: authorizedPubkey,
      isSigner: true,
      isWritable: false
    }];
    if (custodianPubkey) {
      keys.push({
        pubkey: custodianPubkey,
        isSigner: true,
        isWritable: false
      });
    }
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static authorizeWithSeed(params) {
    const {
      stakePubkey,
      authorityBase,
      authoritySeed,
      authorityOwner,
      newAuthorizedPubkey,
      stakeAuthorizationType,
      custodianPubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.AuthorizeWithSeed;
    const data = encodeData(type, {
      newAuthorized: toBuffer(newAuthorizedPubkey.toBuffer()),
      stakeAuthorizationType: stakeAuthorizationType.index,
      authoritySeed,
      authorityOwner: toBuffer(authorityOwner.toBuffer())
    });
    const keys = [{
      pubkey: stakePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: authorityBase,
      isSigner: true,
      isWritable: false
    }, {
      pubkey: SYSVAR_CLOCK_PUBKEY,
      isSigner: false,
      isWritable: false
    }];
    if (custodianPubkey) {
      keys.push({
        pubkey: custodianPubkey,
        isSigner: true,
        isWritable: false
      });
    }
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static splitInstruction(params) {
    const {
      stakePubkey,
      authorizedPubkey,
      splitStakePubkey,
      lamports
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Split;
    const data = encodeData(type, {
      lamports
    });
    return new TransactionInstruction({
      keys: [{
        pubkey: stakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: splitStakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
  static split(params, rentExemptReserve) {
    const transaction = new Transaction;
    transaction.add(SystemProgram.createAccount({
      fromPubkey: params.authorizedPubkey,
      newAccountPubkey: params.splitStakePubkey,
      lamports: rentExemptReserve,
      space: this.space,
      programId: this.programId
    }));
    return transaction.add(this.splitInstruction(params));
  }
  static splitWithSeed(params, rentExemptReserve) {
    const {
      stakePubkey,
      authorizedPubkey,
      splitStakePubkey,
      basePubkey,
      seed,
      lamports
    } = params;
    const transaction = new Transaction;
    transaction.add(SystemProgram.allocate({
      accountPubkey: splitStakePubkey,
      basePubkey,
      seed,
      space: this.space,
      programId: this.programId
    }));
    if (rentExemptReserve && rentExemptReserve > 0) {
      transaction.add(SystemProgram.transfer({
        fromPubkey: params.authorizedPubkey,
        toPubkey: splitStakePubkey,
        lamports: rentExemptReserve
      }));
    }
    return transaction.add(this.splitInstruction({
      stakePubkey,
      authorizedPubkey,
      splitStakePubkey,
      lamports
    }));
  }
  static merge(params) {
    const {
      stakePubkey,
      sourceStakePubKey,
      authorizedPubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Merge;
    const data = encodeData(type);
    return new Transaction().add({
      keys: [{
        pubkey: stakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: sourceStakePubKey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_CLOCK_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_STAKE_HISTORY_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
  static withdraw(params) {
    const {
      stakePubkey,
      authorizedPubkey,
      toPubkey,
      lamports,
      custodianPubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Withdraw;
    const data = encodeData(type, {
      lamports
    });
    const keys = [{
      pubkey: stakePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: toPubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: SYSVAR_CLOCK_PUBKEY,
      isSigner: false,
      isWritable: false
    }, {
      pubkey: SYSVAR_STAKE_HISTORY_PUBKEY,
      isSigner: false,
      isWritable: false
    }, {
      pubkey: authorizedPubkey,
      isSigner: true,
      isWritable: false
    }];
    if (custodianPubkey) {
      keys.push({
        pubkey: custodianPubkey,
        isSigner: true,
        isWritable: false
      });
    }
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static deactivate(params) {
    const {
      stakePubkey,
      authorizedPubkey
    } = params;
    const type = STAKE_INSTRUCTION_LAYOUTS.Deactivate;
    const data = encodeData(type);
    return new Transaction().add({
      keys: [{
        pubkey: stakePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_CLOCK_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: authorizedPubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    });
  }
}

class VoteProgram {
  constructor() {}
  static initializeAccount(params) {
    const {
      votePubkey,
      nodePubkey,
      voteInit
    } = params;
    const type = VOTE_INSTRUCTION_LAYOUTS.InitializeAccount;
    const data = encodeData(type, {
      voteInit: {
        nodePubkey: toBuffer(voteInit.nodePubkey.toBuffer()),
        authorizedVoter: toBuffer(voteInit.authorizedVoter.toBuffer()),
        authorizedWithdrawer: toBuffer(voteInit.authorizedWithdrawer.toBuffer()),
        commission: voteInit.commission
      }
    });
    const instructionData = {
      keys: [{
        pubkey: votePubkey,
        isSigner: false,
        isWritable: true
      }, {
        pubkey: SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: SYSVAR_CLOCK_PUBKEY,
        isSigner: false,
        isWritable: false
      }, {
        pubkey: nodePubkey,
        isSigner: true,
        isWritable: false
      }],
      programId: this.programId,
      data
    };
    return new TransactionInstruction(instructionData);
  }
  static createAccount(params) {
    const transaction = new Transaction;
    transaction.add(SystemProgram.createAccount({
      fromPubkey: params.fromPubkey,
      newAccountPubkey: params.votePubkey,
      lamports: params.lamports,
      space: this.space,
      programId: this.programId
    }));
    return transaction.add(this.initializeAccount({
      votePubkey: params.votePubkey,
      nodePubkey: params.voteInit.nodePubkey,
      voteInit: params.voteInit
    }));
  }
  static authorize(params) {
    const {
      votePubkey,
      authorizedPubkey,
      newAuthorizedPubkey,
      voteAuthorizationType
    } = params;
    const type = VOTE_INSTRUCTION_LAYOUTS.Authorize;
    const data = encodeData(type, {
      newAuthorized: toBuffer(newAuthorizedPubkey.toBuffer()),
      voteAuthorizationType: voteAuthorizationType.index
    });
    const keys = [{
      pubkey: votePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: SYSVAR_CLOCK_PUBKEY,
      isSigner: false,
      isWritable: false
    }, {
      pubkey: authorizedPubkey,
      isSigner: true,
      isWritable: false
    }];
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static authorizeWithSeed(params) {
    const {
      currentAuthorityDerivedKeyBasePubkey,
      currentAuthorityDerivedKeyOwnerPubkey,
      currentAuthorityDerivedKeySeed,
      newAuthorizedPubkey,
      voteAuthorizationType,
      votePubkey
    } = params;
    const type = VOTE_INSTRUCTION_LAYOUTS.AuthorizeWithSeed;
    const data = encodeData(type, {
      voteAuthorizeWithSeedArgs: {
        currentAuthorityDerivedKeyOwnerPubkey: toBuffer(currentAuthorityDerivedKeyOwnerPubkey.toBuffer()),
        currentAuthorityDerivedKeySeed,
        newAuthorized: toBuffer(newAuthorizedPubkey.toBuffer()),
        voteAuthorizationType: voteAuthorizationType.index
      }
    });
    const keys = [{
      pubkey: votePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: SYSVAR_CLOCK_PUBKEY,
      isSigner: false,
      isWritable: false
    }, {
      pubkey: currentAuthorityDerivedKeyBasePubkey,
      isSigner: true,
      isWritable: false
    }];
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static withdraw(params) {
    const {
      votePubkey,
      authorizedWithdrawerPubkey,
      lamports,
      toPubkey
    } = params;
    const type = VOTE_INSTRUCTION_LAYOUTS.Withdraw;
    const data = encodeData(type, {
      lamports
    });
    const keys = [{
      pubkey: votePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: toPubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: authorizedWithdrawerPubkey,
      isSigner: true,
      isWritable: false
    }];
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
  static safeWithdraw(params, currentVoteAccountBalance, rentExemptMinimum) {
    if (params.lamports > currentVoteAccountBalance - rentExemptMinimum) {
      throw new Error("Withdraw will leave vote account with insufficient funds.");
    }
    return VoteProgram.withdraw(params);
  }
  static updateValidatorIdentity(params) {
    const {
      votePubkey,
      authorizedWithdrawerPubkey,
      nodePubkey
    } = params;
    const type = VOTE_INSTRUCTION_LAYOUTS.UpdateValidatorIdentity;
    const data = encodeData(type);
    const keys = [{
      pubkey: votePubkey,
      isSigner: false,
      isWritable: true
    }, {
      pubkey: nodePubkey,
      isSigner: true,
      isWritable: false
    }, {
      pubkey: authorizedWithdrawerPubkey,
      isSigner: true,
      isWritable: false
    }];
    return new Transaction().add({
      keys,
      programId: this.programId,
      data
    });
  }
}
var import_bn, import_bs58, import_borsh, BufferLayout, import_buffer_layout, import_browser, generatePrivateKey, generateKeypair = () => {
  const privateScalar = ed25519.utils.randomPrivateKey();
  const publicKey = getPublicKey(privateScalar);
  const secretKey = new Uint8Array(64);
  secretKey.set(privateScalar);
  secretKey.set(publicKey, 32);
  return {
    publicKey,
    secretKey
  };
}, getPublicKey, sign = (message, secretKey) => ed25519.sign(message, secretKey.slice(0, 32)), verify, toBuffer = (arr) => {
  if (Buffer2.isBuffer(arr)) {
    return arr;
  } else if (arr instanceof Uint8Array) {
    return Buffer2.from(arr.buffer, arr.byteOffset, arr.byteLength);
  } else {
    return Buffer2.from(arr);
  }
}, SOLANA_SCHEMA, _PublicKey, MAX_SEED_LENGTH = 32, PUBLIC_KEY_LENGTH = 32, uniquePublicKeyCounter = 1, PublicKey, BPF_LOADER_DEPRECATED_PROGRAM_ID, PACKET_DATA_SIZE, VERSION_PREFIX_MASK = 127, SIGNATURE_LENGTH_IN_BYTES = 64, TransactionExpiredBlockheightExceededError, TransactionExpiredTimeoutError, TransactionExpiredNonceInvalidError, publicKey = (property = "publicKey") => {
  return BufferLayout.blob(32, property);
}, signature = (property = "signature") => {
  return BufferLayout.blob(64, property);
}, rustString = (property = "string") => {
  const rsl = BufferLayout.struct([BufferLayout.u32("length"), BufferLayout.u32("lengthPadding"), BufferLayout.blob(BufferLayout.offset(BufferLayout.u32(), -8), "chars")], property);
  const _decode = rsl.decode.bind(rsl);
  const _encode = rsl.encode.bind(rsl);
  const rslShim = rsl;
  rslShim.decode = (b, offset) => {
    const data = _decode(b, offset);
    return data["chars"].toString();
  };
  rslShim.encode = (str, b, offset) => {
    const data = {
      chars: Buffer2.from(str, "utf8")
    };
    return _encode(data, b, offset);
  };
  rslShim.alloc = (str) => {
    return BufferLayout.u32().span + BufferLayout.u32().span + Buffer2.from(str, "utf8").length;
  };
  return rslShim;
}, authorized = (property = "authorized") => {
  return BufferLayout.struct([publicKey("staker"), publicKey("withdrawer")], property);
}, lockup = (property = "lockup") => {
  return BufferLayout.struct([BufferLayout.ns64("unixTimestamp"), BufferLayout.ns64("epoch"), publicKey("custodian")], property);
}, voteInit = (property = "voteInit") => {
  return BufferLayout.struct([publicKey("nodePubkey"), publicKey("authorizedVoter"), publicKey("authorizedWithdrawer"), BufferLayout.u8("commission")], property);
}, voteAuthorizeWithSeedArgs = (property = "voteAuthorizeWithSeedArgs") => {
  return BufferLayout.struct([BufferLayout.u32("voteAuthorizationType"), publicKey("currentAuthorityDerivedKeyOwnerPubkey"), rustString("currentAuthorityDerivedKeySeed"), publicKey("newAuthorized")], property);
}, END_OF_BUFFER_ERROR_MESSAGE = "Reached end of buffer unexpectedly", VersionedMessage, DEFAULT_SIGNATURE, NUM_TICKS_PER_SECOND = 160, DEFAULT_TICKS_PER_SLOT = 64, NUM_SLOTS_PER_SECOND, MS_PER_SLOT, SYSVAR_CLOCK_PUBKEY, SYSVAR_EPOCH_SCHEDULE_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, SYSVAR_RENT_PUBKEY, SYSVAR_REWARDS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_SLOT_HISTORY_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, SendTransactionError, FeeCalculatorLayout, NonceAccountLayout, NONCE_ACCOUNT_LENGTH, SYSTEM_INSTRUCTION_LAYOUTS, CHUNK_SIZE, BPF_LOADER_PROGRAM_ID, fetchImpl, LookupTableMetaLayout, PublicKeyFromString, RawAccountDataResult, BufferFromRawAccountData, BLOCKHASH_CACHE_TIMEOUT_MS, UnknownRpcResult, GetInflationGovernorResult, GetInflationRewardResult, GetRecentPrioritizationFeesResult, GetInflationRateResult, GetEpochInfoResult, GetEpochScheduleResult, GetLeaderScheduleResult, TransactionErrorResult, SignatureStatusResult, SignatureReceivedResult, VersionResult, ParsedInstructionStruct, PartiallyDecodedInstructionStruct, SimulatedTransactionResponseStruct, BlockProductionResponseStruct, GetInflationGovernorRpcResult, GetInflationRateRpcResult, GetRecentPrioritizationFeesRpcResult, GetEpochInfoRpcResult, GetEpochScheduleRpcResult, GetLeaderScheduleRpcResult, SlotRpcResult, GetSupplyRpcResult, TokenAmountResult, GetTokenLargestAccountsResult, GetTokenAccountsByOwner, ParsedAccountDataResult, GetParsedTokenAccountsByOwner, GetLargestAccountsRpcResult, AccountInfoResult, KeyedAccountInfoResult, ParsedOrRawAccountData, ParsedAccountInfoResult, KeyedParsedAccountInfoResult, StakeActivationResult, GetConfirmedSignaturesForAddress2RpcResult, GetSignaturesForAddressRpcResult, AccountNotificationResult, ProgramAccountInfoResult, ProgramAccountNotificationResult, SlotInfoResult, SlotNotificationResult, SlotUpdateResult, SlotUpdateNotificationResult, SignatureNotificationResult, RootNotificationResult, ContactInfoResult, VoteAccountInfoResult, GetVoteAccounts, ConfirmationStatus, SignatureStatusResponse, GetSignatureStatusesRpcResult, GetMinimumBalanceForRentExemptionRpcResult, AddressTableLookupStruct, ConfirmedTransactionResult, AnnotatedAccountKey, ConfirmedTransactionAccountsModeResult, ParsedInstructionResult, RawInstructionResult, InstructionResult, UnknownInstructionResult, ParsedOrRawInstruction, ParsedConfirmedTransactionResult, TokenBalanceResult, LoadedAddressesResult, ConfirmedTransactionMetaResult, ParsedConfirmedTransactionMetaResult, TransactionVersionStruct, RewardsResult, GetBlockRpcResult, GetNoneModeBlockRpcResult, GetAccountsModeBlockRpcResult, GetParsedBlockRpcResult, GetParsedAccountsModeBlockRpcResult, GetParsedNoneModeBlockRpcResult, GetConfirmedBlockRpcResult, GetBlockSignaturesRpcResult, GetTransactionRpcResult, GetParsedTransactionRpcResult, GetLatestBlockhashRpcResult, IsBlockhashValidRpcResult, PerfSampleResult, GetRecentPerformanceSamplesRpcResult, GetFeeCalculatorRpcResult, RequestAirdropRpcResult, SendTransactionRpcResult, LogsResult, LogsNotificationResult, LOOKUP_TABLE_INSTRUCTION_LAYOUTS, COMPUTE_BUDGET_INSTRUCTION_LAYOUTS, PRIVATE_KEY_BYTES$1 = 64, PUBLIC_KEY_BYTES$1 = 32, SIGNATURE_BYTES = 64, ED25519_INSTRUCTION_LAYOUT, ecdsaSign = (msgHash, privKey) => {
  const signature = secp256k1.sign(msgHash, privKey);
  return [signature.toCompactRawBytes(), signature.recovery];
}, publicKeyCreate, PRIVATE_KEY_BYTES = 32, ETHEREUM_ADDRESS_BYTES = 20, PUBLIC_KEY_BYTES = 64, SIGNATURE_OFFSETS_SERIALIZED_SIZE = 11, SECP256K1_INSTRUCTION_LAYOUT, _Lockup, STAKE_CONFIG_ID, STAKE_INSTRUCTION_LAYOUTS, StakeAuthorizationLayout, VOTE_INSTRUCTION_LAYOUTS, VoteAuthorizationLayout, VALIDATOR_INFO_KEY, InfoString, VOTE_PROGRAM_ID, VoteAccountLayout;
var init_index_browser_esm = __esm(() => {
  init_buffer();
  init_ed25519();
  init_sha256();
  init_index_browser3();
  init_dist();
  init_index_browser4();
  init_sha3();
  init_secp256k1();
  import_bn = __toESM(require_bn());
  import_bs58 = __toESM(require_bs58());
  import_borsh = __toESM(require_lib());
  BufferLayout = __toESM(require_Layout());
  import_buffer_layout = __toESM(require_Layout());
  import_browser = __toESM(require_browser());
  generatePrivateKey = ed25519.utils.randomPrivateKey;
  getPublicKey = ed25519.getPublicKey;
  verify = ed25519.verify;
  SOLANA_SCHEMA = new Map;
  PublicKey = class PublicKey extends Struct2 {
    constructor(value) {
      super({});
      this._bn = undefined;
      if (isPublicKeyData(value)) {
        this._bn = value._bn;
      } else {
        if (typeof value === "string") {
          const decoded = import_bs58.default.decode(value);
          if (decoded.length != PUBLIC_KEY_LENGTH) {
            throw new Error(`Invalid public key input`);
          }
          this._bn = new import_bn.default(decoded);
        } else {
          this._bn = new import_bn.default(value);
        }
        if (this._bn.byteLength() > PUBLIC_KEY_LENGTH) {
          throw new Error(`Invalid public key input`);
        }
      }
    }
    static unique() {
      const key = new PublicKey(uniquePublicKeyCounter);
      uniquePublicKeyCounter += 1;
      return new PublicKey(key.toBuffer());
    }
    equals(publicKey) {
      return this._bn.eq(publicKey._bn);
    }
    toBase58() {
      return import_bs58.default.encode(this.toBytes());
    }
    toJSON() {
      return this.toBase58();
    }
    toBytes() {
      const buf = this.toBuffer();
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    toBuffer() {
      const b = this._bn.toArrayLike(Buffer2);
      if (b.length === PUBLIC_KEY_LENGTH) {
        return b;
      }
      const zeroPad = Buffer2.alloc(32);
      b.copy(zeroPad, 32 - b.length);
      return zeroPad;
    }
    get [Symbol.toStringTag]() {
      return `PublicKey(${this.toString()})`;
    }
    toString() {
      return this.toBase58();
    }
    static async createWithSeed(fromPublicKey, seed, programId) {
      const buffer = Buffer2.concat([fromPublicKey.toBuffer(), Buffer2.from(seed), programId.toBuffer()]);
      const publicKeyBytes = sha2562(buffer);
      return new PublicKey(publicKeyBytes);
    }
    static createProgramAddressSync(seeds, programId) {
      let buffer = Buffer2.alloc(0);
      seeds.forEach(function(seed) {
        if (seed.length > MAX_SEED_LENGTH) {
          throw new TypeError(`Max seed length exceeded`);
        }
        buffer = Buffer2.concat([buffer, toBuffer(seed)]);
      });
      buffer = Buffer2.concat([buffer, programId.toBuffer(), Buffer2.from("ProgramDerivedAddress")]);
      const publicKeyBytes = sha2562(buffer);
      if (isOnCurve(publicKeyBytes)) {
        throw new Error(`Invalid seeds, address must fall off the curve`);
      }
      return new PublicKey(publicKeyBytes);
    }
    static async createProgramAddress(seeds, programId) {
      return this.createProgramAddressSync(seeds, programId);
    }
    static findProgramAddressSync(seeds, programId) {
      let nonce = 255;
      let address;
      while (nonce != 0) {
        try {
          const seedsWithNonce = seeds.concat(Buffer2.from([nonce]));
          address = this.createProgramAddressSync(seedsWithNonce, programId);
        } catch (err) {
          if (err instanceof TypeError) {
            throw err;
          }
          nonce--;
          continue;
        }
        return [address, nonce];
      }
      throw new Error(`Unable to find a viable program address nonce`);
    }
    static async findProgramAddress(seeds, programId) {
      return this.findProgramAddressSync(seeds, programId);
    }
    static isOnCurve(pubkeyData) {
      const pubkey = new PublicKey(pubkeyData);
      return isOnCurve(pubkey.toBytes());
    }
  };
  _PublicKey = PublicKey;
  PublicKey.default = new _PublicKey("11111111111111111111111111111111");
  SOLANA_SCHEMA.set(PublicKey, {
    kind: "struct",
    fields: [["_bn", "u256"]]
  });
  BPF_LOADER_DEPRECATED_PROGRAM_ID = new PublicKey("BPFLoader1111111111111111111111111111111111");
  PACKET_DATA_SIZE = 1280 - 40 - 8;
  TransactionExpiredBlockheightExceededError = class TransactionExpiredBlockheightExceededError extends Error {
    constructor(signature) {
      super(`Signature ${signature} has expired: block height exceeded.`);
      this.signature = undefined;
      this.signature = signature;
    }
  };
  Object.defineProperty(TransactionExpiredBlockheightExceededError.prototype, "name", {
    value: "TransactionExpiredBlockheightExceededError"
  });
  TransactionExpiredTimeoutError = class TransactionExpiredTimeoutError extends Error {
    constructor(signature, timeoutSeconds) {
      super(`Transaction was not confirmed in ${timeoutSeconds.toFixed(2)} seconds. It is ` + "unknown if it succeeded or failed. Check signature " + `${signature} using the Solana Explorer or CLI tools.`);
      this.signature = undefined;
      this.signature = signature;
    }
  };
  Object.defineProperty(TransactionExpiredTimeoutError.prototype, "name", {
    value: "TransactionExpiredTimeoutError"
  });
  TransactionExpiredNonceInvalidError = class TransactionExpiredNonceInvalidError extends Error {
    constructor(signature) {
      super(`Signature ${signature} has expired: the nonce is no longer valid.`);
      this.signature = undefined;
      this.signature = signature;
    }
  };
  Object.defineProperty(TransactionExpiredNonceInvalidError.prototype, "name", {
    value: "TransactionExpiredNonceInvalidError"
  });
  VersionedMessage = {
    deserializeMessageVersion(serializedMessage) {
      const prefix = serializedMessage[0];
      const maskedPrefix = prefix & VERSION_PREFIX_MASK;
      if (maskedPrefix === prefix) {
        return "legacy";
      }
      return maskedPrefix;
    },
    deserialize: (serializedMessage) => {
      const version = VersionedMessage.deserializeMessageVersion(serializedMessage);
      if (version === "legacy") {
        return Message.from(serializedMessage);
      }
      if (version === 0) {
        return MessageV0.deserialize(serializedMessage);
      } else {
        throw new Error(`Transaction message version ${version} deserialization is not supported`);
      }
    }
  };
  DEFAULT_SIGNATURE = Buffer2.alloc(SIGNATURE_LENGTH_IN_BYTES).fill(0);
  NUM_SLOTS_PER_SECOND = NUM_TICKS_PER_SECOND / DEFAULT_TICKS_PER_SLOT;
  MS_PER_SLOT = 1000 / NUM_SLOTS_PER_SECOND;
  SYSVAR_CLOCK_PUBKEY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
  SYSVAR_EPOCH_SCHEDULE_PUBKEY = new PublicKey("SysvarEpochSchedu1e111111111111111111111111");
  SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey("Sysvar1nstructions1111111111111111111111111");
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY = new PublicKey("SysvarRecentB1ockHashes11111111111111111111");
  SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");
  SYSVAR_REWARDS_PUBKEY = new PublicKey("SysvarRewards111111111111111111111111111111");
  SYSVAR_SLOT_HASHES_PUBKEY = new PublicKey("SysvarS1otHashes111111111111111111111111111");
  SYSVAR_SLOT_HISTORY_PUBKEY = new PublicKey("SysvarS1otHistory11111111111111111111111111");
  SYSVAR_STAKE_HISTORY_PUBKEY = new PublicKey("SysvarStakeHistory1111111111111111111111111");
  SendTransactionError = class SendTransactionError extends Error {
    constructor({
      action,
      signature,
      transactionMessage,
      logs
    }) {
      const maybeLogsOutput = logs ? `Logs: 
${JSON.stringify(logs.slice(-10), null, 2)}. ` : "";
      const guideText = "\nCatch the `SendTransactionError` and call `getLogs()` on it for full details.";
      let message;
      switch (action) {
        case "send":
          message = `Transaction ${signature} resulted in an error. 
` + `${transactionMessage}. ` + maybeLogsOutput + guideText;
          break;
        case "simulate":
          message = `Simulation failed. 
Message: ${transactionMessage}. 
` + maybeLogsOutput + guideText;
          break;
        default: {
          message = `Unknown action '${((a) => a)(action)}'`;
        }
      }
      super(message);
      this.signature = undefined;
      this.transactionMessage = undefined;
      this.transactionLogs = undefined;
      this.signature = signature;
      this.transactionMessage = transactionMessage;
      this.transactionLogs = logs ? logs : undefined;
    }
    get transactionError() {
      return {
        message: this.transactionMessage,
        logs: Array.isArray(this.transactionLogs) ? this.transactionLogs : undefined
      };
    }
    get logs() {
      const cachedLogs = this.transactionLogs;
      if (cachedLogs != null && typeof cachedLogs === "object" && "then" in cachedLogs) {
        return;
      }
      return cachedLogs;
    }
    async getLogs(connection) {
      if (!Array.isArray(this.transactionLogs)) {
        this.transactionLogs = new Promise((resolve, reject) => {
          connection.getTransaction(this.signature).then((tx) => {
            if (tx && tx.meta && tx.meta.logMessages) {
              const logs = tx.meta.logMessages;
              this.transactionLogs = logs;
              resolve(logs);
            } else {
              reject(new Error("Log messages not found"));
            }
          }).catch(reject);
        });
      }
      return await this.transactionLogs;
    }
  };
  FeeCalculatorLayout = BufferLayout.nu64("lamportsPerSignature");
  NonceAccountLayout = BufferLayout.struct([BufferLayout.u32("version"), BufferLayout.u32("state"), publicKey("authorizedPubkey"), publicKey("nonce"), BufferLayout.struct([FeeCalculatorLayout], "feeCalculator")]);
  NONCE_ACCOUNT_LENGTH = NonceAccountLayout.span;
  SYSTEM_INSTRUCTION_LAYOUTS = Object.freeze({
    Create: {
      index: 0,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("lamports"), BufferLayout.ns64("space"), publicKey("programId")])
    },
    Assign: {
      index: 1,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("programId")])
    },
    Transfer: {
      index: 2,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), u64("lamports")])
    },
    CreateWithSeed: {
      index: 3,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("base"), rustString("seed"), BufferLayout.ns64("lamports"), BufferLayout.ns64("space"), publicKey("programId")])
    },
    AdvanceNonceAccount: {
      index: 4,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    WithdrawNonceAccount: {
      index: 5,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("lamports")])
    },
    InitializeNonceAccount: {
      index: 6,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("authorized")])
    },
    AuthorizeNonceAccount: {
      index: 7,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("authorized")])
    },
    Allocate: {
      index: 8,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("space")])
    },
    AllocateWithSeed: {
      index: 9,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("base"), rustString("seed"), BufferLayout.ns64("space"), publicKey("programId")])
    },
    AssignWithSeed: {
      index: 10,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("base"), rustString("seed"), publicKey("programId")])
    },
    TransferWithSeed: {
      index: 11,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), u64("lamports"), rustString("seed"), publicKey("programId")])
    },
    UpgradeNonceAccount: {
      index: 12,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    }
  });
  SystemProgram.programId = new PublicKey("11111111111111111111111111111111");
  CHUNK_SIZE = PACKET_DATA_SIZE - 300;
  Loader.chunkSize = CHUNK_SIZE;
  BPF_LOADER_PROGRAM_ID = new PublicKey("BPFLoader2111111111111111111111111111111111");
  fetchImpl = globalThis.fetch;
  LookupTableMetaLayout = {
    index: 1,
    layout: BufferLayout.struct([
      BufferLayout.u32("typeIndex"),
      u64("deactivationSlot"),
      BufferLayout.nu64("lastExtendedSlot"),
      BufferLayout.u8("lastExtendedStartIndex"),
      BufferLayout.u8(),
      BufferLayout.seq(publicKey(), BufferLayout.offset(BufferLayout.u8(), -1), "authority")
    ])
  };
  PublicKeyFromString = coerce(instance(PublicKey), string(), (value) => new PublicKey(value));
  RawAccountDataResult = tuple([string(), literal("base64")]);
  BufferFromRawAccountData = coerce(instance(Buffer2), RawAccountDataResult, (value) => Buffer2.from(value[0], "base64"));
  BLOCKHASH_CACHE_TIMEOUT_MS = 30 * 1000;
  UnknownRpcResult = createRpcResult(unknown());
  GetInflationGovernorResult = type({
    foundation: number(),
    foundationTerm: number(),
    initial: number(),
    taper: number(),
    terminal: number()
  });
  GetInflationRewardResult = jsonRpcResult(array(nullable(type({
    epoch: number(),
    effectiveSlot: number(),
    amount: number(),
    postBalance: number(),
    commission: optional(nullable(number()))
  }))));
  GetRecentPrioritizationFeesResult = array(type({
    slot: number(),
    prioritizationFee: number()
  }));
  GetInflationRateResult = type({
    total: number(),
    validator: number(),
    foundation: number(),
    epoch: number()
  });
  GetEpochInfoResult = type({
    epoch: number(),
    slotIndex: number(),
    slotsInEpoch: number(),
    absoluteSlot: number(),
    blockHeight: optional(number()),
    transactionCount: optional(number())
  });
  GetEpochScheduleResult = type({
    slotsPerEpoch: number(),
    leaderScheduleSlotOffset: number(),
    warmup: boolean(),
    firstNormalEpoch: number(),
    firstNormalSlot: number()
  });
  GetLeaderScheduleResult = record(string(), array(number()));
  TransactionErrorResult = nullable(union([type({}), string()]));
  SignatureStatusResult = type({
    err: TransactionErrorResult
  });
  SignatureReceivedResult = literal("receivedSignature");
  VersionResult = type({
    "solana-core": string(),
    "feature-set": optional(number())
  });
  ParsedInstructionStruct = type({
    program: string(),
    programId: PublicKeyFromString,
    parsed: unknown()
  });
  PartiallyDecodedInstructionStruct = type({
    programId: PublicKeyFromString,
    accounts: array(PublicKeyFromString),
    data: string()
  });
  SimulatedTransactionResponseStruct = jsonRpcResultAndContext(type({
    err: nullable(union([type({}), string()])),
    logs: nullable(array(string())),
    accounts: optional(nullable(array(nullable(type({
      executable: boolean(),
      owner: string(),
      lamports: number(),
      data: array(string()),
      rentEpoch: optional(number())
    }))))),
    unitsConsumed: optional(number()),
    returnData: optional(nullable(type({
      programId: string(),
      data: tuple([string(), literal("base64")])
    }))),
    innerInstructions: optional(nullable(array(type({
      index: number(),
      instructions: array(union([ParsedInstructionStruct, PartiallyDecodedInstructionStruct]))
    }))))
  }));
  BlockProductionResponseStruct = jsonRpcResultAndContext(type({
    byIdentity: record(string(), array(number())),
    range: type({
      firstSlot: number(),
      lastSlot: number()
    })
  }));
  GetInflationGovernorRpcResult = jsonRpcResult(GetInflationGovernorResult);
  GetInflationRateRpcResult = jsonRpcResult(GetInflationRateResult);
  GetRecentPrioritizationFeesRpcResult = jsonRpcResult(GetRecentPrioritizationFeesResult);
  GetEpochInfoRpcResult = jsonRpcResult(GetEpochInfoResult);
  GetEpochScheduleRpcResult = jsonRpcResult(GetEpochScheduleResult);
  GetLeaderScheduleRpcResult = jsonRpcResult(GetLeaderScheduleResult);
  SlotRpcResult = jsonRpcResult(number());
  GetSupplyRpcResult = jsonRpcResultAndContext(type({
    total: number(),
    circulating: number(),
    nonCirculating: number(),
    nonCirculatingAccounts: array(PublicKeyFromString)
  }));
  TokenAmountResult = type({
    amount: string(),
    uiAmount: nullable(number()),
    decimals: number(),
    uiAmountString: optional(string())
  });
  GetTokenLargestAccountsResult = jsonRpcResultAndContext(array(type({
    address: PublicKeyFromString,
    amount: string(),
    uiAmount: nullable(number()),
    decimals: number(),
    uiAmountString: optional(string())
  })));
  GetTokenAccountsByOwner = jsonRpcResultAndContext(array(type({
    pubkey: PublicKeyFromString,
    account: type({
      executable: boolean(),
      owner: PublicKeyFromString,
      lamports: number(),
      data: BufferFromRawAccountData,
      rentEpoch: number()
    })
  })));
  ParsedAccountDataResult = type({
    program: string(),
    parsed: unknown(),
    space: number()
  });
  GetParsedTokenAccountsByOwner = jsonRpcResultAndContext(array(type({
    pubkey: PublicKeyFromString,
    account: type({
      executable: boolean(),
      owner: PublicKeyFromString,
      lamports: number(),
      data: ParsedAccountDataResult,
      rentEpoch: number()
    })
  })));
  GetLargestAccountsRpcResult = jsonRpcResultAndContext(array(type({
    lamports: number(),
    address: PublicKeyFromString
  })));
  AccountInfoResult = type({
    executable: boolean(),
    owner: PublicKeyFromString,
    lamports: number(),
    data: BufferFromRawAccountData,
    rentEpoch: number()
  });
  KeyedAccountInfoResult = type({
    pubkey: PublicKeyFromString,
    account: AccountInfoResult
  });
  ParsedOrRawAccountData = coerce(union([instance(Buffer2), ParsedAccountDataResult]), union([RawAccountDataResult, ParsedAccountDataResult]), (value) => {
    if (Array.isArray(value)) {
      return create(value, BufferFromRawAccountData);
    } else {
      return value;
    }
  });
  ParsedAccountInfoResult = type({
    executable: boolean(),
    owner: PublicKeyFromString,
    lamports: number(),
    data: ParsedOrRawAccountData,
    rentEpoch: number()
  });
  KeyedParsedAccountInfoResult = type({
    pubkey: PublicKeyFromString,
    account: ParsedAccountInfoResult
  });
  StakeActivationResult = type({
    state: union([literal("active"), literal("inactive"), literal("activating"), literal("deactivating")]),
    active: number(),
    inactive: number()
  });
  GetConfirmedSignaturesForAddress2RpcResult = jsonRpcResult(array(type({
    signature: string(),
    slot: number(),
    err: TransactionErrorResult,
    memo: nullable(string()),
    blockTime: optional(nullable(number()))
  })));
  GetSignaturesForAddressRpcResult = jsonRpcResult(array(type({
    signature: string(),
    slot: number(),
    err: TransactionErrorResult,
    memo: nullable(string()),
    blockTime: optional(nullable(number()))
  })));
  AccountNotificationResult = type({
    subscription: number(),
    result: notificationResultAndContext(AccountInfoResult)
  });
  ProgramAccountInfoResult = type({
    pubkey: PublicKeyFromString,
    account: AccountInfoResult
  });
  ProgramAccountNotificationResult = type({
    subscription: number(),
    result: notificationResultAndContext(ProgramAccountInfoResult)
  });
  SlotInfoResult = type({
    parent: number(),
    slot: number(),
    root: number()
  });
  SlotNotificationResult = type({
    subscription: number(),
    result: SlotInfoResult
  });
  SlotUpdateResult = union([type({
    type: union([literal("firstShredReceived"), literal("completed"), literal("optimisticConfirmation"), literal("root")]),
    slot: number(),
    timestamp: number()
  }), type({
    type: literal("createdBank"),
    parent: number(),
    slot: number(),
    timestamp: number()
  }), type({
    type: literal("frozen"),
    slot: number(),
    timestamp: number(),
    stats: type({
      numTransactionEntries: number(),
      numSuccessfulTransactions: number(),
      numFailedTransactions: number(),
      maxTransactionsPerEntry: number()
    })
  }), type({
    type: literal("dead"),
    slot: number(),
    timestamp: number(),
    err: string()
  })]);
  SlotUpdateNotificationResult = type({
    subscription: number(),
    result: SlotUpdateResult
  });
  SignatureNotificationResult = type({
    subscription: number(),
    result: notificationResultAndContext(union([SignatureStatusResult, SignatureReceivedResult]))
  });
  RootNotificationResult = type({
    subscription: number(),
    result: number()
  });
  ContactInfoResult = type({
    pubkey: string(),
    gossip: nullable(string()),
    tpu: nullable(string()),
    rpc: nullable(string()),
    version: nullable(string())
  });
  VoteAccountInfoResult = type({
    votePubkey: string(),
    nodePubkey: string(),
    activatedStake: number(),
    epochVoteAccount: boolean(),
    epochCredits: array(tuple([number(), number(), number()])),
    commission: number(),
    lastVote: number(),
    rootSlot: nullable(number())
  });
  GetVoteAccounts = jsonRpcResult(type({
    current: array(VoteAccountInfoResult),
    delinquent: array(VoteAccountInfoResult)
  }));
  ConfirmationStatus = union([literal("processed"), literal("confirmed"), literal("finalized")]);
  SignatureStatusResponse = type({
    slot: number(),
    confirmations: nullable(number()),
    err: TransactionErrorResult,
    confirmationStatus: optional(ConfirmationStatus)
  });
  GetSignatureStatusesRpcResult = jsonRpcResultAndContext(array(nullable(SignatureStatusResponse)));
  GetMinimumBalanceForRentExemptionRpcResult = jsonRpcResult(number());
  AddressTableLookupStruct = type({
    accountKey: PublicKeyFromString,
    writableIndexes: array(number()),
    readonlyIndexes: array(number())
  });
  ConfirmedTransactionResult = type({
    signatures: array(string()),
    message: type({
      accountKeys: array(string()),
      header: type({
        numRequiredSignatures: number(),
        numReadonlySignedAccounts: number(),
        numReadonlyUnsignedAccounts: number()
      }),
      instructions: array(type({
        accounts: array(number()),
        data: string(),
        programIdIndex: number()
      })),
      recentBlockhash: string(),
      addressTableLookups: optional(array(AddressTableLookupStruct))
    })
  });
  AnnotatedAccountKey = type({
    pubkey: PublicKeyFromString,
    signer: boolean(),
    writable: boolean(),
    source: optional(union([literal("transaction"), literal("lookupTable")]))
  });
  ConfirmedTransactionAccountsModeResult = type({
    accountKeys: array(AnnotatedAccountKey),
    signatures: array(string())
  });
  ParsedInstructionResult = type({
    parsed: unknown(),
    program: string(),
    programId: PublicKeyFromString
  });
  RawInstructionResult = type({
    accounts: array(PublicKeyFromString),
    data: string(),
    programId: PublicKeyFromString
  });
  InstructionResult = union([RawInstructionResult, ParsedInstructionResult]);
  UnknownInstructionResult = union([type({
    parsed: unknown(),
    program: string(),
    programId: string()
  }), type({
    accounts: array(string()),
    data: string(),
    programId: string()
  })]);
  ParsedOrRawInstruction = coerce(InstructionResult, UnknownInstructionResult, (value) => {
    if ("accounts" in value) {
      return create(value, RawInstructionResult);
    } else {
      return create(value, ParsedInstructionResult);
    }
  });
  ParsedConfirmedTransactionResult = type({
    signatures: array(string()),
    message: type({
      accountKeys: array(AnnotatedAccountKey),
      instructions: array(ParsedOrRawInstruction),
      recentBlockhash: string(),
      addressTableLookups: optional(nullable(array(AddressTableLookupStruct)))
    })
  });
  TokenBalanceResult = type({
    accountIndex: number(),
    mint: string(),
    owner: optional(string()),
    programId: optional(string()),
    uiTokenAmount: TokenAmountResult
  });
  LoadedAddressesResult = type({
    writable: array(PublicKeyFromString),
    readonly: array(PublicKeyFromString)
  });
  ConfirmedTransactionMetaResult = type({
    err: TransactionErrorResult,
    fee: number(),
    innerInstructions: optional(nullable(array(type({
      index: number(),
      instructions: array(type({
        accounts: array(number()),
        data: string(),
        programIdIndex: number()
      }))
    })))),
    preBalances: array(number()),
    postBalances: array(number()),
    logMessages: optional(nullable(array(string()))),
    preTokenBalances: optional(nullable(array(TokenBalanceResult))),
    postTokenBalances: optional(nullable(array(TokenBalanceResult))),
    loadedAddresses: optional(LoadedAddressesResult),
    computeUnitsConsumed: optional(number()),
    costUnits: optional(number())
  });
  ParsedConfirmedTransactionMetaResult = type({
    err: TransactionErrorResult,
    fee: number(),
    innerInstructions: optional(nullable(array(type({
      index: number(),
      instructions: array(ParsedOrRawInstruction)
    })))),
    preBalances: array(number()),
    postBalances: array(number()),
    logMessages: optional(nullable(array(string()))),
    preTokenBalances: optional(nullable(array(TokenBalanceResult))),
    postTokenBalances: optional(nullable(array(TokenBalanceResult))),
    loadedAddresses: optional(LoadedAddressesResult),
    computeUnitsConsumed: optional(number()),
    costUnits: optional(number())
  });
  TransactionVersionStruct = union([literal(0), literal("legacy")]);
  RewardsResult = type({
    pubkey: string(),
    lamports: number(),
    postBalance: nullable(number()),
    rewardType: nullable(string()),
    commission: optional(nullable(number()))
  });
  GetBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    transactions: array(type({
      transaction: ConfirmedTransactionResult,
      meta: nullable(ConfirmedTransactionMetaResult),
      version: optional(TransactionVersionStruct)
    })),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetNoneModeBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetAccountsModeBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    transactions: array(type({
      transaction: ConfirmedTransactionAccountsModeResult,
      meta: nullable(ConfirmedTransactionMetaResult),
      version: optional(TransactionVersionStruct)
    })),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetParsedBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    transactions: array(type({
      transaction: ParsedConfirmedTransactionResult,
      meta: nullable(ParsedConfirmedTransactionMetaResult),
      version: optional(TransactionVersionStruct)
    })),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetParsedAccountsModeBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    transactions: array(type({
      transaction: ConfirmedTransactionAccountsModeResult,
      meta: nullable(ParsedConfirmedTransactionMetaResult),
      version: optional(TransactionVersionStruct)
    })),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetParsedNoneModeBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number()),
    blockHeight: nullable(number())
  })));
  GetConfirmedBlockRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    transactions: array(type({
      transaction: ConfirmedTransactionResult,
      meta: nullable(ConfirmedTransactionMetaResult)
    })),
    rewards: optional(array(RewardsResult)),
    blockTime: nullable(number())
  })));
  GetBlockSignaturesRpcResult = jsonRpcResult(nullable(type({
    blockhash: string(),
    previousBlockhash: string(),
    parentSlot: number(),
    signatures: array(string()),
    blockTime: nullable(number())
  })));
  GetTransactionRpcResult = jsonRpcResult(nullable(type({
    slot: number(),
    meta: nullable(ConfirmedTransactionMetaResult),
    blockTime: optional(nullable(number())),
    transaction: ConfirmedTransactionResult,
    version: optional(TransactionVersionStruct)
  })));
  GetParsedTransactionRpcResult = jsonRpcResult(nullable(type({
    slot: number(),
    transaction: ParsedConfirmedTransactionResult,
    meta: nullable(ParsedConfirmedTransactionMetaResult),
    blockTime: optional(nullable(number())),
    version: optional(TransactionVersionStruct)
  })));
  GetLatestBlockhashRpcResult = jsonRpcResultAndContext(type({
    blockhash: string(),
    lastValidBlockHeight: number()
  }));
  IsBlockhashValidRpcResult = jsonRpcResultAndContext(boolean());
  PerfSampleResult = type({
    slot: number(),
    numTransactions: number(),
    numSlots: number(),
    samplePeriodSecs: number()
  });
  GetRecentPerformanceSamplesRpcResult = jsonRpcResult(array(PerfSampleResult));
  GetFeeCalculatorRpcResult = jsonRpcResultAndContext(nullable(type({
    feeCalculator: type({
      lamportsPerSignature: number()
    })
  })));
  RequestAirdropRpcResult = jsonRpcResult(string());
  SendTransactionRpcResult = jsonRpcResult(string());
  LogsResult = type({
    err: TransactionErrorResult,
    logs: array(string()),
    signature: string()
  });
  LogsNotificationResult = type({
    result: notificationResultAndContext(LogsResult),
    subscription: number()
  });
  LOOKUP_TABLE_INSTRUCTION_LAYOUTS = Object.freeze({
    CreateLookupTable: {
      index: 0,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), u64("recentSlot"), BufferLayout.u8("bumpSeed")])
    },
    FreezeLookupTable: {
      index: 1,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    ExtendLookupTable: {
      index: 2,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), u64(), BufferLayout.seq(publicKey(), BufferLayout.offset(BufferLayout.u32(), -8), "addresses")])
    },
    DeactivateLookupTable: {
      index: 3,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    CloseLookupTable: {
      index: 4,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    }
  });
  AddressLookupTableProgram.programId = new PublicKey("AddressLookupTab1e1111111111111111111111111");
  COMPUTE_BUDGET_INSTRUCTION_LAYOUTS = Object.freeze({
    RequestUnits: {
      index: 0,
      layout: BufferLayout.struct([BufferLayout.u8("instruction"), BufferLayout.u32("units"), BufferLayout.u32("additionalFee")])
    },
    RequestHeapFrame: {
      index: 1,
      layout: BufferLayout.struct([BufferLayout.u8("instruction"), BufferLayout.u32("bytes")])
    },
    SetComputeUnitLimit: {
      index: 2,
      layout: BufferLayout.struct([BufferLayout.u8("instruction"), BufferLayout.u32("units")])
    },
    SetComputeUnitPrice: {
      index: 3,
      layout: BufferLayout.struct([BufferLayout.u8("instruction"), u64("microLamports")])
    }
  });
  ComputeBudgetProgram.programId = new PublicKey("ComputeBudget111111111111111111111111111111");
  ED25519_INSTRUCTION_LAYOUT = BufferLayout.struct([BufferLayout.u8("numSignatures"), BufferLayout.u8("padding"), BufferLayout.u16("signatureOffset"), BufferLayout.u16("signatureInstructionIndex"), BufferLayout.u16("publicKeyOffset"), BufferLayout.u16("publicKeyInstructionIndex"), BufferLayout.u16("messageDataOffset"), BufferLayout.u16("messageDataSize"), BufferLayout.u16("messageInstructionIndex")]);
  Ed25519Program.programId = new PublicKey("Ed25519SigVerify111111111111111111111111111");
  secp256k1.utils.isValidPrivateKey;
  publicKeyCreate = secp256k1.getPublicKey;
  SECP256K1_INSTRUCTION_LAYOUT = BufferLayout.struct([BufferLayout.u8("numSignatures"), BufferLayout.u16("signatureOffset"), BufferLayout.u8("signatureInstructionIndex"), BufferLayout.u16("ethAddressOffset"), BufferLayout.u8("ethAddressInstructionIndex"), BufferLayout.u16("messageDataOffset"), BufferLayout.u16("messageDataSize"), BufferLayout.u8("messageInstructionIndex"), BufferLayout.blob(20, "ethAddress"), BufferLayout.blob(64, "signature"), BufferLayout.u8("recoveryId")]);
  Secp256k1Program.programId = new PublicKey("KeccakSecp256k11111111111111111111111111111");
  STAKE_CONFIG_ID = new PublicKey("StakeConfig11111111111111111111111111111111");
  _Lockup = Lockup;
  Lockup.default = new _Lockup(0, 0, PublicKey.default);
  STAKE_INSTRUCTION_LAYOUTS = Object.freeze({
    Initialize: {
      index: 0,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), authorized(), lockup()])
    },
    Authorize: {
      index: 1,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("newAuthorized"), BufferLayout.u32("stakeAuthorizationType")])
    },
    Delegate: {
      index: 2,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    Split: {
      index: 3,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("lamports")])
    },
    Withdraw: {
      index: 4,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("lamports")])
    },
    Deactivate: {
      index: 5,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    Merge: {
      index: 7,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    AuthorizeWithSeed: {
      index: 8,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("newAuthorized"), BufferLayout.u32("stakeAuthorizationType"), rustString("authoritySeed"), publicKey("authorityOwner")])
    }
  });
  StakeAuthorizationLayout = Object.freeze({
    Staker: {
      index: 0
    },
    Withdrawer: {
      index: 1
    }
  });
  StakeProgram.programId = new PublicKey("Stake11111111111111111111111111111111111111");
  StakeProgram.space = 200;
  VOTE_INSTRUCTION_LAYOUTS = Object.freeze({
    InitializeAccount: {
      index: 0,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), voteInit()])
    },
    Authorize: {
      index: 1,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), publicKey("newAuthorized"), BufferLayout.u32("voteAuthorizationType")])
    },
    Withdraw: {
      index: 3,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), BufferLayout.ns64("lamports")])
    },
    UpdateValidatorIdentity: {
      index: 4,
      layout: BufferLayout.struct([BufferLayout.u32("instruction")])
    },
    AuthorizeWithSeed: {
      index: 10,
      layout: BufferLayout.struct([BufferLayout.u32("instruction"), voteAuthorizeWithSeedArgs()])
    }
  });
  VoteAuthorizationLayout = Object.freeze({
    Voter: {
      index: 0
    },
    Withdrawer: {
      index: 1
    }
  });
  VoteProgram.programId = new PublicKey("Vote111111111111111111111111111111111111111");
  VoteProgram.space = 3762;
  VALIDATOR_INFO_KEY = new PublicKey("Va1idator1nfo111111111111111111111111111111");
  InfoString = type({
    name: string(),
    website: optional(string()),
    details: optional(string()),
    iconUrl: optional(string()),
    keybaseUsername: optional(string())
  });
  VOTE_PROGRAM_ID = new PublicKey("Vote111111111111111111111111111111111111111");
  VoteAccountLayout = BufferLayout.struct([
    publicKey("nodePubkey"),
    publicKey("authorizedWithdrawer"),
    BufferLayout.u8("commission"),
    BufferLayout.nu64(),
    BufferLayout.seq(BufferLayout.struct([BufferLayout.nu64("slot"), BufferLayout.u32("confirmationCount")]), BufferLayout.offset(BufferLayout.u32(), -8), "votes"),
    BufferLayout.u8("rootSlotValid"),
    BufferLayout.nu64("rootSlot"),
    BufferLayout.nu64(),
    BufferLayout.seq(BufferLayout.struct([BufferLayout.nu64("epoch"), publicKey("authorizedVoter")]), BufferLayout.offset(BufferLayout.u32(), -8), "authorizedVoters"),
    BufferLayout.struct([BufferLayout.seq(BufferLayout.struct([publicKey("authorizedPubkey"), BufferLayout.nu64("epochOfLastAuthorizedSwitch"), BufferLayout.nu64("targetEpoch")]), 32, "buf"), BufferLayout.nu64("idx"), BufferLayout.u8("isEmpty")], "priorVoters"),
    BufferLayout.nu64(),
    BufferLayout.seq(BufferLayout.struct([BufferLayout.nu64("epoch"), BufferLayout.nu64("credits"), BufferLayout.nu64("prevCredits")]), BufferLayout.offset(BufferLayout.u32(), -8), "epochCredits"),
    BufferLayout.struct([BufferLayout.nu64("slot"), BufferLayout.nu64("timestamp")], "lastTimestamp")
  ]);
});

// ../../node_modules/.bun/eventemitter3@5.0.4/node_modules/eventemitter3/index.js
var require_eventemitter32 = __commonJS(function(exports, module) {
  var has = Object.prototype.hasOwnProperty;
  var prefix = "~";
  function Events() {}
  if (Object.create) {
    Events.prototype = Object.create(null);
    if (!new Events().__proto__)
      prefix = false;
  }
  function EE(fn, context, once) {
    this.fn = fn;
    this.context = context;
    this.once = once || false;
  }
  function addListener(emitter, event, fn, context, once) {
    if (typeof fn !== "function") {
      throw new TypeError("The listener must be a function");
    }
    var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
    if (!emitter._events[evt])
      emitter._events[evt] = listener, emitter._eventsCount++;
    else if (!emitter._events[evt].fn)
      emitter._events[evt].push(listener);
    else
      emitter._events[evt] = [emitter._events[evt], listener];
    return emitter;
  }
  function clearEvent(emitter, evt) {
    if (--emitter._eventsCount === 0)
      emitter._events = new Events;
    else
      delete emitter._events[evt];
  }
  function EventEmitter() {
    this._events = new Events;
    this._eventsCount = 0;
  }
  EventEmitter.prototype.eventNames = function eventNames() {
    var names = [], events, name;
    if (this._eventsCount === 0)
      return names;
    for (name in events = this._events) {
      if (has.call(events, name))
        names.push(prefix ? name.slice(1) : name);
    }
    if (Object.getOwnPropertySymbols) {
      return names.concat(Object.getOwnPropertySymbols(events));
    }
    return names;
  };
  EventEmitter.prototype.listeners = function listeners(event) {
    var evt = prefix ? prefix + event : event, handlers = this._events[evt];
    if (!handlers)
      return [];
    if (handlers.fn)
      return [handlers.fn];
    for (var i = 0, l = handlers.length, ee = new Array(l);i < l; i++) {
      ee[i] = handlers[i].fn;
    }
    return ee;
  };
  EventEmitter.prototype.listenerCount = function listenerCount(event) {
    var evt = prefix ? prefix + event : event, listeners = this._events[evt];
    if (!listeners)
      return 0;
    if (listeners.fn)
      return 1;
    return listeners.length;
  };
  EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
    var evt = prefix ? prefix + event : event;
    if (!this._events[evt])
      return false;
    var listeners = this._events[evt], len = arguments.length, args, i;
    if (listeners.fn) {
      if (listeners.once)
        this.removeListener(event, listeners.fn, undefined, true);
      switch (len) {
        case 1:
          return listeners.fn.call(listeners.context), true;
        case 2:
          return listeners.fn.call(listeners.context, a1), true;
        case 3:
          return listeners.fn.call(listeners.context, a1, a2), true;
        case 4:
          return listeners.fn.call(listeners.context, a1, a2, a3), true;
        case 5:
          return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
        case 6:
          return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
      }
      for (i = 1, args = new Array(len - 1);i < len; i++) {
        args[i - 1] = arguments[i];
      }
      listeners.fn.apply(listeners.context, args);
    } else {
      var length = listeners.length, j;
      for (i = 0;i < length; i++) {
        if (listeners[i].once)
          this.removeListener(event, listeners[i].fn, undefined, true);
        switch (len) {
          case 1:
            listeners[i].fn.call(listeners[i].context);
            break;
          case 2:
            listeners[i].fn.call(listeners[i].context, a1);
            break;
          case 3:
            listeners[i].fn.call(listeners[i].context, a1, a2);
            break;
          case 4:
            listeners[i].fn.call(listeners[i].context, a1, a2, a3);
            break;
          default:
            if (!args)
              for (j = 1, args = new Array(len - 1);j < len; j++) {
                args[j - 1] = arguments[j];
              }
            listeners[i].fn.apply(listeners[i].context, args);
        }
      }
    }
    return true;
  };
  EventEmitter.prototype.on = function on(event, fn, context) {
    return addListener(this, event, fn, context, false);
  };
  EventEmitter.prototype.once = function once(event, fn, context) {
    return addListener(this, event, fn, context, true);
  };
  EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
    var evt = prefix ? prefix + event : event;
    if (!this._events[evt])
      return this;
    if (!fn) {
      clearEvent(this, evt);
      return this;
    }
    var listeners = this._events[evt];
    if (listeners.fn) {
      if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
        clearEvent(this, evt);
      }
    } else {
      for (var i = 0, events = [], length = listeners.length;i < length; i++) {
        if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
          events.push(listeners[i]);
        }
      }
      if (events.length)
        this._events[evt] = events.length === 1 ? events[0] : events;
      else
        clearEvent(this, evt);
    }
    return this;
  };
  EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
    var evt;
    if (event) {
      evt = prefix ? prefix + event : event;
      if (this._events[evt])
        clearEvent(this, evt);
    } else {
      this._events = new Events;
      this._eventsCount = 0;
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
  EventEmitter.prototype.addListener = EventEmitter.prototype.on;
  EventEmitter.prefixed = prefix;
  EventEmitter.EventEmitter = EventEmitter;
  if (typeof module !== "undefined") {
    module.exports = EventEmitter;
  }
});

// ../../node_modules/.bun/eventemitter3@5.0.4/node_modules/eventemitter3/index.mjs
var import__2, eventemitter3_default2;
var init_eventemitter32 = __esm(() => {
  import__2 = __toESM(require_eventemitter32(), 1);
  eventemitter3_default2 = import__2.default;
});

// ../../node_modules/.bun/base-x@4.0.1/node_modules/base-x/src/index.js
var require_src2 = __commonJS(function(exports, module) {
  function base(ALPHABET) {
    if (ALPHABET.length >= 255) {
      throw new TypeError("Alphabet too long");
    }
    var BASE_MAP = new Uint8Array(256);
    for (var j = 0;j < BASE_MAP.length; j++) {
      BASE_MAP[j] = 255;
    }
    for (var i = 0;i < ALPHABET.length; i++) {
      var x = ALPHABET.charAt(i);
      var xc = x.charCodeAt(0);
      if (BASE_MAP[xc] !== 255) {
        throw new TypeError(x + " is ambiguous");
      }
      BASE_MAP[xc] = i;
    }
    var BASE = ALPHABET.length;
    var LEADER = ALPHABET.charAt(0);
    var FACTOR = Math.log(BASE) / Math.log(256);
    var iFACTOR = Math.log(256) / Math.log(BASE);
    function encode(source) {
      if (source instanceof Uint8Array) {} else if (ArrayBuffer.isView(source)) {
        source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      } else if (Array.isArray(source)) {
        source = Uint8Array.from(source);
      }
      if (!(source instanceof Uint8Array)) {
        throw new TypeError("Expected Uint8Array");
      }
      if (source.length === 0) {
        return "";
      }
      var zeroes = 0;
      var length = 0;
      var pbegin = 0;
      var pend = source.length;
      while (pbegin !== pend && source[pbegin] === 0) {
        pbegin++;
        zeroes++;
      }
      var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
      var b58 = new Uint8Array(size);
      while (pbegin !== pend) {
        var carry = source[pbegin];
        var i = 0;
        for (var it1 = size - 1;(carry !== 0 || i < length) && it1 !== -1; it1--, i++) {
          carry += 256 * b58[it1] >>> 0;
          b58[it1] = carry % BASE >>> 0;
          carry = carry / BASE >>> 0;
        }
        if (carry !== 0) {
          throw new Error("Non-zero carry");
        }
        length = i;
        pbegin++;
      }
      var it2 = size - length;
      while (it2 !== size && b58[it2] === 0) {
        it2++;
      }
      var str = LEADER.repeat(zeroes);
      for (;it2 < size; ++it2) {
        str += ALPHABET.charAt(b58[it2]);
      }
      return str;
    }
    function decodeUnsafe(source) {
      if (typeof source !== "string") {
        throw new TypeError("Expected String");
      }
      if (source.length === 0) {
        return new Uint8Array;
      }
      var psz = 0;
      var zeroes = 0;
      var length = 0;
      while (source[psz] === LEADER) {
        zeroes++;
        psz++;
      }
      var size = (source.length - psz) * FACTOR + 1 >>> 0;
      var b256 = new Uint8Array(size);
      while (source[psz]) {
        var charCode = source.charCodeAt(psz);
        if (charCode > 255) {
          return;
        }
        var carry = BASE_MAP[charCode];
        if (carry === 255) {
          return;
        }
        var i = 0;
        for (var it3 = size - 1;(carry !== 0 || i < length) && it3 !== -1; it3--, i++) {
          carry += BASE * b256[it3] >>> 0;
          b256[it3] = carry % 256 >>> 0;
          carry = carry / 256 >>> 0;
        }
        if (carry !== 0) {
          throw new Error("Non-zero carry");
        }
        length = i;
        psz++;
      }
      var it4 = size - length;
      while (it4 !== size && b256[it4] === 0) {
        it4++;
      }
      var vch = new Uint8Array(zeroes + (size - it4));
      var j = zeroes;
      while (it4 !== size) {
        vch[j++] = b256[it4++];
      }
      return vch;
    }
    function decode(string) {
      var buffer = decodeUnsafe(string);
      if (buffer) {
        return buffer;
      }
      throw new Error("Non-base" + BASE + " character");
    }
    return {
      encode,
      decodeUnsafe,
      decode
    };
  }
  module.exports = base;
});

// ../../node_modules/.bun/bs58@5.0.0/node_modules/bs58/index.js
var require_bs582 = __commonJS(function(exports, module) {
  var basex = require_src2();
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  module.exports = basex(ALPHABET);
});

// ../../node_modules/.bun/uuid@9.0.1/node_modules/uuid/dist/esm-browser/native.js
var randomUUID, native_default;
var init_native = __esm(() => {
  randomUUID = typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID.bind(crypto);
  native_default = {
    randomUUID
  };
});

// ../../node_modules/.bun/uuid@9.0.1/node_modules/uuid/dist/esm-browser/rng.js
function rng2() {
  if (!getRandomValues2) {
    getRandomValues2 = typeof crypto !== "undefined" && crypto.getRandomValues && crypto.getRandomValues.bind(crypto);
    if (!getRandomValues2) {
      throw new Error("crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported");
    }
  }
  return getRandomValues2(rnds82);
}
var getRandomValues2, rnds82;
var init_rng2 = __esm(() => {
  rnds82 = new Uint8Array(16);
});

// ../../node_modules/.bun/uuid@9.0.1/node_modules/uuid/dist/esm-browser/stringify.js
function unsafeStringify(arr, offset = 0) {
  return byteToHex2[arr[offset + 0]] + byteToHex2[arr[offset + 1]] + byteToHex2[arr[offset + 2]] + byteToHex2[arr[offset + 3]] + "-" + byteToHex2[arr[offset + 4]] + byteToHex2[arr[offset + 5]] + "-" + byteToHex2[arr[offset + 6]] + byteToHex2[arr[offset + 7]] + "-" + byteToHex2[arr[offset + 8]] + byteToHex2[arr[offset + 9]] + "-" + byteToHex2[arr[offset + 10]] + byteToHex2[arr[offset + 11]] + byteToHex2[arr[offset + 12]] + byteToHex2[arr[offset + 13]] + byteToHex2[arr[offset + 14]] + byteToHex2[arr[offset + 15]];
}
var byteToHex2;
var init_stringify2 = __esm(() => {
  byteToHex2 = [];
  for (let i = 0;i < 256; ++i) {
    byteToHex2.push((i + 256).toString(16).slice(1));
  }
});

// ../../node_modules/.bun/uuid@9.0.1/node_modules/uuid/dist/esm-browser/v4.js
function v42(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random || (options.rng || rng2)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (let i = 0;i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default2;
var init_v42 = __esm(() => {
  init_native();
  init_rng2();
  init_stringify2();
  v4_default2 = v42;
});

// ../../node_modules/.bun/uuid@9.0.1/node_modules/uuid/dist/esm-browser/index.js
var init_esm_browser2 = __esm(() => {
  init_v42();
});

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/utils.js
function isLegacyTransactionInstance(transaction) {
  return transaction.version === undefined;
}
function serializeTransaction(transaction) {
  return isLegacyTransactionInstance(transaction) ? transaction.serialize({
    verifySignatures: false,
    requireAllSignatures: false
  }) : transaction.serialize();
}

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/detectProvider.js
function isSnapSupported(provider) {
  return __awaiter(this, undefined, undefined, function* () {
    try {
      yield provider.request({ method: "wallet_getSnaps" });
      return true;
    } catch (error) {
      return false;
    }
  });
}
function detectProvider() {
  return __awaiter(this, undefined, undefined, function* () {
    try {
      const provider = window.ethereum;
      if (!provider) {
        return null;
      }
      if (provider.providers && Array.isArray(provider.providers)) {
        const providers = provider.providers;
        for (const provider of providers) {
          if (yield isSnapSupported(provider)) {
            return provider;
          }
        }
      }
      if (provider.detected && Array.isArray(provider.detected)) {
        const providers = provider.detected;
        for (const provider of providers) {
          if (yield isSnapSupported(provider)) {
            return provider;
          }
        }
      }
      if (yield isSnapSupported(provider)) {
        return provider;
      }
      return null;
    } catch (error) {
      console.error(error);
      return null;
    }
  });
}
var __awaiter = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/standard/solana.js
function isSolanaChain(chain) {
  return SOLANA_CHAINS.includes(chain);
}
var SOLANA_MAINNET_CHAIN2 = "solana:mainnet", SOLANA_DEVNET_CHAIN2 = "solana:devnet", SOLANA_TESTNET_CHAIN2 = "solana:testnet", SOLANA_LOCALNET_CHAIN = "solana:localnet", SOLANA_CHAINS;
var init_solana = __esm(() => {
  SOLANA_CHAINS = [
    SOLANA_MAINNET_CHAIN2,
    SOLANA_DEVNET_CHAIN2,
    SOLANA_TESTNET_CHAIN2,
    SOLANA_LOCALNET_CHAIN
  ];
});

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/standard/account.js
class StandardSolflareMetaMaskWalletAccount {
  get address() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_address, "f");
  }
  get publicKey() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_publicKey, "f").slice();
  }
  get chains() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_chains, "f").slice();
  }
  get features() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_features, "f").slice();
  }
  get label() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_label, "f");
  }
  get icon() {
    return __classPrivateFieldGet2(this, _StandardSolflareMetaMaskWalletAccount_icon, "f");
  }
  constructor({ address, publicKey, label, icon }) {
    _StandardSolflareMetaMaskWalletAccount_address.set(this, undefined);
    _StandardSolflareMetaMaskWalletAccount_publicKey.set(this, undefined);
    _StandardSolflareMetaMaskWalletAccount_chains.set(this, undefined);
    _StandardSolflareMetaMaskWalletAccount_features.set(this, undefined);
    _StandardSolflareMetaMaskWalletAccount_label.set(this, undefined);
    _StandardSolflareMetaMaskWalletAccount_icon.set(this, undefined);
    if (new.target === StandardSolflareMetaMaskWalletAccount) {
      Object.freeze(this);
    }
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_address, address, "f");
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_publicKey, publicKey, "f");
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_chains, chains, "f");
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_features, features, "f");
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_label, label, "f");
    __classPrivateFieldSet2(this, _StandardSolflareMetaMaskWalletAccount_icon, icon, "f");
  }
}
var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}, __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}, _StandardSolflareMetaMaskWalletAccount_address, _StandardSolflareMetaMaskWalletAccount_publicKey, _StandardSolflareMetaMaskWalletAccount_chains, _StandardSolflareMetaMaskWalletAccount_features, _StandardSolflareMetaMaskWalletAccount_label, _StandardSolflareMetaMaskWalletAccount_icon, chains, features;
var init_account = __esm(() => {
  init_esm();
  init_solana();
  chains = SOLANA_CHAINS;
  features = [SolanaSignAndSendTransaction, SolanaSignTransaction, SolanaSignMessage];
  _StandardSolflareMetaMaskWalletAccount_address = new WeakMap, _StandardSolflareMetaMaskWalletAccount_publicKey = new WeakMap, _StandardSolflareMetaMaskWalletAccount_chains = new WeakMap, _StandardSolflareMetaMaskWalletAccount_features = new WeakMap, _StandardSolflareMetaMaskWalletAccount_label = new WeakMap, _StandardSolflareMetaMaskWalletAccount_icon = new WeakMap;
});

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/types.js
var init_types = () => {};

// ../../node_modules/.bun/@solflare-wallet+metamask-sdk@1.0.3+ced9e9d346ce9123/node_modules/@solflare-wallet/metamask-sdk/lib/esm/index.js
var exports_esm = {};
__export(exports_esm, {
  default: () => esm_default
});
var import_bs582, __awaiter2 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}, SolflareMetaMask, esm_default;
var init_esm2 = __esm(() => {
  init_index_browser_esm();
  init_eventemitter32();
  init_esm_browser2();
  init_account();
  init_solana();
  import_bs582 = __toESM(require_bs582());
  init_types();
  init_account();
  SolflareMetaMask = class SolflareMetaMask extends eventemitter3_default2 {
    constructor(config) {
      super();
      this._network = "mainnet-beta";
      this._iframeParams = {};
      this._element = null;
      this._iframe = null;
      this._publicKey = null;
      this._account = null;
      this._isConnected = false;
      this._connectHandler = null;
      this._messageHandlers = {};
      this._handleEvent = (event) => {
        var _a, _b;
        switch (event.type) {
          case "connect": {
            this._collapseIframe();
            if ((_a = event.data) === null || _a === undefined ? undefined : _a.publicKey) {
              this._publicKey = event.data.publicKey;
              this._isConnected = true;
              if (this._connectHandler) {
                this._connectHandler.resolve();
                this._connectHandler = null;
              }
              this._connected();
            } else {
              if (this._connectHandler) {
                this._connectHandler.reject();
                this._connectHandler = null;
              }
              this._disconnected();
            }
            return;
          }
          case "disconnect": {
            if (this._connectHandler) {
              this._connectHandler.reject();
              this._connectHandler = null;
            }
            this._disconnected();
            return;
          }
          case "accountChanged": {
            if ((_b = event.data) === null || _b === undefined ? undefined : _b.publicKey) {
              this._publicKey = event.data.publicKey;
              this.emit("accountChanged", this.publicKey);
              this._standardConnected();
            } else {
              this.emit("accountChanged", undefined);
              this._standardDisconnected();
            }
            return;
          }
          default: {
            return;
          }
        }
      };
      this._handleResize = (data) => {
        if (data.resizeMode === "full") {
          if (data.params.mode === "fullscreen") {
            this._expandIframe();
          } else if (data.params.mode === "hide") {
            this._collapseIframe();
          }
        } else if (data.resizeMode === "coordinates") {
          this._resizeIframe(data.params);
        }
      };
      this._handleMessage = (event) => {
        var _a;
        if (((_a = event.data) === null || _a === undefined ? undefined : _a.channel) !== "solflareIframeToWalletAdapter") {
          return;
        }
        const data = event.data.data || {};
        if (data.type === "event") {
          this._handleEvent(data.event);
        } else if (data.type === "resize") {
          this._handleResize(data);
        } else if (data.type === "response") {
          if (this._messageHandlers[data.id]) {
            const { resolve, reject } = this._messageHandlers[data.id];
            delete this._messageHandlers[data.id];
            if (data.error) {
              reject(data.error);
            } else {
              resolve(data.result);
            }
          }
        }
      };
      this._removeElement = () => {
        if (this._element) {
          this._element.remove();
          this._element = null;
        }
      };
      this._removeDanglingElements = () => {
        const elements = document.getElementsByClassName("solflare-metamask-wallet-adapter-iframe");
        for (const element of elements) {
          if (element.parentElement) {
            element.remove();
          }
        }
      };
      this._injectElement = () => {
        this._removeElement();
        this._removeDanglingElements();
        const params = Object.assign(Object.assign({}, this._iframeParams), { mm: true, v: 1, cluster: this._network || "mainnet-beta", origin: window.location.origin || "", title: document.title || "" });
        const queryString = Object.keys(params).map((key) => `${key}=${encodeURIComponent(params[key])}`).join("&");
        const iframeUrl = `${SolflareMetaMask.IFRAME_URL}?${queryString}`;
        this._element = document.createElement("div");
        this._element.className = "solflare-metamask-wallet-adapter-iframe";
        this._element.innerHTML = `
      <iframe src='${iframeUrl}' style='position: fixed; top: 0; bottom: 0; left: 0; right: 0; width: 100%; height: 100%; border: none; border-radius: 0; z-index: 99999; color-scheme: auto;' allowtransparency='true'></iframe>
    `;
        document.body.appendChild(this._element);
        this._iframe = this._element.querySelector("iframe");
        window.addEventListener("message", this._handleMessage, false);
      };
      this._collapseIframe = () => {
        if (this._iframe) {
          this._iframe.style.top = "";
          this._iframe.style.right = "";
          this._iframe.style.height = "2px";
          this._iframe.style.width = "2px";
        }
      };
      this._expandIframe = () => {
        if (this._iframe) {
          this._iframe.style.top = "0px";
          this._iframe.style.bottom = "0px";
          this._iframe.style.left = "0px";
          this._iframe.style.right = "0px";
          this._iframe.style.width = "100%";
          this._iframe.style.height = "100%";
        }
      };
      this._resizeIframe = (params) => {
        if (!this._iframe) {
          return;
        }
        this._iframe.style.top = isFinite(params.top) ? `${params.top}px` : "";
        this._iframe.style.bottom = isFinite(params.bottom) ? `${params.bottom}px` : "";
        this._iframe.style.left = isFinite(params.left) ? `${params.left}px` : "";
        this._iframe.style.right = isFinite(params.right) ? `${params.right}px` : "";
        this._iframe.style.width = isFinite(params.width) ? `${params.width}px` : params.width;
        this._iframe.style.height = isFinite(params.height) ? `${params.height}px` : params.height;
      };
      this._sendIframeMessage = (data) => {
        if (!this.connected || !this.publicKey) {
          throw new Error("Wallet not connected");
        }
        return new Promise((resolve, reject) => {
          var _a, _b;
          const messageId = v4_default2();
          this._messageHandlers[messageId] = { resolve, reject };
          (_b = (_a = this._iframe) === null || _a === undefined ? undefined : _a.contentWindow) === null || _b === undefined || _b.postMessage({
            channel: "solflareWalletAdapterToIframe",
            data: Object.assign({ id: messageId }, data)
          }, "*");
        });
      };
      this._connected = () => {
        this._isConnected = true;
        this.emit("connect", this.publicKey);
        this._standardConnected();
      };
      this._disconnected = () => {
        this._publicKey = null;
        this._isConnected = false;
        window.removeEventListener("message", this._handleMessage, false);
        this._removeElement();
        this.emit("disconnect");
        this._standardDisconnected();
      };
      this._standardConnected = () => {
        if (!this.publicKey) {
          return;
        }
        const address = this.publicKey.toString();
        if (!this._account || this._account.address !== address) {
          this._account = new StandardSolflareMetaMaskWalletAccount({
            address,
            publicKey: this.publicKey.toBytes()
          });
          this.emit("standard_change", { accounts: this.standardAccounts });
        }
      };
      this._standardDisconnected = () => {
        if (this._account) {
          this._account = null;
          this.emit("standard_change", { accounts: this.standardAccounts });
        }
      };
      if (config === null || config === undefined ? undefined : config.network) {
        this._network = config === null || config === undefined ? undefined : config.network;
      }
      if (window.SolflareMetaMaskParams) {
        this._iframeParams = Object.assign(Object.assign({}, this._iframeParams), window.SolflareMetaMaskParams);
      }
      if (config === null || config === undefined ? undefined : config.params) {
        this._iframeParams = Object.assign(Object.assign({}, this._iframeParams), config === null || config === undefined ? undefined : config.params);
      }
    }
    get publicKey() {
      return this._publicKey ? new PublicKey(this._publicKey) : null;
    }
    get standardAccount() {
      return this._account;
    }
    get standardAccounts() {
      return this._account ? [this._account] : [];
    }
    get isConnected() {
      return this._isConnected;
    }
    get connected() {
      return this.isConnected;
    }
    get autoApprove() {
      return false;
    }
    connect() {
      return __awaiter2(this, undefined, undefined, function* () {
        if (this.connected) {
          return;
        }
        this._injectElement();
        yield new Promise((resolve, reject) => {
          this._connectHandler = { resolve, reject };
        });
      });
    }
    disconnect() {
      return __awaiter2(this, undefined, undefined, function* () {
        yield this._sendIframeMessage({
          method: "disconnect"
        });
        this._disconnected();
      });
    }
    signTransaction(transaction) {
      var _a;
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected || !this.publicKey) {
          throw new Error("Wallet not connected");
        }
        try {
          const serializedTransaction = serializeTransaction(transaction);
          const response = yield this._sendIframeMessage({
            method: "signTransactionV2",
            params: {
              transaction: import_bs582.default.encode(serializedTransaction)
            }
          });
          const { transaction: signedTransaction } = response;
          return isLegacyTransactionInstance(transaction) ? Transaction.from(import_bs582.default.decode(signedTransaction)) : VersionedTransaction.deserialize(import_bs582.default.decode(signedTransaction));
        } catch (e) {
          throw new Error(((_a = e === null || e === undefined ? undefined : e.toString) === null || _a === undefined ? undefined : _a.call(e)) || "Failed to sign transaction");
        }
      });
    }
    signAllTransactions(transactions) {
      var _a;
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected || !this.publicKey) {
          throw new Error("Wallet not connected");
        }
        try {
          const serializedTransactions = transactions.map((transaction) => serializeTransaction(transaction));
          const { transactions: signedTransactions } = yield this._sendIframeMessage({
            method: "signAllTransactionsV2",
            params: {
              transactions: serializedTransactions.map((transaction) => import_bs582.default.encode(transaction))
            }
          });
          return signedTransactions.map((signedTransaction, index) => {
            return isLegacyTransactionInstance(transactions[index]) ? Transaction.from(import_bs582.default.decode(signedTransaction)) : VersionedTransaction.deserialize(import_bs582.default.decode(signedTransaction));
          });
        } catch (e) {
          throw new Error(((_a = e === null || e === undefined ? undefined : e.toString) === null || _a === undefined ? undefined : _a.call(e)) || "Failed to sign transactions");
        }
      });
    }
    signAndSendTransaction(transaction, options) {
      var _a;
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected || !this.publicKey) {
          throw new Error("Wallet not connected");
        }
        try {
          const serializedTransaction = serializeTransaction(transaction);
          const { signature } = yield this._sendIframeMessage({
            method: "signAndSendTransaction",
            params: {
              transaction: import_bs582.default.encode(serializedTransaction),
              options
            }
          });
          return signature;
        } catch (e) {
          throw new Error(((_a = e === null || e === undefined ? undefined : e.toString) === null || _a === undefined ? undefined : _a.call(e)) || "Failed to sign and send transaction");
        }
      });
    }
    signMessage(data, display = "utf8") {
      var _a;
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected || !this.publicKey) {
          throw new Error("Wallet not connected");
        }
        try {
          const { signature } = yield this._sendIframeMessage({
            method: "signMessage",
            params: {
              data: import_bs582.default.encode(data),
              display
            }
          });
          return Uint8Array.from(import_bs582.default.decode(signature));
        } catch (e) {
          throw new Error(((_a = e === null || e === undefined ? undefined : e.toString) === null || _a === undefined ? undefined : _a.call(e)) || "Failed to sign message");
        }
      });
    }
    sign(data, display = "utf8") {
      return __awaiter2(this, undefined, undefined, function* () {
        return yield this.signMessage(data, display);
      });
    }
    static isSupported() {
      return __awaiter2(this, undefined, undefined, function* () {
        const provider = yield detectProvider();
        return !!provider;
      });
    }
    standardSignAndSendTransaction(...inputs) {
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected)
          throw new Error("not connected");
        const outputs = [];
        if (inputs.length === 1) {
          const { transaction, account: account2, chain, options } = inputs[0];
          const { minContextSlot, preflightCommitment, skipPreflight, maxRetries } = options || {};
          if (account2 !== this._account)
            throw new Error("invalid account");
          if (!isSolanaChain(chain))
            throw new Error("invalid chain");
          const signature = yield this.signAndSendTransaction(VersionedTransaction.deserialize(transaction), {
            preflightCommitment,
            minContextSlot,
            maxRetries,
            skipPreflight
          });
          outputs.push({ signature: import_bs582.default.decode(signature) });
        } else if (inputs.length > 1) {
          for (const input of inputs) {
            outputs.push(...yield this.standardSignAndSendTransaction(input));
          }
        }
        return outputs;
      });
    }
    standardSignTransaction(...inputs) {
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected)
          throw new Error("not connected");
        const outputs = [];
        if (inputs.length === 1) {
          const { transaction, account: account2, chain } = inputs[0];
          if (account2 !== this._account)
            throw new Error("invalid account");
          if (chain && !isSolanaChain(chain))
            throw new Error("invalid chain");
          const signedTransaction = yield this.signTransaction(VersionedTransaction.deserialize(transaction));
          outputs.push({ signedTransaction: signedTransaction.serialize() });
        } else if (inputs.length > 1) {
          let chain;
          for (const input of inputs) {
            if (input.account !== this._account)
              throw new Error("invalid account");
            if (input.chain) {
              if (!isSolanaChain(input.chain))
                throw new Error("invalid chain");
              if (chain) {
                if (input.chain !== chain)
                  throw new Error("conflicting chain");
              } else {
                chain = input.chain;
              }
            }
          }
          const transactions = inputs.map(({ transaction }) => VersionedTransaction.deserialize(transaction));
          const signedTransactions = yield this.signAllTransactions(transactions);
          outputs.push(...signedTransactions.map((signedTransaction) => ({
            signedTransaction: signedTransaction.serialize()
          })));
        }
        return outputs;
      });
    }
    standardSignMessage(...inputs) {
      return __awaiter2(this, undefined, undefined, function* () {
        if (!this.connected)
          throw new Error("not connected");
        const outputs = [];
        if (inputs.length === 1) {
          const { message, account: account2 } = inputs[0];
          if (account2 !== this._account)
            throw new Error("invalid account");
          const signature = yield this.signMessage(message);
          outputs.push({ signedMessage: message, signature });
        } else if (inputs.length > 1) {
          for (const input of inputs) {
            outputs.push(...yield this.standardSignMessage(input));
          }
        }
        return outputs;
      });
    }
  };
  SolflareMetaMask.IFRAME_URL = "https://widget.solflare.com/";
  esm_default = SolflareMetaMask;
});

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/adapters/base.js
var __extends, WalletAdapter, base_default;
var init_base = __esm(() => {
  init_eventemitter3();
  __extends = function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b)
          if (Object.prototype.hasOwnProperty.call(b, p))
            d[p] = b[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __);
    };
  }();
  WalletAdapter = function(_super) {
    __extends(WalletAdapter, _super);
    function WalletAdapter() {
      return _super !== null && _super.apply(this, arguments) || this;
    }
    return WalletAdapter;
  }(eventemitter3_default);
  base_default = WalletAdapter;
});

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/adapters/WalletProvider.js
function isString(a) {
  return typeof a === "string";
}
function isInjectedProvider(a) {
  return isObject2(a) && isFunction(a.postMessage);
}
function isObject2(a) {
  return typeof a === "object" && a !== null;
}
function isFunction(a) {
  return typeof a === "function";
}
var import_bs583, __extends2, __assign = function() {
  __assign = Object.assign || function(t) {
    for (var s, i = 1, n = arguments.length;i < n; i++) {
      s = arguments[i];
      for (var p in s)
        if (Object.prototype.hasOwnProperty.call(s, p))
          t[p] = s[p];
    }
    return t;
  };
  return __assign.apply(this, arguments);
}, __awaiter3 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}, __generator = function(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1)
      throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f)
      throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _)
      try {
        if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done)
          return t;
        if (y = 0, t)
          op = [op[0] & 2, t.value];
        switch (op[0]) {
          case 0:
          case 1:
            t = op;
            break;
          case 4:
            _.label++;
            return { value: op[1], done: false };
          case 5:
            _.label++;
            y = op[1];
            op = [0];
            continue;
          case 7:
            op = _.ops.pop();
            _.trys.pop();
            continue;
          default:
            if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
              _ = 0;
              continue;
            }
            if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
              _.label = op[1];
              break;
            }
            if (op[0] === 6 && _.label < t[1]) {
              _.label = t[1];
              t = op;
              break;
            }
            if (t && _.label < t[2]) {
              _.label = t[2];
              _.ops.push(op);
              break;
            }
            if (t[2])
              _.ops.pop();
            _.trys.pop();
            continue;
        }
        op = body.call(thisArg, _);
      } catch (e) {
        op = [6, e];
        y = 0;
      } finally {
        f = t = 0;
      }
    if (op[0] & 5)
      throw op[1];
    return { value: op[0] ? op[1] : undefined, done: true };
  }
}, __read = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m)
    return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === undefined || n-- > 0) && !(r = i.next()).done)
      ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"]))
        m.call(i);
    } finally {
      if (e)
        throw e.error;
    }
  }
  return ar;
}, Wallet, WalletProvider_default;
var init_WalletProvider = __esm(() => {
  init_eventemitter3();
  init_index_browser_esm();
  import_bs583 = __toESM(require_bs582());
  __extends2 = function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b)
          if (Object.prototype.hasOwnProperty.call(b, p))
            d[p] = b[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __);
    };
  }();
  Wallet = function(_super) {
    __extends2(Wallet, _super);
    function Wallet(provider, network) {
      var _this = _super.call(this) || this;
      _this._handleMessage = function(e) {
        if (_this._injectedProvider && e.source === window || e.origin === _this._providerUrl.origin && e.source === _this._popup) {
          if (e.data.method === "connected") {
            var newPublicKey = new PublicKey(e.data.params.publicKey);
            if (!_this._publicKey || !_this._publicKey.equals(newPublicKey)) {
              if (_this._publicKey && !_this._publicKey.equals(newPublicKey)) {
                _this._handleDisconnect();
              }
              _this._publicKey = newPublicKey;
              _this._autoApprove = !!e.data.params.autoApprove;
              _this.emit("connect", _this._publicKey);
            }
          } else if (e.data.method === "disconnected") {
            _this._handleDisconnect();
          } else if (e.data.result || e.data.error) {
            if (_this._responsePromises.has(e.data.id)) {
              var _a = __read(_this._responsePromises.get(e.data.id), 2), resolve = _a[0], reject = _a[1];
              if (e.data.result) {
                resolve(e.data.result);
              } else {
                reject(new Error(e.data.error));
              }
            }
          }
        }
      };
      _this._handleConnect = function() {
        if (!_this._handlerAdded) {
          _this._handlerAdded = true;
          window.addEventListener("message", _this._handleMessage);
          window.addEventListener("beforeunload", _this.disconnect);
        }
        if (_this._injectedProvider) {
          return new Promise(function(resolve) {
            _this._sendRequest("connect", {});
            resolve();
          });
        } else {
          window.name = "parent";
          _this._popup = window.open(_this._providerUrl.toString(), "_blank", "location,resizable,width=460,height=675");
          return new Promise(function(resolve) {
            _this.once("connect", resolve);
          });
        }
      };
      _this._handleDisconnect = function() {
        if (_this._handlerAdded) {
          _this._handlerAdded = false;
          window.removeEventListener("message", _this._handleMessage);
          window.removeEventListener("beforeunload", _this.disconnect);
        }
        if (_this._publicKey) {
          _this._publicKey = null;
          _this.emit("disconnect");
        }
        _this._responsePromises.forEach(function(_a, id) {
          var _b = __read(_a, 2), resolve = _b[0], reject = _b[1];
          _this._responsePromises.delete(id);
          reject("Wallet disconnected");
        });
      };
      _this._sendRequest = function(method, params) {
        return __awaiter3(_this, undefined, undefined, function() {
          var requestId;
          var _this = this;
          return __generator(this, function(_a) {
            if (method !== "connect" && !this.connected) {
              throw new Error("Wallet not connected");
            }
            requestId = this._nextRequestId;
            ++this._nextRequestId;
            return [2, new Promise(function(resolve, reject) {
              _this._responsePromises.set(requestId, [resolve, reject]);
              if (_this._injectedProvider) {
                _this._injectedProvider.postMessage({
                  jsonrpc: "2.0",
                  id: requestId,
                  method,
                  params: __assign({ network: _this._network }, params)
                });
              } else {
                _this._popup.postMessage({
                  jsonrpc: "2.0",
                  id: requestId,
                  method,
                  params
                }, _this._providerUrl.origin);
                if (!_this.autoApprove) {
                  _this._popup.focus();
                }
              }
            })];
          });
        });
      };
      _this.connect = function() {
        if (_this._popup) {
          _this._popup.close();
        }
        return _this._handleConnect();
      };
      _this.disconnect = function() {
        return __awaiter3(_this, undefined, undefined, function() {
          return __generator(this, function(_a) {
            switch (_a.label) {
              case 0:
                if (!this._injectedProvider)
                  return [3, 2];
                return [4, this._sendRequest("disconnect", {})];
              case 1:
                _a.sent();
                _a.label = 2;
              case 2:
                if (this._popup) {
                  this._popup.close();
                }
                this._handleDisconnect();
                return [2];
            }
          });
        });
      };
      _this.sign = function(data, display) {
        return __awaiter3(_this, undefined, undefined, function() {
          var response, signature, publicKey;
          return __generator(this, function(_a) {
            switch (_a.label) {
              case 0:
                if (!(data instanceof Uint8Array)) {
                  throw new Error("Data must be an instance of Uint8Array");
                }
                return [4, this._sendRequest("sign", {
                  data,
                  display
                })];
              case 1:
                response = _a.sent();
                signature = import_bs583.default.decode(response.signature);
                publicKey = new PublicKey(response.publicKey);
                return [2, {
                  signature,
                  publicKey
                }];
            }
          });
        });
      };
      if (isInjectedProvider(provider)) {
        _this._injectedProvider = provider;
      } else if (isString(provider)) {
        _this._providerUrl = new URL(provider);
        _this._providerUrl.hash = new URLSearchParams({
          origin: window.location.origin,
          network
        }).toString();
      } else {
        throw new Error("provider parameter must be an injected provider or a URL string.");
      }
      _this._network = network;
      _this._publicKey = null;
      _this._autoApprove = false;
      _this._popup = null;
      _this._handlerAdded = false;
      _this._nextRequestId = 1;
      _this._responsePromises = new Map;
      return _this;
    }
    Object.defineProperty(Wallet.prototype, "publicKey", {
      get: function() {
        return this._publicKey;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Wallet.prototype, "connected", {
      get: function() {
        return this._publicKey !== null;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Wallet.prototype, "autoApprove", {
      get: function() {
        return this._autoApprove;
      },
      enumerable: false,
      configurable: true
    });
    return Wallet;
  }(eventemitter3_default);
  WalletProvider_default = Wallet;
});

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/adapters/web.js
var import_bs584, __extends3, __awaiter4 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}, __generator2 = function(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1)
      throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f)
      throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _)
      try {
        if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done)
          return t;
        if (y = 0, t)
          op = [op[0] & 2, t.value];
        switch (op[0]) {
          case 0:
          case 1:
            t = op;
            break;
          case 4:
            _.label++;
            return { value: op[1], done: false };
          case 5:
            _.label++;
            y = op[1];
            op = [0];
            continue;
          case 7:
            op = _.ops.pop();
            _.trys.pop();
            continue;
          default:
            if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
              _ = 0;
              continue;
            }
            if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
              _.label = op[1];
              break;
            }
            if (op[0] === 6 && _.label < t[1]) {
              _.label = t[1];
              t = op;
              break;
            }
            if (t && _.label < t[2]) {
              _.label = t[2];
              _.ops.push(op);
              break;
            }
            if (t[2])
              _.ops.pop();
            _.trys.pop();
            continue;
        }
        op = body.call(thisArg, _);
      } catch (e) {
        op = [6, e];
        y = 0;
      } finally {
        f = t = 0;
      }
    if (op[0] & 5)
      throw op[1];
    return { value: op[0] ? op[1] : undefined, done: true };
  }
}, WebAdapter, web_default;
var init_web = __esm(() => {
  init_base();
  init_WalletProvider();
  import_bs584 = __toESM(require_bs582());
  __extends3 = function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b)
          if (Object.prototype.hasOwnProperty.call(b, p))
            d[p] = b[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __);
    };
  }();
  WebAdapter = function(_super) {
    __extends3(WebAdapter, _super);
    function WebAdapter(iframe, network, provider) {
      var _this = _super.call(this) || this;
      _this._instance = null;
      _this.handleMessage = function(data) {};
      _this._sendRequest = function(method, params) {
        return __awaiter4(_this, undefined, undefined, function() {
          var _a, _b;
          return __generator2(this, function(_c) {
            switch (_c.label) {
              case 0:
                if (!((_a = this._instance) === null || _a === undefined ? undefined : _a.sendRequest))
                  return [3, 2];
                return [4, this._instance.sendRequest(method, params)];
              case 1:
                return [2, _c.sent()];
              case 2:
                if (!((_b = this._instance) === null || _b === undefined ? undefined : _b._sendRequest))
                  return [3, 4];
                return [4, this._instance._sendRequest(method, params)];
              case 3:
                return [2, _c.sent()];
              case 4:
                throw new Error("Unsupported version of `@project-serum/sol-wallet-adapter`");
            }
          });
        });
      };
      _this._handleConnect = function() {
        _this.emit("connect");
      };
      _this._handleDisconnect = function() {
        window.clearInterval(_this._pollTimer);
        _this.emit("disconnect");
      };
      _this._network = network;
      _this._provider = provider;
      return _this;
    }
    Object.defineProperty(WebAdapter.prototype, "publicKey", {
      get: function() {
        return this._instance.publicKey || null;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(WebAdapter.prototype, "connected", {
      get: function() {
        return this._instance.connected || false;
      },
      enumerable: false,
      configurable: true
    });
    WebAdapter.prototype.connect = function() {
      return __awaiter4(this, undefined, undefined, function() {
        var _this = this;
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              this._instance = new WalletProvider_default(this._provider, this._network);
              this._instance.on("connect", this._handleConnect);
              this._instance.on("disconnect", this._handleDisconnect);
              this._pollTimer = window.setInterval(function() {
                var _a, _b;
                if (((_b = (_a = _this._instance) === null || _a === undefined ? undefined : _a._popup) === null || _b === undefined ? undefined : _b.closed) !== false) {
                  _this._handleDisconnect();
                }
              }, 200);
              return [4, this._instance.connect()];
            case 1:
              _a.sent();
              return [2];
          }
        });
      });
    };
    WebAdapter.prototype.disconnect = function() {
      return __awaiter4(this, undefined, undefined, function() {
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              this._instance.removeAllListeners("connect");
              this._instance.removeAllListeners("disconnect");
              return [4, this._instance.disconnect()];
            case 1:
              _a.sent();
              return [2];
          }
        });
      });
    };
    WebAdapter.prototype.signTransaction = function(transaction) {
      return __awaiter4(this, undefined, undefined, function() {
        var signedTransaction;
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              return [4, this._sendRequest("signTransactionV2", {
                transaction: import_bs584.default.encode(transaction)
              })];
            case 1:
              signedTransaction = _a.sent().transaction;
              return [2, import_bs584.default.decode(signedTransaction)];
          }
        });
      });
    };
    WebAdapter.prototype.signAllTransactions = function(transactions) {
      return __awaiter4(this, undefined, undefined, function() {
        var signedTransactions;
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              return [4, this._sendRequest("signAllTransactionsV2", {
                transactions: transactions.map(function(transaction) {
                  return import_bs584.default.encode(transaction);
                })
              })];
            case 1:
              signedTransactions = _a.sent().transactions;
              return [2, signedTransactions.map(function(transaction) {
                return import_bs584.default.decode(transaction);
              })];
          }
        });
      });
    };
    WebAdapter.prototype.signAndSendTransaction = function(transaction, options) {
      return __awaiter4(this, undefined, undefined, function() {
        var response;
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              return [4, this._sendRequest("signAndSendTransaction", {
                transaction: import_bs584.default.encode(transaction),
                options
              })];
            case 1:
              response = _a.sent();
              return [2, response.signature];
          }
        });
      });
    };
    WebAdapter.prototype.signMessage = function(data, display) {
      if (display === undefined) {
        display = "hex";
      }
      return __awaiter4(this, undefined, undefined, function() {
        var signature;
        return __generator2(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              return [4, this._instance.sign(data, display)];
            case 1:
              signature = _a.sent().signature;
              return [2, Uint8Array.from(signature)];
          }
        });
      });
    };
    return WebAdapter;
  }(base_default);
  web_default = WebAdapter;
});

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/adapters/iframe.js
var import_bs585, __extends4, __assign2 = function() {
  __assign2 = Object.assign || function(t) {
    for (var s, i = 1, n = arguments.length;i < n; i++) {
      s = arguments[i];
      for (var p in s)
        if (Object.prototype.hasOwnProperty.call(s, p))
          t[p] = s[p];
    }
    return t;
  };
  return __assign2.apply(this, arguments);
}, __awaiter5 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}, __generator3 = function(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1)
      throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f)
      throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _)
      try {
        if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done)
          return t;
        if (y = 0, t)
          op = [op[0] & 2, t.value];
        switch (op[0]) {
          case 0:
          case 1:
            t = op;
            break;
          case 4:
            _.label++;
            return { value: op[1], done: false };
          case 5:
            _.label++;
            y = op[1];
            op = [0];
            continue;
          case 7:
            op = _.ops.pop();
            _.trys.pop();
            continue;
          default:
            if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
              _ = 0;
              continue;
            }
            if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
              _.label = op[1];
              break;
            }
            if (op[0] === 6 && _.label < t[1]) {
              _.label = t[1];
              t = op;
              break;
            }
            if (t && _.label < t[2]) {
              _.label = t[2];
              _.ops.push(op);
              break;
            }
            if (t[2])
              _.ops.pop();
            _.trys.pop();
            continue;
        }
        op = body.call(thisArg, _);
      } catch (e) {
        op = [6, e];
        y = 0;
      } finally {
        f = t = 0;
      }
    if (op[0] & 5)
      throw op[1];
    return { value: op[0] ? op[1] : undefined, done: true };
  }
}, IframeAdapter, iframe_default;
var init_iframe = __esm(() => {
  init_index_browser_esm();
  init_base();
  init_esm_browser2();
  import_bs585 = __toESM(require_bs582());
  __extends4 = function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b)
          if (Object.prototype.hasOwnProperty.call(b, p))
            d[p] = b[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __);
    };
  }();
  IframeAdapter = function(_super) {
    __extends4(IframeAdapter, _super);
    function IframeAdapter(iframe, publicKey) {
      var _this = this;
      var _a;
      _this = _super.call(this) || this;
      _this._publicKey = null;
      _this._messageHandlers = {};
      _this.handleMessage = function(data) {
        if (_this._messageHandlers[data.id]) {
          var _a = _this._messageHandlers[data.id], { resolve, reject } = _a;
          delete _this._messageHandlers[data.id];
          if (data.error) {
            reject(data.error);
          } else {
            resolve(data.result);
          }
        }
      };
      _this._sendMessage = function(data) {
        if (!_this.connected) {
          throw new Error("Wallet not connected");
        }
        return new Promise(function(resolve, reject) {
          var _a, _b;
          var messageId = v4_default2();
          _this._messageHandlers[messageId] = { resolve, reject };
          (_b = (_a = _this._iframe) === null || _a === undefined ? undefined : _a.contentWindow) === null || _b === undefined || _b.postMessage({
            channel: "solflareWalletAdapterToIframe",
            data: __assign2({ id: messageId }, data)
          }, "*");
        });
      };
      _this._iframe = iframe;
      _this._publicKey = new PublicKey((_a = publicKey === null || publicKey === undefined ? undefined : publicKey.toString) === null || _a === undefined ? undefined : _a.call(publicKey));
      return _this;
    }
    Object.defineProperty(IframeAdapter.prototype, "publicKey", {
      get: function() {
        return this._publicKey || null;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(IframeAdapter.prototype, "connected", {
      get: function() {
        return true;
      },
      enumerable: false,
      configurable: true
    });
    IframeAdapter.prototype.connect = function() {
      return __awaiter5(this, undefined, undefined, function() {
        return __generator3(this, function(_a) {
          return [2];
        });
      });
    };
    IframeAdapter.prototype.disconnect = function() {
      return __awaiter5(this, undefined, undefined, function() {
        return __generator3(this, function(_a) {
          switch (_a.label) {
            case 0:
              return [4, this._sendMessage({
                method: "disconnect"
              })];
            case 1:
              _a.sent();
              return [2];
          }
        });
      });
    };
    IframeAdapter.prototype.signTransaction = function(transaction) {
      var _a;
      return __awaiter5(this, undefined, undefined, function() {
        var signedTransaction, e_1;
        return __generator3(this, function(_b) {
          switch (_b.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              _b.label = 1;
            case 1:
              _b.trys.push([1, 3, , 4]);
              return [4, this._sendMessage({
                method: "signTransaction",
                params: {
                  transaction: import_bs585.default.encode(transaction)
                }
              })];
            case 2:
              signedTransaction = _b.sent();
              return [2, import_bs585.default.decode(signedTransaction)];
            case 3:
              e_1 = _b.sent();
              throw new Error(((_a = e_1 === null || e_1 === undefined ? undefined : e_1.toString) === null || _a === undefined ? undefined : _a.call(e_1)) || "Failed to sign transaction");
            case 4:
              return [2];
          }
        });
      });
    };
    IframeAdapter.prototype.signAllTransactions = function(transactions) {
      var _a;
      return __awaiter5(this, undefined, undefined, function() {
        var signedTransactions, e_2;
        return __generator3(this, function(_b) {
          switch (_b.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              _b.label = 1;
            case 1:
              _b.trys.push([1, 3, , 4]);
              return [4, this._sendMessage({
                method: "signAllTransactions",
                params: {
                  transactions: transactions.map(function(transaction) {
                    return import_bs585.default.encode(transaction);
                  })
                }
              })];
            case 2:
              signedTransactions = _b.sent();
              return [2, signedTransactions.map(function(transaction) {
                return import_bs585.default.decode(transaction);
              })];
            case 3:
              e_2 = _b.sent();
              throw new Error(((_a = e_2 === null || e_2 === undefined ? undefined : e_2.toString) === null || _a === undefined ? undefined : _a.call(e_2)) || "Failed to sign transactions");
            case 4:
              return [2];
          }
        });
      });
    };
    IframeAdapter.prototype.signAndSendTransaction = function(transaction, options) {
      var _a;
      return __awaiter5(this, undefined, undefined, function() {
        var result, e_3;
        return __generator3(this, function(_b) {
          switch (_b.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              _b.label = 1;
            case 1:
              _b.trys.push([1, 3, , 4]);
              return [4, this._sendMessage({
                method: "signAndSendTransaction",
                params: {
                  transaction: import_bs585.default.encode(transaction),
                  options
                }
              })];
            case 2:
              result = _b.sent();
              return [2, result];
            case 3:
              e_3 = _b.sent();
              throw new Error(((_a = e_3 === null || e_3 === undefined ? undefined : e_3.toString) === null || _a === undefined ? undefined : _a.call(e_3)) || "Failed to sign and send transaction");
            case 4:
              return [2];
          }
        });
      });
    };
    IframeAdapter.prototype.signMessage = function(data, display) {
      var _a;
      if (display === undefined) {
        display = "hex";
      }
      return __awaiter5(this, undefined, undefined, function() {
        var result, e_4;
        return __generator3(this, function(_b) {
          switch (_b.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              _b.label = 1;
            case 1:
              _b.trys.push([1, 3, , 4]);
              return [4, this._sendMessage({
                method: "signMessage",
                params: {
                  data,
                  display
                }
              })];
            case 2:
              result = _b.sent();
              return [2, Uint8Array.from(import_bs585.default.decode(result))];
            case 3:
              e_4 = _b.sent();
              throw new Error(((_a = e_4 === null || e_4 === undefined ? undefined : e_4.toString) === null || _a === undefined ? undefined : _a.call(e_4)) || "Failed to sign message");
            case 4:
              return [2];
          }
        });
      });
    };
    return IframeAdapter;
  }(base_default);
  iframe_default = IframeAdapter;
});

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/utils.js
function isLegacyTransactionInstance2(transaction) {
  return transaction.version === undefined;
}

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/version.js
var VERSION = "1.4.2";

// ../../node_modules/.bun/@solflare-wallet+sdk@1.4.2+ced9e9d346ce9123/node_modules/@solflare-wallet/sdk/lib/esm/index.js
var exports_esm2 = {};
__export(exports_esm2, {
  default: () => esm_default2
});
var __extends5, __assign3 = function() {
  __assign3 = Object.assign || function(t) {
    for (var s, i = 1, n = arguments.length;i < n; i++) {
      s = arguments[i];
      for (var p in s)
        if (Object.prototype.hasOwnProperty.call(s, p))
          t[p] = s[p];
    }
    return t;
  };
  return __assign3.apply(this, arguments);
}, __awaiter6 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}, __generator4 = function(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1)
      throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), throw: verb(1), return: verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f)
      throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _)
      try {
        if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done)
          return t;
        if (y = 0, t)
          op = [op[0] & 2, t.value];
        switch (op[0]) {
          case 0:
          case 1:
            t = op;
            break;
          case 4:
            _.label++;
            return { value: op[1], done: false };
          case 5:
            _.label++;
            y = op[1];
            op = [0];
            continue;
          case 7:
            op = _.ops.pop();
            _.trys.pop();
            continue;
          default:
            if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
              _ = 0;
              continue;
            }
            if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
              _.label = op[1];
              break;
            }
            if (op[0] === 6 && _.label < t[1]) {
              _.label = t[1];
              t = op;
              break;
            }
            if (t && _.label < t[2]) {
              _.label = t[2];
              _.ops.push(op);
              break;
            }
            if (t[2])
              _.ops.pop();
            _.trys.pop();
            continue;
        }
        op = body.call(thisArg, _);
      } catch (e) {
        op = [6, e];
        y = 0;
      } finally {
        f = t = 0;
      }
    if (op[0] & 5)
      throw op[1];
    return { value: op[0] ? op[1] : undefined, done: true };
  }
}, __values = function(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m)
    return m.call(o);
  if (o && typeof o.length === "number")
    return {
      next: function() {
        if (o && i >= o.length)
          o = undefined;
        return { value: o && o[i++], done: !o };
      }
    };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}, Solflare, esm_default2;
var init_esm3 = __esm(() => {
  init_index_browser_esm();
  init_eventemitter3();
  init_web();
  init_iframe();
  __extends5 = function() {
    var extendStatics = function(d, b) {
      extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b)
          if (Object.prototype.hasOwnProperty.call(b, p))
            d[p] = b[p];
      };
      return extendStatics(d, b);
    };
    return function(d, b) {
      if (typeof b !== "function" && b !== null)
        throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
      extendStatics(d, b);
      function __() {
        this.constructor = d;
      }
      d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __);
    };
  }();
  Solflare = function(_super) {
    __extends5(Solflare, _super);
    function Solflare(config) {
      var _this = _super.call(this) || this;
      _this._network = "mainnet-beta";
      _this._provider = null;
      _this._iframeParams = {};
      _this._adapterInstance = null;
      _this._element = null;
      _this._iframe = null;
      _this._connectHandler = null;
      _this._flutterHandlerInterval = null;
      _this._handleEvent = function(event) {
        var _a, _b, _c, _d;
        switch (event.type) {
          case "connect_native_web": {
            _this._collapseIframe();
            _this._adapterInstance = new web_default(_this._iframe, _this._network, ((_a = event.data) === null || _a === undefined ? undefined : _a.provider) || _this._provider || "https://solflare.com/provider");
            _this._adapterInstance.on("connect", _this._webConnected);
            _this._adapterInstance.on("disconnect", _this._webDisconnected);
            _this._adapterInstance.connect();
            _this._setPreferredAdapter("native_web");
            return;
          }
          case "connect": {
            _this._collapseIframe();
            _this._adapterInstance = new iframe_default(_this._iframe, ((_b = event.data) === null || _b === undefined ? undefined : _b.publicKey) || "");
            _this._adapterInstance.connect();
            _this._setPreferredAdapter((_c = event.data) === null || _c === undefined ? undefined : _c.adapter);
            if (_this._connectHandler) {
              _this._connectHandler.resolve();
              _this._connectHandler = null;
            }
            _this.emit("connect", _this.publicKey);
            return;
          }
          case "disconnect": {
            if (_this._connectHandler) {
              _this._connectHandler.reject();
              _this._connectHandler = null;
            }
            _this._disconnected();
            _this.emit("disconnect");
            return;
          }
          case "accountChanged": {
            if ((_d = event.data) === null || _d === undefined ? undefined : _d.publicKey) {
              _this._adapterInstance = new iframe_default(_this._iframe, event.data.publicKey);
              _this._adapterInstance.connect();
              _this.emit("accountChanged", _this.publicKey);
            } else {
              _this.emit("accountChanged", undefined);
            }
            return;
          }
          case "collapse": {
            _this._collapseIframe();
            return;
          }
          default: {
            return;
          }
        }
      };
      _this._handleResize = function(data) {
        if (data.resizeMode === "full") {
          if (data.params.mode === "fullscreen") {
            _this._expandIframe();
          } else if (data.params.mode === "hide") {
            _this._collapseIframe();
          }
        } else if (data.resizeMode === "coordinates") {
          if (_this._iframe) {
            _this._iframe.style.top = isFinite(data.params.top) ? "".concat(data.params.top, "px") : "";
            _this._iframe.style.bottom = isFinite(data.params.bottom) ? "".concat(data.params.bottom, "px") : "";
            _this._iframe.style.left = isFinite(data.params.left) ? "".concat(data.params.left, "px") : "";
            _this._iframe.style.right = isFinite(data.params.right) ? "".concat(data.params.right, "px") : "";
            _this._iframe.style.width = isFinite(data.params.width) ? "".concat(data.params.width, "px") : data.params.width;
            _this._iframe.style.height = isFinite(data.params.height) ? "".concat(data.params.height, "px") : data.params.height;
          }
        }
      };
      _this._handleMessage = function(event) {
        var _a;
        if (((_a = event.data) === null || _a === undefined ? undefined : _a.channel) !== "solflareIframeToWalletAdapter") {
          return;
        }
        var data = event.data.data || {};
        if (data.type === "event") {
          _this._handleEvent(data.event);
        } else if (data.type === "resize") {
          _this._handleResize(data);
        } else if (data.type === "response") {
          if (_this._adapterInstance) {
            _this._adapterInstance.handleMessage(data);
          }
        }
      };
      _this._removeElement = function() {
        if (_this._flutterHandlerInterval !== null) {
          clearInterval(_this._flutterHandlerInterval);
          _this._flutterHandlerInterval = null;
        }
        if (_this._element) {
          _this._element.remove();
          _this._element = null;
        }
      };
      _this._removeDanglingElements = function() {
        var e_1, _a;
        var elements = document.getElementsByClassName("solflare-wallet-adapter-iframe");
        try {
          for (var elements_1 = __values(elements), elements_1_1 = elements_1.next();!elements_1_1.done; elements_1_1 = elements_1.next()) {
            var element = elements_1_1.value;
            if (element.parentElement) {
              element.remove();
            }
          }
        } catch (e_1_1) {
          e_1 = { error: e_1_1 };
        } finally {
          try {
            if (elements_1_1 && !elements_1_1.done && (_a = elements_1.return))
              _a.call(elements_1);
          } finally {
            if (e_1)
              throw e_1.error;
          }
        }
      };
      _this._injectElement = function() {
        _this._removeElement();
        _this._removeDanglingElements();
        var params = __assign3(__assign3({}, _this._iframeParams), { cluster: _this._network || "mainnet-beta", origin: window.location.origin || "", title: document.title || "", version: 1, sdkVersion: VERSION || "unknown" });
        var preferredAdapter = _this._getPreferredAdapter();
        if (preferredAdapter) {
          params.adapter = preferredAdapter;
        }
        if (_this._provider) {
          params.provider = _this._provider;
        }
        var queryString = Object.keys(params).map(function(key) {
          return "".concat(key, "=").concat(encodeURIComponent(params[key]));
        }).join("&");
        var iframeUrl = "".concat(Solflare.IFRAME_URL, "?").concat(queryString);
        _this._element = document.createElement("div");
        _this._element.className = "solflare-wallet-adapter-iframe";
        _this._element.innerHTML = `
      <iframe src='`.concat(iframeUrl, `' referrerPolicy='strict-origin-when-cross-origin' style='position: fixed; top: 0; bottom: 0; left: 0; right: 0; width: 100%; height: 100%; border: none; border-radius: 0; z-index: 99999; color-scheme: auto;' allowtransparency='true'></iframe>
    `);
        document.body.appendChild(_this._element);
        _this._iframe = _this._element.querySelector("iframe");
        window.fromFlutter = _this._handleMobileMessage;
        _this._flutterHandlerInterval = setInterval(function() {
          window.fromFlutter = _this._handleMobileMessage;
        }, 100);
        window.addEventListener("message", _this._handleMessage, false);
      };
      _this._collapseIframe = function() {
        if (_this._iframe) {
          _this._iframe.style.top = "";
          _this._iframe.style.right = "";
          _this._iframe.style.height = "2px";
          _this._iframe.style.width = "2px";
        }
      };
      _this._expandIframe = function() {
        if (_this._iframe) {
          _this._iframe.style.top = "0px";
          _this._iframe.style.bottom = "0px";
          _this._iframe.style.left = "0px";
          _this._iframe.style.right = "0px";
          _this._iframe.style.width = "100%";
          _this._iframe.style.height = "100%";
        }
      };
      _this._getPreferredAdapter = function() {
        if (localStorage) {
          return localStorage.getItem("solflarePreferredWalletAdapter") || null;
        }
        return null;
      };
      _this._setPreferredAdapter = function(adapter) {
        if (localStorage && adapter) {
          localStorage.setItem("solflarePreferredWalletAdapter", adapter);
        }
      };
      _this._clearPreferredAdapter = function() {
        if (localStorage) {
          localStorage.removeItem("solflarePreferredWalletAdapter");
        }
      };
      _this._webConnected = function() {
        if (_this._connectHandler) {
          _this._connectHandler.resolve();
          _this._connectHandler = null;
        }
        _this.emit("connect", _this.publicKey);
      };
      _this._webDisconnected = function() {
        if (_this._connectHandler) {
          _this._connectHandler.reject();
          _this._connectHandler = null;
        }
        _this._disconnected();
        _this.emit("disconnect");
      };
      _this._disconnected = function() {
        window.removeEventListener("message", _this._handleMessage, false);
        _this._removeElement();
        _this._clearPreferredAdapter();
        _this._adapterInstance = null;
      };
      _this._handleMobileMessage = function(data) {
        var _a, _b;
        (_b = (_a = _this._iframe) === null || _a === undefined ? undefined : _a.contentWindow) === null || _b === undefined || _b.postMessage({
          channel: "solflareMobileToIframe",
          data
        }, "*");
      };
      if (config === null || config === undefined ? undefined : config.network) {
        _this._network = config === null || config === undefined ? undefined : config.network;
      }
      if (config === null || config === undefined ? undefined : config.provider) {
        _this._provider = config === null || config === undefined ? undefined : config.provider;
      }
      if (config === null || config === undefined ? undefined : config.params) {
        _this._iframeParams = __assign3({}, config === null || config === undefined ? undefined : config.params);
      }
      return _this;
    }
    Object.defineProperty(Solflare.prototype, "publicKey", {
      get: function() {
        var _a;
        return ((_a = this._adapterInstance) === null || _a === undefined ? undefined : _a.publicKey) || null;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Solflare.prototype, "isConnected", {
      get: function() {
        var _a;
        return !!((_a = this._adapterInstance) === null || _a === undefined ? undefined : _a.connected);
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Solflare.prototype, "connected", {
      get: function() {
        return this.isConnected;
      },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(Solflare.prototype, "autoApprove", {
      get: function() {
        return false;
      },
      enumerable: false,
      configurable: true
    });
    Solflare.prototype.connect = function() {
      return __awaiter6(this, undefined, undefined, function() {
        var _this = this;
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (this.connected) {
                return [2];
              }
              this._injectElement();
              return [4, new Promise(function(resolve, reject) {
                _this._connectHandler = { resolve, reject };
              })];
            case 1:
              _a.sent();
              return [2];
          }
        });
      });
    };
    Solflare.prototype.disconnect = function() {
      return __awaiter6(this, undefined, undefined, function() {
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this._adapterInstance) {
                return [2];
              }
              return [4, this._adapterInstance.disconnect()];
            case 1:
              _a.sent();
              this._disconnected();
              this.emit("disconnect");
              return [2];
          }
        });
      });
    };
    Solflare.prototype.signTransaction = function(transaction) {
      return __awaiter6(this, undefined, undefined, function() {
        var serializedTransaction, signedTransaction;
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              serializedTransaction = isLegacyTransactionInstance2(transaction) ? Uint8Array.from(transaction.serialize({ verifySignatures: false, requireAllSignatures: false })) : transaction.serialize();
              return [4, this._adapterInstance.signTransaction(serializedTransaction)];
            case 1:
              signedTransaction = _a.sent();
              return [2, isLegacyTransactionInstance2(transaction) ? Transaction.from(signedTransaction) : VersionedTransaction.deserialize(signedTransaction)];
          }
        });
      });
    };
    Solflare.prototype.signAllTransactions = function(transactions) {
      return __awaiter6(this, undefined, undefined, function() {
        var serializedTransactions, signedTransactions;
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              serializedTransactions = transactions.map(function(transaction) {
                return isLegacyTransactionInstance2(transaction) ? Uint8Array.from(transaction.serialize({ verifySignatures: false, requireAllSignatures: false })) : transaction.serialize();
              });
              return [4, this._adapterInstance.signAllTransactions(serializedTransactions)];
            case 1:
              signedTransactions = _a.sent();
              if (signedTransactions.length !== transactions.length) {
                throw new Error("Failed to sign all transactions");
              }
              return [2, signedTransactions.map(function(signedTransaction, index) {
                return isLegacyTransactionInstance2(transactions[index]) ? Transaction.from(signedTransaction) : VersionedTransaction.deserialize(signedTransaction);
              })];
          }
        });
      });
    };
    Solflare.prototype.signAndSendTransaction = function(transaction, options) {
      return __awaiter6(this, undefined, undefined, function() {
        var serializedTransaction;
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              serializedTransaction = isLegacyTransactionInstance2(transaction) ? transaction.serialize({ verifySignatures: false, requireAllSignatures: false }) : transaction.serialize();
              return [4, this._adapterInstance.signAndSendTransaction(serializedTransaction, options)];
            case 1:
              return [2, _a.sent()];
          }
        });
      });
    };
    Solflare.prototype.signMessage = function(data, display) {
      if (display === undefined) {
        display = "utf8";
      }
      return __awaiter6(this, undefined, undefined, function() {
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              if (!this.connected) {
                throw new Error("Wallet not connected");
              }
              return [4, this._adapterInstance.signMessage(data, display)];
            case 1:
              return [2, _a.sent()];
          }
        });
      });
    };
    Solflare.prototype.sign = function(data, display) {
      if (display === undefined) {
        display = "utf8";
      }
      return __awaiter6(this, undefined, undefined, function() {
        return __generator4(this, function(_a) {
          switch (_a.label) {
            case 0:
              return [4, this.signMessage(data, display)];
            case 1:
              return [2, _a.sent()];
          }
        });
      });
    };
    Solflare.prototype.detectWallet = function(timeout) {
      var _a;
      if (timeout === undefined) {
        timeout = 10;
      }
      return __awaiter6(this, undefined, undefined, function() {
        return __generator4(this, function(_b) {
          if (window.SolflareApp || ((_a = window.solflare) === null || _a === undefined ? undefined : _a.isSolflare)) {
            return [2, true];
          }
          return [2, new Promise(function(resolve) {
            var pollInterval, pollTimeout;
            pollInterval = setInterval(function() {
              var _a;
              if (window.SolflareApp || ((_a = window.solflare) === null || _a === undefined ? undefined : _a.isSolflare)) {
                clearInterval(pollInterval);
                clearTimeout(pollTimeout);
                resolve(true);
              }
            }, 500);
            pollTimeout = setTimeout(function() {
              clearInterval(pollInterval);
              resolve(false);
            }, timeout * 1000);
          })];
        });
      });
    };
    Solflare.IFRAME_URL = "https://connect.solflare.com/";
    return Solflare;
  }(eventemitter3_default);
  esm_default2 = Solflare;
});

// ../../node_modules/.bun/@solana+wallet-adapter-base@0.9.28+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-base/lib/esm/adapter.js
init_eventemitter3();

// ../../node_modules/.bun/@solana+wallet-adapter-base@0.9.28+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-base/lib/esm/errors.js
class WalletError extends Error {
  constructor(message, error) {
    super(message);
    this.error = error;
  }
}

class WalletNotReadyError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletNotReadyError";
  }
}

class WalletLoadError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletLoadError";
  }
}

class WalletConfigError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletConfigError";
  }
}

class WalletConnectionError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletConnectionError";
  }
}

class WalletDisconnectedError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletDisconnectedError";
  }
}

class WalletDisconnectionError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletDisconnectionError";
  }
}

class WalletAccountError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletAccountError";
  }
}

class WalletPublicKeyError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletPublicKeyError";
  }
}
class WalletNotConnectedError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletNotConnectedError";
  }
}

class WalletSendTransactionError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletSendTransactionError";
  }
}

class WalletSignTransactionError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletSignTransactionError";
  }
}

class WalletSignMessageError extends WalletError {
  constructor() {
    super(...arguments);
    this.name = "WalletSignMessageError";
  }
}

// ../../node_modules/.bun/@solana+wallet-adapter-base@0.9.28+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-base/lib/esm/adapter.js
var WalletReadyState;
(function(WalletReadyState) {
  WalletReadyState["Installed"] = "Installed";
  WalletReadyState["NotDetected"] = "NotDetected";
  WalletReadyState["Loadable"] = "Loadable";
  WalletReadyState["Unsupported"] = "Unsupported";
})(WalletReadyState || (WalletReadyState = {}));

class BaseWalletAdapter extends eventemitter3_default {
  get connected() {
    return !!this.publicKey;
  }
  async autoConnect() {
    await this.connect();
  }
  async prepareTransaction(transaction, connection, options = {}) {
    const publicKey = this.publicKey;
    if (!publicKey)
      throw new WalletNotConnectedError;
    transaction.feePayer = transaction.feePayer || publicKey;
    transaction.recentBlockhash = transaction.recentBlockhash || (await connection.getLatestBlockhash({
      commitment: options.preflightCommitment,
      minContextSlot: options.minContextSlot
    })).blockhash;
    return transaction;
  }
}
function scopePollingDetectionStrategy(detect) {
  if (typeof window === "undefined" || typeof document === "undefined")
    return;
  const disposers = [];
  function detectAndDispose() {
    const detected = detect();
    if (detected) {
      for (const dispose of disposers) {
        dispose();
      }
    }
  }
  const interval = setInterval(detectAndDispose, 1000);
  disposers.push(() => clearInterval(interval));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", detectAndDispose, { once: true });
    disposers.push(() => document.removeEventListener("DOMContentLoaded", detectAndDispose));
  }
  if (document.readyState !== "complete") {
    window.addEventListener("load", detectAndDispose, { once: true });
    disposers.push(() => window.removeEventListener("load", detectAndDispose));
  }
  detectAndDispose();
}
function isIosAndRedirectable() {
  if (!navigator)
    return false;
  const userAgent = navigator.userAgent.toLowerCase();
  const isIos = userAgent.includes("iphone") || userAgent.includes("ipad");
  const isSafari = userAgent.includes("safari");
  return isIos && isSafari;
}

// ../../node_modules/.bun/@solana+wallet-adapter-base@0.9.28+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-base/lib/esm/transaction.js
function isVersionedTransaction(transaction) {
  return "version" in transaction;
}

// ../../node_modules/.bun/@solana+wallet-adapter-base@0.9.28+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-base/lib/esm/signer.js
class BaseSignerWalletAdapter extends BaseWalletAdapter {
  async sendTransaction(transaction, connection, options = {}) {
    let emit = true;
    try {
      if (isVersionedTransaction(transaction)) {
        if (!this.supportedTransactionVersions)
          throw new WalletSendTransactionError(`Sending versioned transactions isn't supported by this wallet`);
        if (!this.supportedTransactionVersions.has(transaction.version))
          throw new WalletSendTransactionError(`Sending transaction version ${transaction.version} isn't supported by this wallet`);
        try {
          transaction = await this.signTransaction(transaction);
          const rawTransaction = transaction.serialize();
          return await connection.sendRawTransaction(rawTransaction, options);
        } catch (error) {
          if (error instanceof WalletSignTransactionError) {
            emit = false;
            throw error;
          }
          throw new WalletSendTransactionError(error?.message, error);
        }
      } else {
        try {
          const { signers, ...sendOptions } = options;
          transaction = await this.prepareTransaction(transaction, connection, sendOptions);
          signers?.length && transaction.partialSign(...signers);
          transaction = await this.signTransaction(transaction);
          const rawTransaction = transaction.serialize();
          return await connection.sendRawTransaction(rawTransaction, sendOptions);
        } catch (error) {
          if (error instanceof WalletSignTransactionError) {
            emit = false;
            throw error;
          }
          throw new WalletSendTransactionError(error?.message, error);
        }
      }
    } catch (error) {
      if (emit) {
        this.emit("error", error);
      }
      throw error;
    }
  }
  async signAllTransactions(transactions) {
    for (const transaction of transactions) {
      if (isVersionedTransaction(transaction)) {
        if (!this.supportedTransactionVersions)
          throw new WalletSignTransactionError(`Signing versioned transactions isn't supported by this wallet`);
        if (!this.supportedTransactionVersions.has(transaction.version))
          throw new WalletSignTransactionError(`Signing transaction version ${transaction.version} isn't supported by this wallet`);
      }
    }
    const signedTransactions = [];
    for (const transaction of transactions) {
      signedTransactions.push(await this.signTransaction(transaction));
    }
    return signedTransactions;
  }
}

class BaseMessageSignerWalletAdapter extends BaseSignerWalletAdapter {
}

// ../../node_modules/.bun/@wallet-standard+features@1.1.1/node_modules/@wallet-standard/features/lib/esm/connect.js
var StandardConnect = "standard:connect";

// ../../node_modules/.bun/@wallet-standard+features@1.1.1/node_modules/@wallet-standard/features/lib/esm/disconnect.js
var StandardDisconnect = "standard:disconnect";

// ../../node_modules/.bun/@wallet-standard+features@1.1.1/node_modules/@wallet-standard/features/lib/esm/events.js
var StandardEvents = "standard:events";

// ../../node_modules/.bun/@solana+wallet-adapter-phantom@0.9.27+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-phantom/lib/esm/adapter.js
init_index_browser_esm();
var PhantomWalletName = "Phantom";

class PhantomWalletAdapter extends BaseMessageSignerWalletAdapter {
  constructor(config = {}) {
    super();
    this.name = PhantomWalletName;
    this.url = "https://phantom.app";
    this.icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiB2aWV3Qm94PSIwIDAgMTA4IDEwOCIgZmlsbD0ibm9uZSI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPg==";
    this.supportedTransactionVersions = new Set(["legacy", 0]);
    this._readyState = typeof window === "undefined" || typeof document === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.NotDetected;
    this._disconnected = () => {
      const wallet = this._wallet;
      if (wallet) {
        wallet.off("disconnect", this._disconnected);
        wallet.off("accountChanged", this._accountChanged);
        this._wallet = null;
        this._publicKey = null;
        this.emit("error", new WalletDisconnectedError);
        this.emit("disconnect");
      }
    };
    this._accountChanged = (newPublicKey) => {
      const publicKey = this._publicKey;
      if (!publicKey)
        return;
      try {
        newPublicKey = new PublicKey(newPublicKey.toBytes());
      } catch (error) {
        this.emit("error", new WalletPublicKeyError(error?.message, error));
        return;
      }
      if (publicKey.equals(newPublicKey))
        return;
      this._publicKey = newPublicKey;
      this.emit("connect", newPublicKey);
    };
    this._connecting = false;
    this._wallet = null;
    this._publicKey = null;
    if (this._readyState !== WalletReadyState.Unsupported) {
      if (isIosAndRedirectable()) {
        this._readyState = WalletReadyState.Loadable;
        this.emit("readyStateChange", this._readyState);
      } else {
        scopePollingDetectionStrategy(() => {
          if (window.phantom?.solana?.isPhantom || window.solana?.isPhantom) {
            this._readyState = WalletReadyState.Installed;
            this.emit("readyStateChange", this._readyState);
            return true;
          }
          return false;
        });
      }
    }
  }
  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return this._connecting;
  }
  get readyState() {
    return this._readyState;
  }
  async autoConnect() {
    if (this.readyState === WalletReadyState.Installed) {
      await this.connect();
    }
  }
  async connect() {
    try {
      if (this.connected || this.connecting)
        return;
      if (this.readyState === WalletReadyState.Loadable) {
        const url = encodeURIComponent(window.location.href);
        const ref = encodeURIComponent(window.location.origin);
        window.location.href = `https://phantom.app/ul/browse/${url}?ref=${ref}`;
        return;
      }
      if (this.readyState !== WalletReadyState.Installed)
        throw new WalletNotReadyError;
      this._connecting = true;
      const wallet = window.phantom?.solana || window.solana;
      if (!wallet.isConnected) {
        try {
          await wallet.connect();
        } catch (error) {
          throw new WalletConnectionError(error?.message, error);
        }
      }
      if (!wallet.publicKey)
        throw new WalletAccountError;
      let publicKey;
      try {
        publicKey = new PublicKey(wallet.publicKey.toBytes());
      } catch (error) {
        throw new WalletPublicKeyError(error?.message, error);
      }
      wallet.on("disconnect", this._disconnected);
      wallet.on("accountChanged", this._accountChanged);
      this._wallet = wallet;
      this._publicKey = publicKey;
      this.emit("connect", publicKey);
    } catch (error) {
      this.emit("error", error);
      throw error;
    } finally {
      this._connecting = false;
    }
  }
  async disconnect() {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off("disconnect", this._disconnected);
      wallet.off("accountChanged", this._accountChanged);
      this._wallet = null;
      this._publicKey = null;
      try {
        await wallet.disconnect();
      } catch (error) {
        this.emit("error", new WalletDisconnectionError(error?.message, error));
      }
    }
    this.emit("disconnect");
  }
  async sendTransaction(transaction, connection, options = {}) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        const { signers, ...sendOptions } = options;
        if (isVersionedTransaction(transaction)) {
          signers?.length && transaction.sign(signers);
        } else {
          transaction = await this.prepareTransaction(transaction, connection, sendOptions);
          signers?.length && transaction.partialSign(...signers);
        }
        sendOptions.preflightCommitment = sendOptions.preflightCommitment || connection.commitment;
        const { signature } = await wallet.signAndSendTransaction(transaction, sendOptions);
        return signature;
      } catch (error) {
        if (error instanceof WalletError)
          throw error;
        throw new WalletSendTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signTransaction(transaction) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        return await wallet.signTransaction(transaction) || transaction;
      } catch (error) {
        throw new WalletSignTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signAllTransactions(transactions) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        return await wallet.signAllTransactions(transactions) || transactions;
      } catch (error) {
        throw new WalletSignTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signMessage(message) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        const { signature } = await wallet.signMessage(message);
        return signature;
      } catch (error) {
        throw new WalletSignMessageError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
}

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/adapter.js
init_index_browser_esm();

// ../../node_modules/.bun/@wallet-standard+wallet@1.1.1/node_modules/@wallet-standard/wallet/lib/esm/register.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _RegisterWalletEvent_detail;
function registerWallet(wallet) {
  const callback = ({ register }) => register(wallet);
  try {
    window.dispatchEvent(new RegisterWalletEvent(callback));
  } catch (error) {
    console.error(`wallet-standard:register-wallet event could not be dispatched
`, error);
  }
  try {
    window.addEventListener("wallet-standard:app-ready", ({ detail: api }) => callback(api));
  } catch (error) {
    console.error(`wallet-standard:app-ready event listener could not be added
`, error);
  }
}

class RegisterWalletEvent extends Event {
  get detail() {
    return __classPrivateFieldGet(this, _RegisterWalletEvent_detail, "f");
  }
  get type() {
    return "wallet-standard:register-wallet";
  }
  constructor(callback) {
    super("wallet-standard:register-wallet", {
      bubbles: false,
      cancelable: false,
      composed: false
    });
    _RegisterWalletEvent_detail.set(this, undefined);
    __classPrivateFieldSet(this, _RegisterWalletEvent_detail, callback, "f");
  }
  preventDefault() {
    throw new Error("preventDefault cannot be called");
  }
  stopImmediatePropagation() {
    throw new Error("stopImmediatePropagation cannot be called");
  }
  stopPropagation() {
    throw new Error("stopPropagation cannot be called");
  }
}
_RegisterWalletEvent_detail = new WeakMap;

// ../../node_modules/.bun/@solana+wallet-standard-chains@1.1.2/node_modules/@solana/wallet-standard-chains/lib/esm/index.js
var SOLANA_MAINNET_CHAIN = "solana:mainnet";
var SOLANA_DEVNET_CHAIN = "solana:devnet";
var SOLANA_TESTNET_CHAIN = "solana:testnet";

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/metamask/wallet.js
init_esm();

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/metamask/icon.js
var icon = "data:image/svg+xml;base64,PHN2ZyBmaWxsPSJub25lIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMzEgMzEiIHdpZHRoPSIzMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayI+PGxpbmVhckdyYWRpZW50IGlkPSJhIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeDE9IjIwLjI1IiB4Mj0iMjYuNTcxIiB5MT0iMjcuMTczIiB5Mj0iMTkuODU4Ij48c3RvcCBvZmZzZXQ9Ii4wOCIgc3RvcC1jb2xvcj0iIzk5NDVmZiIvPjxzdG9wIG9mZnNldD0iLjMiIHN0b3AtY29sb3I9IiM4NzUyZjMiLz48c3RvcCBvZmZzZXQ9Ii41IiBzdG9wLWNvbG9yPSIjNTQ5N2Q1Ii8+PHN0b3Agb2Zmc2V0PSIuNiIgc3RvcC1jb2xvcj0iIzQzYjRjYSIvPjxzdG9wIG9mZnNldD0iLjcyIiBzdG9wLWNvbG9yPSIjMjhlMGI5Ii8+PHN0b3Agb2Zmc2V0PSIuOTciIHN0b3AtY29sb3I9IiMxOWZiOWIiLz48L2xpbmVhckdyYWRpZW50PjxnIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS13aWR0aD0iLjA5NCI+PHBhdGggZD0ibTI2LjEwOSAzLjY0My05LjM2OSA2Ljk1OSAxLjczMy00LjEwNSA3LjYzNy0yLjg1M3oiIGZpbGw9IiNlMjc2MWIiIHN0cm9rZT0iI2UyNzYxYiIvPjxnIGZpbGw9IiNlNDc2MWIiIHN0cm9rZT0iI2U0NzYxYiI+PHBhdGggZD0ibTQuNDgxIDMuNjQzIDkuMjk0IDcuMDI0LTEuNjQ4LTQuMTcxem0xOC4yNTggMTYuMTMtMi40OTUgMy44MjMgNS4zMzkgMS40NjkgMS41MzUtNS4yMDctNC4zNzgtLjA4NXptLTE5LjI0Ny4wODUgMS41MjUgNS4yMDcgNS4zMzktMS40NjktMi40OTUtMy44MjN6Ii8+PHBhdGggZD0ibTEwLjA1NSAxMy4zMTMtMS40ODggMi4yNTEgNS4zMDEuMjM1LS4xODgtNS42OTd6bTEwLjQ4IDAtMy42NzItMy4yNzctLjEyMiA1Ljc2MyA1LjI5Mi0uMjM1LTEuNDk3LTIuMjUxem0tMTAuMTc4IDEwLjI4MyAzLjE4My0xLjU1NC0yLjc0OS0yLjE0Ny0uNDMzIDMuNzAxem02LjY5NS0xLjU1NCAzLjE5MiAxLjU1NC0uNDQzLTMuNzAxeiIvPjwvZz48cGF0aCBkPSJtMjAuMjQ0IDIzLjU5Ni0zLjE5Mi0xLjU1NC4yNTQgMi4wODEtLjAyOC44NzZ6bS05Ljg4NyAwIDIuOTY2IDEuNDAzLS4wMTktLjg3Ni4yMzUtMi4wODEtMy4xODMgMS41NTR6IiBmaWxsPSIjZDdjMWIzIiBzdHJva2U9IiNkN2MxYjMiLz48cGF0aCBkPSJtMTMuMzY5IDE4LjUyMS0yLjY1NS0uNzgxIDEuODc0LS44NTd6bTMuODUxIDAgLjc4MS0xLjYzOCAxLjg4My44NTctMi42NjUuNzgxeiIgZmlsbD0iIzIzMzQ0NyIgc3Ryb2tlPSIjMjMzNDQ3Ii8+PHBhdGggZD0ibTEwLjM1NyAyMy41OTYuNDUyLTMuODIzLTIuOTQ3LjA4NXptOS40MzUtMy44MjMuNDUyIDMuODIzIDIuNDk1LTMuNzM4em0yLjI0MS00LjIwOS01LjI5Mi4yMzUuNDkgMi43MjEuNzgyLTEuNjM4IDEuODgzLjg1N3ptLTExLjMxOCAyLjE3NSAxLjg4My0uODU3Ljc3MiAxLjYzOC40OTktMi43MjEtNS4zMDEtLjIzNXoiIGZpbGw9IiNjZDYxMTYiIHN0cm9rZT0iI2NkNjExNiIvPjxwYXRoIGQ9Im04LjU2NyAxNS41NjQgMi4yMjIgNC4zMzEtLjA3NS0yLjE1NnptMTEuMzI4IDIuMTc1LS4wOTQgMi4xNTYgMi4yMzItNC4zMzEtMi4xMzcgMi4xNzV6bS02LjAyNi0xLjk0LS40OTkgMi43MjEuNjIxIDMuMjExLjE0MS00LjIyOC0uMjY0LTEuNzA0em0yLjg3MiAwLS4yNTQgMS42OTUuMTEzIDQuMjM3LjYzMS0zLjIxMXoiIGZpbGw9IiNlNDc1MWYiIHN0cm9rZT0iI2U0NzUxZiIvPjxwYXRoIGQ9Im0xNy4yMyAxOC41Mi0uNjMxIDMuMjExLjQ1Mi4zMTEgMi43NS0yLjE0Ny4wOTQtMi4xNTZ6bS02LjUxNi0uNzgxLjA3NSAyLjE1NiAyLjc1IDIuMTQ3LjQ1Mi0uMzExLS42MjItMy4yMTF6IiBmaWxsPSIjZjY4NTFiIiBzdHJva2U9IiNmNjg1MWIiLz48cGF0aCBkPSJtMTcuMjc3IDI0Ljk5OS4wMjgtLjg3Ni0uMjM1LS4yMDdoLTMuNTVsLS4yMTcuMjA3LjAxOS44NzYtMi45NjYtMS40MDMgMS4wMzYuODQ4IDIuMSAxLjQ1OWgzLjYwNmwyLjEwOS0xLjQ1OSAxLjAzNi0uODQ4eiIgZmlsbD0iI2MwYWQ5ZSIgc3Ryb2tlPSIjYzBhZDllIi8+PHBhdGggZD0ibTE3LjA1MSAyMi4wNDItLjQ1Mi0uMzExaC0yLjYwOGwtLjQ1Mi4zMTEtLjIzNSAyLjA4MS4yMTctLjIwN2gzLjU1bC4yMzUuMjA3LS4yNTQtMi4wODF6IiBmaWxsPSIjMTYxNjE2IiBzdHJva2U9IiMxNjE2MTYiLz48cGF0aCBkPSJtMjYuNTA1IDExLjA1My44LTMuODQyLTEuMTk2LTMuNTY5LTkuMDU4IDYuNzIzIDMuNDg0IDIuOTQ3IDQuOTI1IDEuNDQxIDEuMDkyLTEuMjcxLS40NzEtLjMzOS43NTMtLjY4Ny0uNTg0LS40NTIuNzUzLS41NzQtLjQ5OS0uMzc3em0tMjMuMjExLTMuODQxLjggMy44NDItLjUwOC4zNzcuNzUzLjU3NC0uNTc0LjQ1Mi43NTMuNjg3LS40NzEuMzM5IDEuMDgzIDEuMjcxIDQuOTI1LTEuNDQxIDMuNDg0LTIuOTQ3LTkuMDU5LTYuNzIzeiIgZmlsbD0iIzc2M2QxNiIgc3Ryb2tlPSIjNzYzZDE2Ii8+PHBhdGggZD0ibTI1LjQ2IDE0Ljc1NC00LjkyNS0xLjQ0MSAxLjQ5NyAyLjI1MS0yLjIzMiA0LjMzMSAyLjkzOC0uMDM4aDQuMzc4bC0xLjY1Ny01LjEwNHptLTE1LjQwNS0xLjQ0MS00LjkyNSAxLjQ0MS0xLjYzOCA1LjEwNGg0LjM2OWwyLjkyOC4wMzgtMi4yMjItNC4zMzEgMS40ODgtMi4yNTF6bTYuNjg1IDIuNDg2LjMxMS01LjQzMyAxLjQzMS0zLjg3aC02LjM1NmwxLjQxMyAzLjg3LjMyOSA1LjQzMy4xMTMgMS43MTQuMDA5IDQuMjE5aDIuNjFsLjAxOS00LjIxOS4xMjItMS43MTR6IiBmaWxsPSIjZjY4NTFiIiBzdHJva2U9IiNmNjg1MWIiLz48L2c+PGNpcmNsZSBjeD0iMjMuNSIgY3k9IjIzLjUiIGZpbGw9IiMwMDAiIHI9IjYuNSIvPjxwYXRoIGQ9Im0yNy40NzMgMjUuNTQ1LTEuMzEgMS4zNjhjLS4wMjkuMDMtLjA2My4wNTMtLjEwMS4wN2EuMzEuMzEgMCAwIDEgLS4xMjEuMDI0aC02LjIwOWMtLjAzIDAtLjA1OS0uMDA4LS4wODMtLjAyNGEuMTUuMTUgMCAwIDEgLS4wNTYtLjA2NWMtLjAxMi0uMDI2LS4wMTUtLjA1Ni0uMDEtLjA4NHMuMDE4LS4wNTUuMDM5LS4wNzZsMS4zMTEtMS4zNjhjLjAyOC0uMDMuMDYzLS4wNTMuMTAxLS4wNjlhLjMxLjMxIDAgMCAxIC4xMjEtLjAyNWg2LjIwOGMuMDMgMCAuMDU5LjAwOC4wODMuMDI0YS4xNS4xNSAwIDAgMSAuMDU2LjA2NWMuMDEyLjAyNi4wMTUuMDU2LjAxLjA4NHMtLjAxOC4wNTUtLjAzOS4wNzZ6bS0xLjMxLTIuNzU2Yy0uMDI5LS4wMy0uMDYzLS4wNTMtLjEwMS0uMDdhLjMxLjMxIDAgMCAwIC0uMTIxLS4wMjRoLTYuMjA5Yy0uMDMgMC0uMDU5LjAwOC0uMDgzLjAyNHMtLjA0NC4wMzgtLjA1Ni4wNjUtLjAxNS4wNTYtLjAxLjA4NC4wMTguMDU1LjAzOS4wNzZsMS4zMTEgMS4zNjhjLjAyOC4wMy4wNjMuMDUzLjEwMS4wNjlhLjMxLjMxIDAgMCAwIC4xMjEuMDI1aDYuMjA4Yy4wMyAwIC4wNTktLjAwOC4wODMtLjAyNGEuMTUuMTUgMCAwIDAgLjA1Ni0uMDY1Yy4wMTItLjAyNi4wMTUtLjA1Ni4wMS0uMDg0cy0uMDE4LS4wNTUtLjAzOS0uMDc2em0tNi40MzEtLjk4M2g2LjIwOWEuMzEuMzEgMCAwIDAgLjEyMS0uMDI0Yy4wMzgtLjAxNi4wNzMtLjA0LjEwMS0uMDdsMS4zMS0xLjM2OGMuMDItLjAyMS4wMzQtLjA0Ny4wMzktLjA3NnMuMDAxLS4wNTgtLjAxLS4wODRhLjE1LjE1IDAgMCAwIC0uMDU2LS4wNjVjLS4wMjUtLjAxNi0uMDU0LS4wMjQtLjA4My0uMDI0aC02LjIwOGEuMzEuMzEgMCAwIDAgLS4xMjEuMDI1Yy0uMDM4LjAxNi0uMDcyLjA0LS4xMDEuMDY5bC0xLjMxIDEuMzY4Yy0uMDIuMDIxLS4wMzQuMDQ3LS4wMzkuMDc2cy0uMDAxLjA1OC4wMS4wODQuMDMxLjA0OS4wNTYuMDY1LjA1NC4wMjQuMDgzLjAyNHoiIGZpbGw9InVybCgjYSkiLz48L3N2Zz4=";

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/metamask/wallet.js
var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _SolflareMetaMaskWallet_instances;
var _SolflareMetaMaskWallet_listeners;
var _SolflareMetaMaskWallet_version;
var _SolflareMetaMaskWallet_name;
var _SolflareMetaMaskWallet_icon;
var _SolflareMetaMaskWallet_solflareMetaMask;
var _SolflareMetaMaskWallet_on;
var _SolflareMetaMaskWallet_emit;
var _SolflareMetaMaskWallet_off;
var _SolflareMetaMaskWallet_connect;
var _SolflareMetaMaskWallet_disconnect;
var _SolflareMetaMaskWallet_signAndSendTransaction;
var _SolflareMetaMaskWallet_signTransaction;
var _SolflareMetaMaskWallet_signMessage;

class SolflareMetaMaskWallet {
  constructor() {
    _SolflareMetaMaskWallet_instances.add(this);
    _SolflareMetaMaskWallet_listeners.set(this, {});
    _SolflareMetaMaskWallet_version.set(this, "1.0.0");
    _SolflareMetaMaskWallet_name.set(this, "MetaMask");
    _SolflareMetaMaskWallet_icon.set(this, icon);
    _SolflareMetaMaskWallet_solflareMetaMask.set(this, null);
    _SolflareMetaMaskWallet_on.set(this, (event, listener) => {
      __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_listeners, "f")[event]?.push(listener) || (__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_listeners, "f")[event] = [listener]);
      return () => __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_instances, "m", _SolflareMetaMaskWallet_off).call(this, event, listener);
    });
    _SolflareMetaMaskWallet_connect.set(this, async () => {
      if (!__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f")) {
        let SolflareMetaMaskClass;
        try {
          SolflareMetaMaskClass = (await Promise.resolve().then(() => (init_esm2(), exports_esm))).default;
        } catch (error) {
          throw new Error("Unable to load Solflare MetaMask SDK");
        }
        __classPrivateFieldSet3(this, _SolflareMetaMaskWallet_solflareMetaMask, new SolflareMetaMaskClass, "f");
        __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").on("standard_change", (properties) => __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_instances, "m", _SolflareMetaMaskWallet_emit).call(this, "change", properties));
      }
      if (!this.accounts.length) {
        await __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").connect();
      }
      return { accounts: this.accounts };
    });
    _SolflareMetaMaskWallet_disconnect.set(this, async () => {
      if (!__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f"))
        return;
      await __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").disconnect();
    });
    _SolflareMetaMaskWallet_signAndSendTransaction.set(this, async (...inputs) => {
      if (!__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f"))
        throw new WalletNotConnectedError;
      return await __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").standardSignAndSendTransaction(...inputs);
    });
    _SolflareMetaMaskWallet_signTransaction.set(this, async (...inputs) => {
      if (!__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f"))
        throw new WalletNotConnectedError;
      return await __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").standardSignTransaction(...inputs);
    });
    _SolflareMetaMaskWallet_signMessage.set(this, async (...inputs) => {
      if (!__classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f"))
        throw new WalletNotConnectedError;
      return await __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").standardSignMessage(...inputs);
    });
  }
  get version() {
    return __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_version, "f");
  }
  get name() {
    return __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_name, "f");
  }
  get icon() {
    return __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_icon, "f");
  }
  get chains() {
    return [SOLANA_MAINNET_CHAIN, SOLANA_DEVNET_CHAIN, SOLANA_TESTNET_CHAIN];
  }
  get features() {
    return {
      [StandardConnect]: {
        version: "1.0.0",
        connect: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_connect, "f")
      },
      [StandardDisconnect]: {
        version: "1.0.0",
        disconnect: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_disconnect, "f")
      },
      [StandardEvents]: {
        version: "1.0.0",
        on: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_on, "f")
      },
      [SolanaSignAndSendTransaction]: {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_signAndSendTransaction, "f")
      },
      [SolanaSignTransaction]: {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_signTransaction, "f")
      },
      [SolanaSignMessage]: {
        version: "1.0.0",
        signMessage: __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_signMessage, "f")
      }
    };
  }
  get accounts() {
    return __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f") ? __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_solflareMetaMask, "f").standardAccounts : [];
  }
}
_SolflareMetaMaskWallet_listeners = new WeakMap, _SolflareMetaMaskWallet_version = new WeakMap, _SolflareMetaMaskWallet_name = new WeakMap, _SolflareMetaMaskWallet_icon = new WeakMap, _SolflareMetaMaskWallet_solflareMetaMask = new WeakMap, _SolflareMetaMaskWallet_on = new WeakMap, _SolflareMetaMaskWallet_connect = new WeakMap, _SolflareMetaMaskWallet_disconnect = new WeakMap, _SolflareMetaMaskWallet_signAndSendTransaction = new WeakMap, _SolflareMetaMaskWallet_signTransaction = new WeakMap, _SolflareMetaMaskWallet_signMessage = new WeakMap, _SolflareMetaMaskWallet_instances = new WeakSet, _SolflareMetaMaskWallet_emit = function _SolflareMetaMaskWallet_emit(event, ...args) {
  __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_listeners, "f")[event]?.forEach((listener) => listener.apply(null, args));
}, _SolflareMetaMaskWallet_off = function _SolflareMetaMaskWallet_off(event, listener) {
  __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_listeners, "f")[event] = __classPrivateFieldGet3(this, _SolflareMetaMaskWallet_listeners, "f")[event]?.filter((existingListener) => listener !== existingListener);
};

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/metamask/detect.js
var registered = false;
function register() {
  if (registered)
    return;
  registerWallet(new SolflareMetaMaskWallet);
  registered = true;
}
async function detectAndRegisterSolflareMetaMaskWallet() {
  const id = "solflare-detect-metamask";
  function postMessage() {
    window.postMessage({
      target: "metamask-contentscript",
      data: {
        name: "metamask-provider",
        data: {
          id,
          jsonrpc: "2.0",
          method: "wallet_getSnaps"
        }
      }
    }, window.location.origin);
  }
  function onMessage(event) {
    const message = event.data;
    if (message?.target === "metamask-inpage" && message.data?.name === "metamask-provider") {
      if (message.data.data?.id === id) {
        window.removeEventListener("message", onMessage);
        if (!message.data.data.error) {
          register();
        }
      } else {
        postMessage();
      }
    }
  }
  window.addEventListener("message", onMessage);
  window.setTimeout(() => window.removeEventListener("message", onMessage), 5000);
  postMessage();
}

// ../../node_modules/.bun/@solana+wallet-adapter-solflare@0.6.32+ced9e9d346ce9123/node_modules/@solana/wallet-adapter-solflare/lib/esm/adapter.js
var SolflareWalletName = "Solflare";

class SolflareWalletAdapter extends BaseMessageSignerWalletAdapter {
  constructor(config = {}) {
    super();
    this.name = SolflareWalletName;
    this.url = "https://solflare.com";
    this.icon = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJTIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MCA1MCI+PGRlZnM+PHN0eWxlPi5jbHMtMXtmaWxsOiMwMjA1MGE7c3Ryb2tlOiNmZmVmNDY7c3Ryb2tlLW1pdGVybGltaXQ6MTA7c3Ryb2tlLXdpZHRoOi41cHg7fS5jbHMtMntmaWxsOiNmZmVmNDY7fTwvc3R5bGU+PC9kZWZzPjxyZWN0IGNsYXNzPSJjbHMtMiIgeD0iMCIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTIiIHJ5PSIxMiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTI0LjIzLDI2LjQybDIuNDYtMi4zOCw0LjU5LDEuNWMzLjAxLDEsNC41MSwyLjg0LDQuNTEsNS40MywwLDEuOTYtLjc1LDMuMjYtMi4yNSw0LjkzbC0uNDYuNS4xNy0xLjE3Yy42Ny00LjI2LS41OC02LjA5LTQuNzItNy40M2wtNC4zLTEuMzhoMFpNMTguMDUsMTEuODVsMTIuNTIsNC4xNy0yLjcxLDIuNTktNi41MS0yLjE3Yy0yLjI1LS43NS0zLjAxLTEuOTYtMy4zLTQuNTF2LS4wOGgwWk0xNy4zLDMzLjA2bDIuODQtMi43MSw1LjM0LDEuNzVjMi44LjkyLDMuNzYsMi4xMywzLjQ2LDUuMThsLTExLjY1LTQuMjJoMFpNMTMuNzEsMjAuOTVjMC0uNzkuNDItMS41NCwxLjEzLTIuMTcuNzUsMS4wOSwyLjA1LDIuMDUsNC4wOSwyLjcxbDQuNDIsMS40Ni0yLjQ2LDIuMzgtNC4zNC0xLjQyYy0yLS42Ny0yLjg0LTEuNjctMi44NC0yLjk2TTI2LjgyLDQyLjg3YzkuMTgtNi4wOSwxNC4xMS0xMC4yMywxNC4xMS0xNS4zMiwwLTMuMzgtMi01LjI2LTYuNDMtNi43MmwtMy4zNC0xLjEzLDkuMTQtOC43Ny0xLjg0LTEuOTYtMi43MSwyLjM4LTEyLjgxLTQuMjJjLTMuOTcsMS4yOS04Ljk3LDUuMDktOC45Nyw4Ljg5LDAsLjQyLjA0LjgzLjE3LDEuMjktMy4zLDEuODgtNC42MywzLjYzLTQuNjMsNS44LDAsMi4wNSwxLjA5LDQuMDksNC41NSw1LjIybDIuNzUuOTItOS41Miw5LjE0LDEuODQsMS45NiwyLjk2LTIuNzEsMTQuNzMsNS4yMmgwWiIvPjwvc3ZnPg==";
    this.supportedTransactionVersions = new Set(["legacy", 0]);
    this._readyState = typeof window === "undefined" || typeof document === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;
    this._disconnected = () => {
      const wallet = this._wallet;
      if (wallet) {
        wallet.off("disconnect", this._disconnected);
        this._wallet = null;
        this._publicKey = null;
        this.emit("error", new WalletDisconnectedError);
        this.emit("disconnect");
      }
    };
    this._accountChanged = (newPublicKey) => {
      if (!newPublicKey)
        return;
      const publicKey = this._publicKey;
      if (!publicKey)
        return;
      try {
        newPublicKey = new PublicKey(newPublicKey.toBytes());
      } catch (error) {
        this.emit("error", new WalletPublicKeyError(error?.message, error));
        return;
      }
      if (publicKey.equals(newPublicKey))
        return;
      this._publicKey = newPublicKey;
      this.emit("connect", newPublicKey);
    };
    this._connecting = false;
    this._publicKey = null;
    this._wallet = null;
    this._config = config;
    if (this._readyState !== WalletReadyState.Unsupported) {
      scopePollingDetectionStrategy(() => {
        if (window.solflare?.isSolflare || window.SolflareApp) {
          this._readyState = WalletReadyState.Installed;
          this.emit("readyStateChange", this._readyState);
          return true;
        }
        return false;
      });
      detectAndRegisterSolflareMetaMaskWallet();
    }
  }
  get publicKey() {
    return this._publicKey;
  }
  get connecting() {
    return this._connecting;
  }
  get connected() {
    return !!this._wallet?.connected;
  }
  get readyState() {
    return this._readyState;
  }
  async autoConnect() {
    if (!(this.readyState === WalletReadyState.Loadable && isIosAndRedirectable())) {
      await this.connect();
    }
  }
  async connect() {
    try {
      if (this.connected || this.connecting)
        return;
      if (this._readyState !== WalletReadyState.Loadable && this._readyState !== WalletReadyState.Installed)
        throw new WalletNotReadyError;
      if (this.readyState === WalletReadyState.Loadable && isIosAndRedirectable()) {
        const url = encodeURIComponent(window.location.href);
        const ref = encodeURIComponent(window.location.origin);
        window.location.href = `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`;
        return;
      }
      let SolflareClass;
      try {
        SolflareClass = (await Promise.resolve().then(() => (init_esm3(), exports_esm2))).default;
      } catch (error) {
        throw new WalletLoadError(error?.message, error);
      }
      let wallet;
      try {
        wallet = new SolflareClass({ network: this._config.network });
      } catch (error) {
        throw new WalletConfigError(error?.message, error);
      }
      this._connecting = true;
      if (!wallet.connected) {
        try {
          await wallet.connect();
        } catch (error) {
          throw new WalletConnectionError(error?.message, error);
        }
      }
      if (!wallet.publicKey)
        throw new WalletConnectionError;
      let publicKey;
      try {
        publicKey = new PublicKey(wallet.publicKey.toBytes());
      } catch (error) {
        throw new WalletPublicKeyError(error?.message, error);
      }
      wallet.on("disconnect", this._disconnected);
      wallet.on("accountChanged", this._accountChanged);
      this._wallet = wallet;
      this._publicKey = publicKey;
      this.emit("connect", publicKey);
    } catch (error) {
      this.emit("error", error);
      throw error;
    } finally {
      this._connecting = false;
    }
  }
  async disconnect() {
    const wallet = this._wallet;
    if (wallet) {
      wallet.off("disconnect", this._disconnected);
      wallet.off("accountChanged", this._accountChanged);
      this._wallet = null;
      this._publicKey = null;
      try {
        await wallet.disconnect();
      } catch (error) {
        this.emit("error", new WalletDisconnectionError(error?.message, error));
      }
    }
    this.emit("disconnect");
  }
  async sendTransaction(transaction, connection, options = {}) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        const { signers, ...sendOptions } = options;
        if (isVersionedTransaction(transaction)) {
          signers?.length && transaction.sign(signers);
        } else {
          transaction = await this.prepareTransaction(transaction, connection, sendOptions);
          signers?.length && transaction.partialSign(...signers);
        }
        sendOptions.preflightCommitment = sendOptions.preflightCommitment || connection.commitment;
        return await wallet.signAndSendTransaction(transaction, sendOptions);
      } catch (error) {
        if (error instanceof WalletError)
          throw error;
        throw new WalletSendTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signTransaction(transaction) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        return await wallet.signTransaction(transaction) || transaction;
      } catch (error) {
        throw new WalletSignTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signAllTransactions(transactions) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        return await wallet.signAllTransactions(transactions) || transactions;
      } catch (error) {
        throw new WalletSignTransactionError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
  async signMessage(message) {
    try {
      const wallet = this._wallet;
      if (!wallet)
        throw new WalletNotConnectedError;
      try {
        return await wallet.signMessage(message, "utf8");
      } catch (error) {
        throw new WalletSignMessageError(error?.message, error);
      }
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }
}

// src/wallet-client.ts
var adapters = {
  phantom: new PhantomWalletAdapter,
  solflare: new SolflareWalletAdapter
};
function shortAddress(address) {
  const text = address.trim();
  if (text.length <= 4)
    return `…${text}`;
  return `…${text.slice(-4)}`;
}
async function connectReadOnly(choice) {
  const adapter = adapters[choice];
  await adapter.connect();
  const address = adapter.publicKey?.toBase58() ?? "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error("The wallet did not share a public key.");
  }
  return { address, short: shortAddress(address) };
}
async function disconnectReadOnly(choice) {
  await adapters[choice].disconnect();
}
async function proveReadOnly(choice) {
  const adapter = adapters[choice];
  const address = adapter.publicKey?.toBase58() ?? "";
  if (!address)
    throw new Error("Connect a wallet first.");
  const message = new TextEncoder().encode(`Valhalla read-only link
${address}`);
  const signature = await adapter.signMessage(message);
  return { address, proof: btoa(String.fromCharCode(...signature)) };
}

// src/wallet-entry.ts
var api = {
  shortAddress,
  async connect(choice) {
    return connectReadOnly(choice);
  },
  async disconnect(choice) {
    await disconnectReadOnly(choice);
  },
  async prove(choice) {
    return proveReadOnly(choice);
  }
};
window.ValhallaWallet = api;
