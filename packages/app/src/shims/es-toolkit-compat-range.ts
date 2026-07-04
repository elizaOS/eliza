/**
 * Browser-bundle entry point for `es-toolkit/compat/range`, aliased from that
 * subpath import by the app's Vite config. Re-exports `range` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `range` builds an array of numbers across a
 * start/end/step interval, inferring direction when step is omitted.
 */
export { range, range as default } from "./es-toolkit-compat";
