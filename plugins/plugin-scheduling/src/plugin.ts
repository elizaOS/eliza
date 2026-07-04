import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { buildSchedulingRoutes } from "./routes/plugin-routes.js";
import { buildFallbackDefaultPack } from "./scheduled-task/default-pack.js";
import {
  getScheduledTaskRunner,
  getScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./scheduled-task/runner-service.js";
import {
  getDefaultTaskPacks,
  registerDefaultTaskPack,
  seedRegisteredTaskPacks,
} from "./scheduled-task/seed-registry.js";

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
 * plugin imports neither `@elizaos/app-core`, `@elizaos/agent`, nor
 * `@elizaos/plugin-personal-assistant`.
 *
 * It ships ONE small, generic built-in fallback pack (`buildFallbackDefaultPack`
 * — a daily "Good morning" reminder + a paused "Weekly review" starter) that is
 * seeded ONLY when no consumer host is present. The consumer signal is the
 * injected deps provider: a host like PA calls `registerScheduledTaskRunnerDeps`
 * during its `init` (which completes before `runtime.initPromise` resolves), so
 * by seed time the spine knows whether a host owns the runner. When a host is
 * present its richer domain pack supersedes the fallback and the fallback is not
 * registered → no double-seed. On a stock mobile boot (no PA) the fallback seeds
 * so the home Tasks widget resolves.
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
  views: [
    {
      id: "lifeops-live-test",
      label: "LifeOps Live Test",
      description:
        "Connect your model and accounts, then run a real LifeOps validation and watch it fire.",
      icon: "FlaskConical",
      path: "/lifeops-live-test",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "LifeOpsLiveTestView",
      tags: ["lifeops", "scheduling", "test", "hitl"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Seed registered default-task packs once init has finished so the runner
    // service (and any consumer's injected deps + packs) are registered before
    // the seed runs. Failures are non-fatal to plugin load.
    void runtime.initPromise
      .then(async () => {
        try {
          await runtime.getServiceLoadPromise(
            ScheduledTaskRunnerService.serviceType,
          );
          // Register the built-in fallback pack only when no consumer host has
          // injected deps (e.g. a stock mobile boot without
          // @elizaos/plugin-personal-assistant). When a host is present it owns
          // the domain content; `seedRegisteredTaskPacks` would also drop a
          // fallback pack via its consumer-pack gate, but skipping registration
          // here keeps the registry honest and avoids seeding generic defaults
          // alongside a host's richer pack.
          const hasConsumerHost = getScheduledTaskRunnerDeps(runtime) !== null;
          const alreadyRegistered = getDefaultTaskPacks(runtime).length > 0;
          if (!hasConsumerHost && !alreadyRegistered) {
            registerDefaultTaskPack(
              runtime,
              buildFallbackDefaultPack({ agentId: runtime.agentId }),
            );
          }
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
