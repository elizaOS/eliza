const noop = () => undefined;
const asyncNoop = async () => undefined;
const falseNoop = () => false;

export const pipeline = asyncNoop;
export const finished = asyncNoop;
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;

export const isAnyArrayBuffer = falseNoop;
export const isArrayBufferView = falseNoop;
export const isAsyncFunction = falseNoop;
export const isDate = falseNoop;
export const isMap = falseNoop;
export const isNativeError = falseNoop;
export const isPromise = falseNoop;
export const isRegExp = falseNoop;
export const isSet = falseNoop;
export const isTypedArray = falseNoop;

export default new Proxy(noop, {
  get: () => noop,
  apply: () => undefined,
});
