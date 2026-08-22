/**
 * Scheduling plugin registration hosts the generic scheduled-task runner,
 * routes, default-pack seeding, and fallback deps on every platform.
 *
 * Hosts inject production deps and domain packs via the runner deps and default
 * pack registries; the built-in fallback pack only seeds when no host owns the
 * runner. Each runtime keeps one runner service, one injected deps set, and one
 * scheduled-task REST route.
 */
import {
  ElizaError,
  type IAgentRuntime,
  logger,
  type Plugin,
} from "@elizaos/core";
import { buildSchedulingRoutes } from "./routes/plugin-routes.js";
import { schedulingDbSchema } from "./scheduled-task/db-schema.js";
import { buildFallbackDefaultPack } from "./scheduled-task/default-pack.js";

import {
  getScheduledTaskRunnerDeps,
  registerScheduledTaskRunnerBootHook,
  ScheduledTaskRunnerService,
} from "./scheduled-task/runner-service.js";
import {
  getDefaultTaskPacks,
  registerDefaultTaskPack,
  seedRegisteredTaskPacks,
} from "./scheduled-task/seed-registry.js";
import {
  disposeStandaloneTick,
  ensureStandaloneTickTask,
  registerStandaloneTickWorker,
} from "./scheduled-task/standalone-tick.js";

export const SCHEDULED_TASK_RUNNER_REGISTRATION_TIMEOUT =
  "SCHEDULED_TASK_RUNNER_REGISTRATION_TIMEOUT";
export const SCHEDULED_TASK_RUNNER_REGISTRATION_FAILED =
  "SCHEDULED_TASK_RUNNER_REGISTRATION_FAILED";
export const SCHEDULED_TASK_RUNNER_WAIT_STOPPED =
  "SCHEDULED_TASK_RUNNER_WAIT_STOPPED";

const DEFAULT_RUNNER_REGISTRATION_TIMEOUT_MS = 30_000;
const DEFAULT_RUNNER_REGISTRATION_POLL_MS = 250;

export interface WaitForScheduledTaskRunnerServiceOptions {
  registrationTimeoutMs?: number;
  registrationPollMs?: number;
  /** Cancels deferred startup when the owning plugin/service is disposed. */
  signal?: AbortSignal;
}

function runnerWaitStopped(
  runtime: IAgentRuntime,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted === true ||
    (runtime as IAgentRuntime & { stopped?: boolean }).stopped === true
  );
}

function runnerWaitStoppedError(serviceType: string): ElizaError {
  return new ElizaError("Scheduled task runner wait stopped", {
    code: SCHEDULED_TASK_RUNNER_WAIT_STOPPED,
    context: { serviceType },
  });
}

function throwRunnerWaitStopped(serviceType: string): never {
  throw runnerWaitStoppedError(serviceType);
}

async function waitForPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throwRunnerWaitStopped(ScheduledTaskRunnerService.serviceType);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(runnerWaitStoppedError(ScheduledTaskRunnerService.serviceType));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    throwRunnerWaitStopped(ScheduledTaskRunnerService.serviceType);
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(runnerWaitStoppedError(ScheduledTaskRunnerService.serviceType));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireDuration(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number {
  const duration = value ?? fallback;
  if (
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    duration < (allowZero ? 0 : 1)
  ) {
    throw new ElizaError(`${name} must be a finite integer in milliseconds`, {
      code: "SCHEDULED_TASK_RUNNER_WAIT_INVALID",
      context: { name, value: duration },
    });
  }
  return duration;
}

/**
 * Wait for the deferred runner declaration before asking the runtime to load
 * it. Registration failure is observed immediately; missing registration is
 * bounded so dependent service startup cannot hang indefinitely.
 */
export async function waitForScheduledTaskRunnerService(
  runtime: IAgentRuntime,
  options: WaitForScheduledTaskRunnerServiceOptions = {},
): Promise<ScheduledTaskRunnerService> {
  await waitForPromise(runtime.initPromise, options.signal);

  const serviceType = ScheduledTaskRunnerService.serviceType;
  if (runnerWaitStopped(runtime, options.signal)) {
    throwRunnerWaitStopped(serviceType);
  }
  const timeoutMs = requireDuration(
    options.registrationTimeoutMs,
    DEFAULT_RUNNER_REGISTRATION_TIMEOUT_MS,
    "registrationTimeoutMs",
    true,
  );
  const pollMs = requireDuration(
    options.registrationPollMs,
    DEFAULT_RUNNER_REGISTRATION_POLL_MS,
    "registrationPollMs",
    false,
  );
  const deadline = Date.now() + timeoutMs;

  while (!runtime.hasService(serviceType)) {
    if (runnerWaitStopped(runtime, options.signal)) {
      throwRunnerWaitStopped(serviceType);
    }
    const status = runtime.getServiceRegistrationStatus(serviceType);
    if (status === "failed") {
      throw new ElizaError("Scheduled task runner registration failed", {
        code: SCHEDULED_TASK_RUNNER_REGISTRATION_FAILED,
        context: { serviceType, status },
      });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ElizaError(
        "Scheduled task runner was not registered before the startup deadline",
        {
          code: SCHEDULED_TASK_RUNNER_REGISTRATION_TIMEOUT,
          context: { serviceType, status, timeoutMs },
        },
      );
    }
    await waitForPoll(Math.min(pollMs, remainingMs), options.signal);
  }

  if (runnerWaitStopped(runtime, options.signal)) {
    throwRunnerWaitStopped(serviceType);
  }

  return (await waitForPromise(
    runtime.getServiceLoadPromise(serviceType),
    options.signal,
  )) as ScheduledTaskRunnerService;
}

export const schedulingPlugin: Plugin = {
  name: "@elizaos/plugin-scheduling",
  description:
    "Scheduling spine: the always-loaded ScheduledTask runtime primitive — runner host, REST surface, durable store, and default-pack seed registry. Owner/channel deps are injected by a host plugin; built-in defaults run when no host is present.",
  dependencies: ["@elizaos/plugin-sql"],
  schema: schedulingDbSchema,
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
      modalities: ["gui"],
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
    registerStandaloneTickWorker(runtime);
    // Seed registered default-task packs through the runner boot hook: the
    // hook fires with the live service instance the moment
    // ScheduledTaskRunnerService.start constructs it, so seeding structurally
    // cannot run before the runner exists (#16309). The initPromise await
    // inside the hook lets every consumer plugin finish registering its deps
    // and packs first. Failures are non-fatal to plugin load but observable
    // through runtime.reportError.
    registerScheduledTaskRunnerBootHook(runtime, async (service) => {
      try {
        await runtime.initPromise;
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
        const runner = service.getRunner({ agentId: runtime.agentId });
        await seedRegisteredTaskPacks(runtime, runner);
        // Fallback TaskService worker: without this, a runtime with no
        // consumer host (plugin-personal-assistant) accepts scheduled
        // tasks over REST but never fires them — `once`/`cron`/`interval`
        // rows sat `scheduled` forever (sol-dev cutover QA 2026-08-11).
        // The worker defers per-invocation when a consumer host's deps are
        // registered. Core TaskService remains the only wall clock.
        await ensureStandaloneTickTask(runtime);
      } catch (error) {
        // error-policy:J7 boot seeding is diagnostic work relative to the
        // runner service: report it so boot health observers see the failure
        // instead of a silently healthy boot, then keep the runtime alive —
        // tasks can still be scheduled at runtime.
        runtime.reportError("scheduling.bootSeed", error, {
          agentId: runtime.agentId,
        });
        logger.warn(
          { src: "scheduling:boot-seed", agentId: runtime.agentId, error },
          "[scheduling] Default-pack boot seed failed; tasks can still be scheduled at runtime.",
        );
      }
    });
  },
  dispose: async (runtime: IAgentRuntime) => {
    try {
      await disposeStandaloneTick(runtime);
    } catch (error) {
      // error-policy:J6 Plugin unload is best-effort; surface cleanup failure
      // without turning an otherwise successful runtime shutdown into a crash.
      logger.warn(
        { src: "scheduling:dispose", agentId: runtime.agentId, error },
        "[scheduling] Failed to remove the standalone tick task during teardown.",
      );
    }
  },
};
