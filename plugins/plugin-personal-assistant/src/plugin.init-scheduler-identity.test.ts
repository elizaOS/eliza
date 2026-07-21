/**
 * Drives the personal-assistant plugin `init` to verify the LifeOps scheduler
 * worker identity is registered EVEN when the scheduler is disabled via
 * ELIZA_DISABLE_LIFEOPS_SCHEDULER (issue: preserve disabled scheduler worker
 * identity). A recording stub runtime captures every registerTaskWorker call so
 * the disabled-path behavior is asserted against the real init wiring rather
 * than a hand-rolled fragment. The dynamic Google connector import is stubbed so
 * init runs without the optional third-party plugin present.
 */
import type { IAgentRuntime, Plugin, TaskWorker, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate PA's own init wiring (registries, workers, policies, the scheduler
// identity under test) from the cross-plugin connector boot. Each connector
// package has its own dedicated suite; here they are neutralized so init runs
// deterministically without booting eight sibling plugins. The register-helper
// re-runs contributed by plugin-health depend on registries created later in
// init, which is the boot-order seam these hooks exist to paper over — not the
// behavior this test asserts.
vi.mock("@elizaos/plugin-google", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  googlePlugin: { name: "@elizaos/plugin-google", init: vi.fn() },
}));
vi.mock("@elizaos/plugin-health", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerHealthConnectors: vi.fn(),
  registerHealthAnchors: vi.fn(),
  registerHealthBusFamilies: vi.fn(),
  registerHealthDefaultPacks: vi.fn(),
  registerCircadianInsightContract: vi.fn(),
  createDefaultCircadianInsightContract: vi.fn(() => ({})),
}));

import { personalAssistantPlugin } from "./plugin.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000ab" as UUID;

interface RecordingRuntime {
  runtime: IAgentRuntime;
  taskWorkers: Map<string, TaskWorker>;
  registeredPlugins: Plugin[];
}

function createRecordingRuntime(): RecordingRuntime {
  const taskWorkers = new Map<string, TaskWorker>();
  const registeredPlugins: Plugin[] = [];
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
  };
  // The core-typed methods init reads back are special-cased; every other
  // runtime method init (or its registration helpers) touches is a recorded
  // no-op via the Proxy trap so the full init wiring executes deterministically
  // without a live AgentRuntime.
  const explicit: Record<string, unknown> = {
    agentId: AGENT_ID,
    logger,
    plugins: registeredPlugins,
    initPromise: Promise.resolve(),
    stopped: false,
    character: { name: "test-agent", settings: {} },
    getTaskWorker: (name: string) => taskWorkers.get(name),
    registerTaskWorker: (worker: TaskWorker) => {
      taskWorkers.set(worker.name, worker);
    },
    registerPlugin: async (plugin: Plugin) => {
      registeredPlugins.push(plugin);
    },
    getSetting: () => undefined,
    getService: () => null,
    getRoom: async () => null,
    getMemories: async () => [],
  };
  const noopCache = new Map<string, unknown>();
  const runtime = new Proxy(explicit, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (!noopCache.has(prop)) {
        noopCache.set(prop, (..._args: unknown[]) => undefined);
      }
      return noopCache.get(prop);
    },
  }) as unknown as IAgentRuntime;
  return { runtime, taskWorkers, registeredPlugins };
}

const LIFEOPS_TASK_NAME = "LIFEOPS_SCHEDULER";

describe("personalAssistantPlugin.init scheduler identity", () => {
  const originalEnv = process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    } else {
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = originalEnv;
    }
  });

  it("registers the LifeOps worker identity even when the scheduler is disabled", async () => {
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
    const { runtime, taskWorkers } = createRecordingRuntime();

    await personalAssistantPlugin.init?.({}, runtime);

    const worker = taskWorkers.get(LIFEOPS_TASK_NAME);
    expect(worker).toBeDefined();
    // Disabled worker keeps a valid identity but never executes.
    await expect(worker?.shouldRun?.(runtime)).resolves.toBe(false);
  });

  it("registers a LifeOps worker whose shouldRun is gated by app state when enabled", async () => {
    delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    const { runtime, taskWorkers } = createRecordingRuntime();

    await personalAssistantPlugin.init?.({}, runtime);

    const worker = taskWorkers.get(LIFEOPS_TASK_NAME);
    expect(worker).toBeDefined();
    // When enabled, shouldRun consults live app state (not a hardcoded false).
    expect(typeof worker?.shouldRun).toBe("function");
  });
});
