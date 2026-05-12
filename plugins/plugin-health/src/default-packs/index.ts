/**
 * Default-pack registration for plugin-health.
 *
 * Per `wave1-interfaces.md` §5.4: plugin-health ships `bedtime`, `wake-up`,
 * and `sleep-recap` packs. The pack records consume the W1-A `ScheduledTask`
 * schema. Until W1-D's `DefaultPackRegistry` is wired into `IAgentRuntime`,
 * `registerHealthDefaultPacks` logs a one-line skip and continues.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { bedtimeDefaultPack } from "./bedtime.js";
import type { DefaultPack, DefaultPackRegistry } from "./contract-stubs.js";
import { sleepRecapDefaultPack } from "./sleep-recap.js";
import { wakeUpDefaultPack } from "./wake-up.js";

export * from "./contract-stubs.js";
export { bedtimeDefaultPack, sleepRecapDefaultPack, wakeUpDefaultPack };

export const HEALTH_DEFAULT_PACKS: readonly DefaultPack[] = [
  bedtimeDefaultPack,
  wakeUpDefaultPack,
  sleepRecapDefaultPack,
];

interface RuntimeWithDefaultPackRegistry {
  defaultPackRegistry?: DefaultPackRegistry;
}

export function registerHealthDefaultPacks(runtime: IAgentRuntime): void {
  const registry = (runtime as IAgentRuntime & RuntimeWithDefaultPackRegistry)
    .defaultPackRegistry;
  if (!registry) {
    logger.info(
      { src: "plugin:health", waiting_on: "W1-D defaultPackRegistry" },
      "Skipping plugin-health default-pack registration (registry not yet available)",
    );
    return;
  }
  for (const pack of HEALTH_DEFAULT_PACKS) {
    registry.register(pack);
  }
  logger.info(
    {
      src: "plugin:health",
      registered: HEALTH_DEFAULT_PACKS.length,
      keys: HEALTH_DEFAULT_PACKS.map((p) => p.key),
    },
    "Registered plugin-health default packs",
  );
}
