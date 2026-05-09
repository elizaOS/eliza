/**
 * Health-bridge domain entry point.
 *
 * `health-bridge.ts` shells out to a HealthKit native helper on darwin and
 * to the Google Fit REST API as a cross-platform fallback. `health-connectors.ts`
 * implements the Strava / Fitbit / Withings / Oura OAuth-bridged readers.
 * `health-oauth.ts` owns the per-provider OAuth dance and pendingsession state.
 * `service-normalize-health.ts` normalises inbound health-signal payloads.
 *
 * All four were moved verbatim from `eliza/plugins/app-lifeops/src/lifeops/`
 * in Wave-1 (W1-B). The dependency on app-lifeops' SQL repository was
 * inverted: plugin-health owns the `createLifeOpsHealth*` factories, and
 * app-lifeops re-exports them from its repository module for backward
 * compatibility.
 */

export * from "./health-bridge.js";
export * from "./health-connectors.js";
export * from "./health-oauth.js";
export * from "./health-records.js";
export * from "./service-normalize-health.js";
