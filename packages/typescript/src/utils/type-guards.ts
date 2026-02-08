/**
 * Type guard utilities for runtime type checking
 * These functions help TypeScript narrow types safely
 */

/**
 * Set of built-in object constructors that should not be considered plain objects
 */
const NON_PLAIN_CONSTRUCTORS = new Set([
  Array,
  Date,
  RegExp,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Error,
  Promise,
  ArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
]);

/**
 * Check if a value is a plain object (not a special object type)
 * Type guard that narrows the type to Record<string, unknown>
 *
 * A plain object is one created via {} or new Object(), not a built-in
 * or custom class instance.
 *
 * @param value - The value to check
 * @returns True if the value is a plain object
 *
 * @example
 * ```typescript
 * const data: unknown = { name: 'test' };
 * if (isPlainObject(data)) {
 *   // TypeScript knows data is Record<string, unknown>
 *   console.log(data.name);
 * }
 * ```
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  // Check constructor - plain objects have Object or null prototype
  const proto = Object.getPrototypeOf(value);
  if (proto === null) {
    return true; // Object.create(null)
  }

  if (proto.constructor === Object) {
    return true;
  }

  // Explicitly exclude known built-in types
  if (NON_PLAIN_CONSTRUCTORS.has(proto.constructor)) {
    return false;
  }

  // Check for Buffer (Node.js specific)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return false;
  }

  // If it's a custom class instance, it's not a plain object
  return false;
}
