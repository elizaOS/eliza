/**
 * Browser-bundle entry point for `es-toolkit/compat/last`, aliased from that
 * subpath import by the app's Vite config. Re-exports `last` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `last` returns the final element of an
 * array-like value, or `undefined` when it is empty/nullish.
 */
export { last, last as default } from "./es-toolkit-compat";
