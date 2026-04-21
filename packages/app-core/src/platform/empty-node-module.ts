/**
 * Empty stub for Node built-in subpaths that don't exist in browser polyfills.
 * Server-only code imports these but they're never executed in the browser.
 *
 * Each named export is a no-op so esbuild's dep scanner doesn't choke.
 */

// util/types
export const isArrayBuffer = () => false;
export const isTypedArray = () => false;

// stream/promises
export const pipeline = () => {};
export const finished = () => {};

// stream/web — re-export the global Web Streams if available
export const ReadableStream =
  typeof globalThis !== "undefined" ? globalThis.ReadableStream : class {};
export const WritableStream =
  typeof globalThis !== "undefined" ? globalThis.WritableStream : class {};
export const TransformStream =
  typeof globalThis !== "undefined" ? globalThis.TransformStream : class {};

export default {};
