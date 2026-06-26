import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { buildSchedulingRoutes } from "./routes/plugin-routes.js";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "./scheduled-task/runner-service.js";
import { seedRegisteredTaskPacks } from "./scheduled-task/seed-registry.js";

/**
 * `@elizaos/plugin-scheduling` — the scheduling spine, now an always-loaded,
 * self-seeding runtime primitive.
 *
 * This plugin HOSTS the generic ScheduledTask runtime surface so scheduled
 * tasks run + serve their REST API + seed on ANY platform (including mobile)
 * from this plugin alone:
 *
 *  - the runner host `ScheduledTaskRunnerService` (built from the
 *    runtime-injected deps provider, or the built-in default deps),
 *  - the generic REST route at `/api/lifeops/scheduled-tasks`,
 *  - a boot seeder that materializes the generic default-task pack registry.
 *
 * Consumers (e.g. `@elizaos/plugin-personal-assistant`) inject production deps
 * via `registerScheduledTaskRunnerDeps` and register their domain packs via
 * `registerDefaultTaskPack`; when present, their deps win (first-wins). This
 * plugin ships ZERO packs and imports neither `@elizaos/app-core`,
 * `@elizaos/agent`, nor `@elizaos/plugin-personal-assistant`.
 *
 * One runner/store invariant: a single runner service + a single injected deps
 * set + a single REST route per runtime (runtime first-wins dedup).
 */
export const schedulingPlugin: Plugin = {
  name: "@elizaos/plugin-scheduling",
  description:
    "Scheduling spine: the always-loaded ScheduledTask runtime primitive — runner host, REST surface, and default-pack seed registry. Persistence and owner/channel deps are injected by a host plugin; built-in defaults run when no host is present.",
  services: [ScheduledTaskRunnerService],
  routes: buildSchedulingRoutes(),
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Seed registered default-task packs once init has finished so the runner
    // service (and any consumer's injected deps + packs) are registered before
    // the seed runs. Failures are non-fatal to plugin load.
    void runtime.initPromise
      .then(async () => {
        try {
          const runner = getScheduledTaskRunner(runtime, {
            agentId: runtime.agentId,
          });
          await seedRegisteredTaskPacks(runtime, runner);
        } catch (error) {
          logger.warn(
            { src: "scheduling:boot-seed", agentId: runtime.agentId, error },
            "[scheduling] Default-pack boot seed failed; tasks can still be scheduled at runtime.",
          );
        }
      })
      .catch(() => {
        /* initPromise rejection is surfaced elsewhere */
      });
  },
};
