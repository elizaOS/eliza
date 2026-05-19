/**
 * Pure-helper barrel for plugin-health.
 *
 * `time.ts` and `time-util.ts` are local copies of the same-named helpers
 * in `app-lifeops/src/lifeops/`. They are duplicated (not imported) so
 * plugin-health does not take a build-time dependency on app-lifeops.
 */

export * from "./time.js";
export * from "./time-util.js";
