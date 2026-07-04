/**
 * Browser-bundle entry point for `es-toolkit/compat/maxBy`, aliased from that
 * subpath import by the app's Vite config. Re-exports `maxBy` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `maxBy` returns the collection element whose
 * numeric iteratee value is greatest (NaN values skipped).
 */
export { maxBy, maxBy as default } from "./es-toolkit-compat";
