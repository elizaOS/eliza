/**
 * Browser-bundle entry point for `es-toolkit/compat/sortBy`, aliased from that
 * subpath import by the app's Vite config. Re-exports `sortBy` (named +
 * default) from the local lodash-compatible reimplementation so the real
 * es-toolkit package never enters the bundle. `sortBy` returns a stable
 * ascending sort of a collection keyed by one or more iteratees.
 */
export { sortBy, sortBy as default } from "./es-toolkit-compat";
