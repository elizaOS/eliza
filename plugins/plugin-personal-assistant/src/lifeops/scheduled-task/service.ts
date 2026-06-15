/**
 * Long-lived ScheduledTask runner singleton.
 *
 * Before this service existed, `processDueScheduledTasks` called
 * `createRuntimeScheduledTaskRunner` on every tick (every 60s). That call
 * rebuilds all five typed registries (gates, completion-checks, ladders,
 * anchors, consolidation), refreshes the channel-keys snapshot, and wires
 * a fresh `createProductionScheduledTaskDispatcher`. None of that work
 * varies tick-to-tick — the registries are populated at plugin init and
 * stay stable. Rebuilding them on a 1-minute cadence was wasteful and
 * inflated per-tick latency.
 *
 * The service builds the runner ONCE per runtime when
 * `ScheduledTaskRunnerService.start` is invoked by the elizaOS Service
 * lifecycle, caches it on the instance, and hands it out via
 * `getScheduledTaskRunner`. The `now` clock and `agentId` are still
 * accepted per call so the tick can pass its own `request.now` and the
 * scheduler stays deterministic in tests.
 *
 * Registration: see `plugin.ts` → `services: [...,
 * ScheduledTaskRunnerService]`.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

import type { ScheduledTaskRunnerHandle } from "./runner.js";
import {
  type CreateRuntimeRunnerOptions,
  createRuntimeScheduledTaskRunner,
} from "./runtime-wiring.js";

const SERVICE_TYPE = "lifeops_scheduled_task_runner" as const;

/**
 * Options accepted by `getScheduledTaskRunner`. The agentId always comes
 * from the caller (the tick passes the agent's own id; routes / actions
 * read it off `runtime.agentId`). The `now` override stays per-call so
 * tests and time-travel scenarios get the clock they expect. Everything
 * else lives on the cached runner.
 */
export interface GetScheduledTaskRunnerOptions {
  agentId: string;
  now?: () => Date;
}

export class ScheduledTaskRunnerService extends Service {
  static override serviceType = SERVICE_TYPE;

  override capabilityDescription =
    "Long-lived ScheduledTask runner. Hosts gate/completion-check/ladder/anchor/consolidation registries built once at plugin start; the scheduler tick reads the cached runner instead of reconstructing it every minute.";

  // The runner is keyed by `(agentId, nowOverridePresent)` so callers that
  // pass distinct `now` overrides get their own handle. In practice the
  // production tick always passes the same `now` function reference, and
  // routes / actions never override it — so the cache typically holds one
  // entry per runtime.
  private readonly runners = new Map<string, ScheduledTaskRunnerHandle>();

  override async stop(): Promise<void> {
    this.runners.clear();
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ScheduledTaskRunnerService> {
    logger.debug(
      { src: SERVICE_TYPE, agentId: runtime.agentId },
      "ScheduledTaskRunnerService started",
    );
    return new ScheduledTaskRunnerService(runtime);
  }

  /**
   * Return the cached runner for `(agentId, optional now-override)`. The
   * first call constructs the runner via
   * {@link createRuntimeScheduledTaskRunner} (one-time registry/dispatcher
   * wiring); subsequent calls hit the in-memory cache.
   */
  getRunner(opts: GetScheduledTaskRunnerOptions): ScheduledTaskRunnerHandle {
    const cacheKey = `${opts.agentId}::${opts.now ? "now-override" : "system-clock"}`;
    const cached = this.runners.get(cacheKey);
    if (cached) return cached;
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error(
        "ScheduledTaskRunnerService: runtime is not bound; was the service started?",
      );
    }
    const runnerOpts: CreateRuntimeRunnerOptions = {
      runtime,
      agentId: opts.agentId,
    };
    if (opts.now) runnerOpts.now = opts.now;
    const runner = createRuntimeScheduledTaskRunner(runnerOpts);
    this.runners.set(cacheKey, runner);
    return runner;
  }
}

/**
 * Module-level accessor. Resolves the service via the runtime's service
 * registry and returns its cached runner. Throws when the service is not
 * registered — that is a plugin-wiring bug, not a runtime fallback case.
 *
 * Used by:
 *  - `scheduled-task/scheduler.ts` (per-tick `fireWithResult` path)
 *  - the action and route call sites listed in `runtime-wiring.ts` that
 *    previously called `createRuntimeScheduledTaskRunner` directly.
 */
export function getScheduledTaskRunner(
  runtime: IAgentRuntime,
  opts: GetScheduledTaskRunnerOptions,
): ScheduledTaskRunnerHandle {
  const service = runtime.getService(SERVICE_TYPE) as
    | ScheduledTaskRunnerService
    | null
    | undefined;
  if (!service) {
    throw new Error(
      `[${SERVICE_TYPE}] ScheduledTaskRunnerService is not registered on this runtime. Add it to the lifeops plugin's services array.`,
    );
  }
  return service.getRunner(opts);
}
