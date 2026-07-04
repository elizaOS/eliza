/**
 * Browser-bundle entry point for `es-toolkit/compat/uniqBy`, aliased from that
 * subpath import by the app's Vite config. Re-exports `uniqBy` (named +
 * default) from the local lodash-compatible reimplementation so the real
 * es-toolkit package never enters the bundle. `uniqBy` dedupes a collection by
 * iteratee key, keeping the first occurrence of each key.
 */
export { uniqBy, uniqBy as default } from "./es-toolkit-compat";
