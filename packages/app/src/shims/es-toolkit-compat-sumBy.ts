/**
 * Browser-bundle entry point for `es-toolkit/compat/sumBy`, aliased from that
 * subpath import by the app's Vite config. Re-exports `sumBy` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `sumBy` totals the numeric iteratee value of
 * each collection element (NaN values counted as zero).
 */
export { sumBy, sumBy as default } from "./es-toolkit-compat";
