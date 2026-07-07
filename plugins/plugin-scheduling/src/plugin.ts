/**
 * Scheduling plugin registration hosts the generic scheduled-task runner,
 * routes, default-pack seeding, and fallback deps on every platform.
 *
 * Hosts inject production deps and domain packs via the runner deps and default
 * pack registries; the built-in fallback pack only seeds when no host owns the
 * runner. Each runtime keeps one runner service, one injected deps set, and one
 * scheduled-task REST route.
 */
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
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "LifeOpsLiveTestView",
      tags: ["lifeops", "scheduling", "test", "hitl"],
      // Developer/QA validation surface, not a user destination: gate it behind
      // Developer Mode and keep it off the launcher grid, the view manager, and
      // desktop tabs. The route stays reachable for the live-test workflow.
      developerOnly: true,
      visibleInManager: false,
      desktopTabEnabled: false,
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
