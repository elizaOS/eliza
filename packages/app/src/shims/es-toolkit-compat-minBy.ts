/**
 * Browser-bundle entry point for `es-toolkit/compat/minBy`, aliased from that
 * subpath import by the app's Vite config. Re-exports `minBy` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `minBy` returns the collection element whose
 * numeric iteratee value is smallest (NaN values skipped).
 */
export { minBy, minBy as default } from "./es-toolkit-compat";
