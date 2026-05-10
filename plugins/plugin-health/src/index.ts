/**
 * @elizaos/plugin-health — Wave-1 (W1-B) extraction.
 *
 * Owns the sleep / circadian / health-metric / screen-time domain previously
 * intermingled with `app-lifeops`. LifeOps consumes plugin-health through:
 *
 *   - `ConnectorRegistry` contributions (apple_health, google_fit, strava,
 *     fitbit, withings, oura)
 *   - `ActivitySignalBus` publications (`health.sleep.detected`,
 *     `health.wake.observed`, `health.wake.confirmed`,
 *     `health.bedtime.imminent`, `health.regularity.changed`,
 *     `health.workout.completed`, …)
 *   - `AnchorRegistry` contributions (`wake.observed`, `wake.confirmed`,
 *     `bedtime.target`, `nap.start`)
 *   - Default-pack `ScheduledTask` records (bedtime / wake-up / sleep-recap)
 *
 * See `eliza/plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md` §3.2 and
 * `wave1-interfaces.md` §5 for the canonical scope.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  HEALTH_ANCHORS,
  HEALTH_BUS_FAMILIES,
  HEALTH_CONNECTOR_KINDS,
  registerHealthAnchors,
  registerHealthBusFamilies,
  registerHealthConnectors,
} from "./connectors/index.js";
import { registerCircadianInsightContract } from "./contracts/circadian.js";
import { createDefaultCircadianInsightContract } from "./contracts/circadian-default.js";
import {
  HEALTH_DEFAULT_PACKS,
  registerHealthDefaultPacks,
} from "./default-packs/index.js";

// Public surface — consumers (app-lifeops + future plugins) import the
// helpers they need by name from `@elizaos/plugin-health`.

export * from "./actions/index.js";
export * from "./anchors/index.js";
export * from "./connectors/index.js";
export * from "./contracts/circadian.js";
export * from "./contracts/circadian-default.js";
export * from "./contracts/health.js";
export * from "./default-packs/index.js";
export * from "./health-bridge/index.js";
export * from "./screen-time/index.js";
export * from "./sleep/index.js";
export * from "./util/index.js";

export const HEALTH_PLUGIN_NAME = "plugin-health";

/**
 * elizaOS plugin entry. Registers connector / anchor / bus-family / default-pack
 * contributions when the W1-A and W1-F runtime registries are available; logs
 * a one-line skip reason when they are not (Wave-1 soft dependency posture
 * per `IMPLEMENTATION_PLAN.md` §3.2).
 */
export const healthPlugin: Plugin = {
  name: HEALTH_PLUGIN_NAME,
  description:
    "Health, sleep, circadian and screen-time domain plugin — extracted from app-lifeops in Wave-1 (W1-B).",
  services: [],
  actions: [],
  providers: [],
  tests: [],
  init: async (
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> => {
    logger.info(
      {
        src: "plugin:health",
        connectors: HEALTH_CONNECTOR_KINDS,
        anchors: HEALTH_ANCHORS,
        busFamilies: HEALTH_BUS_FAMILIES,
        defaultPacks: HEALTH_DEFAULT_PACKS.map((p) => p.key),
      },
      "Initializing plugin-health (Wave-1 W1-B)",
    );
    registerHealthConnectors(runtime);
    registerHealthAnchors(runtime);
    registerHealthBusFamilies(runtime);
    registerHealthDefaultPacks(runtime);
    // W3-C drift D-4: register the CircadianInsightContract so consumers
    // (SCHEDULE, SCHEDULED_TASK, future planner reads) read through a
    // typed runtime seam instead of reaching into plugin-health internals.
    registerCircadianInsightContract(
      runtime,
      createDefaultCircadianInsightContract(),
    );
  },
};

export default healthPlugin;
// `./<name>.js` (without /index) is a TypeScript-only directory-shorthand
// that Bun's runtime ESM resolver does not honor. The `./sleep`,
// `./health-bridge`, `./screen-time`, and `./actions` are all directories
// that already have proper `./<name>/index.js` re-exports above (lines
// 39, 44-46) so these duplicate flat-file forms only break runtime
// imports without adding anything.
