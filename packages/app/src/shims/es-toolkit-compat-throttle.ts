/**
 * Browser-bundle entry point for `es-toolkit/compat/throttle`, aliased from
 * that subpath import by the app's Vite config. Re-exports `throttle` (named +
 * default) from the local lodash-compatible reimplementation so the real
 * es-toolkit package never enters the bundle. `throttle` rate-limits a function
 * to at most one invocation per wait window, exposing `cancel` and `flush`.
 */
export { throttle, throttle as default } from "./es-toolkit-compat";
