/**
 * Re-exports `isPlainObject` from the es-toolkit compat shim as both the named
 * and default export, matching the import shapes callers use for the
 * lodash-style `isPlainObject`.
 */
export { isPlainObject, isPlainObject as default } from "./es-toolkit-compat";
