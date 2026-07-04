/**
 * Browser-bundle entry point for `es-toolkit/compat/omit`, aliased from that
 * subpath import by the app's Vite config. Re-exports `omit` (named + default)
 * from the local lodash-compatible reimplementation so the real es-toolkit
 * package never enters the bundle. `omit` returns a shallow copy of an object
 * with the listed top-level keys removed.
 */
export { omit, omit as default } from "./es-toolkit-compat";
