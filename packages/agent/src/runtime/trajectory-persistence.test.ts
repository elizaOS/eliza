/**
 * Behavioral coverage for the trajectory-persistence public barrel: helpers,
 * step-page limits, fail-fast storage boundaries, observation buffering, and
 * logger construction. Imports the barrel (not the decomposed modules) and
 * drives the real implementations with hand-built runtimes.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotateTrajectoryStep,
  clearAllSteps,
  clearPersistedTrajectoryRows,
  completeTrajectoryStepInDatabase,
  computeBySource,
  createDatabaseTrajectoryLogger,
  DatabaseTrajectoryLogger,
  DEFAULT_GET_STEPS_LIMIT,
  deletePersistedTrajectoryRows,
  deleteStepsForTrajectories,
  extractInsightsFromResponse,
  extractRows,
  flushObservationBuffer,
  flushTrajectoryWrites,
  getSteps,
  installDatabaseTrajectoryLogger,
  loadAllStepsForTrajectory,
  loadPersistedTrajectoryRows,
  MAX_GET_STEPS_LIMIT,
  pruneOldTrajectories,
  pushChatExchange,
  readOrchestratorTrajectoryContext,
  replaceStepsForTrajectory,
  shouldEnableTrajectoryLoggingByDefault,
  shouldRunObservationExtraction,
  startTrajectoryStepInDatabase,
  upsertStep,
} from "./trajectory-persistence.ts";

function runtimeStub(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "agent-trajectory-persistence",
    actions: [],
    adapter: {},
    logger: { warn: () => undefined },
    reportError: () => undefined,
    getSetting: () => undefined,
    getService: () => null,
    getServicesByType: () => [],
    useModel: async () => "",
    ...overrides,
  } as unknown as IAgentRuntime;
}

function dbRuntime(
  execute: (query: unknown) => Promise<unknown>,
  overrides: Record<string, unknown> = {},
): IAgentRuntime {
  const db = {
    execute,
    transaction: async <T>(
      work: (tx: { execute: typeof execute }) => Promise<T>,
    ): Promise<T> => work({ execute }),
  };
  return runtimeStub({
    adapter: { db },
    ...overrides,
  });
}

const missingStep = {
  stepId: "missing-step",
  stepNumber: 0,
  timestamp: 1,
  llmCalls: [],
  providerAccesses: [],
};

describe("trajectory-persistence barrel constants", () => {
  it("publishes the default page size and the hard cap used to clamp overflow", () => {
    expect(DEFAULT_GET_STEPS_LIMIT).toBe(100);
    expect(MAX_GET_STEPS_LIMIT).toBe(1000);
    expect(DEFAULT_GET_STEPS_LIMIT).toBeLessThan(MAX_GET_STEPS_LIMIT);
  });
});

describe("extractRows", () => {
  it("returns arrays as-is, including the empty list", () => {
    expect(extractRows([])).toEqual([]);
    expect(extractRows([{ id: "a" }])).toEqual([{ id: "a" }]);
  });

  it("reads a rows field when present and otherwise returns an empty list", () => {
    expect(extractRows({ rows: [{ id: "b" }] })).toEqual([{ id: "b" }]);
    expect(extractRows({ rows: "not-an-array" })).toEqual([]);
    expect(extractRows({ total: 1 })).toEqual([]);
    expect(extractRows(null)).toEqual([]);
    expect(extractRows(undefined)).toEqual([]);
    expect(extractRows("nope")).toEqual([]);
  });
});

describe("extractInsightsFromResponse", () => {
  it("collects DECISION lines then keyDecision values in encounter order", () => {
    expect(
      extractInsightsFromResponse(
        'DECISION: first\nignored\nDECISION:\tsecond\n{"keyDecision":"third"}',
        "reply",
      ),
    ).toEqual(["first", "second", "third"]);
  });

  it("returns an empty list when there are no markers and no reasoning fallback", () => {
    expect(extractInsightsFromResponse("no markers", "reply")).toEqual([]);
    expect(
      extractInsightsFromResponse('{"reasoning":"too-short"}', "coordination"),
    ).toEqual([]);
    expect(
      extractInsightsFromResponse(
        `{"reasoning":"${"long enough reasoning text"}"}`,
        "reply",
      ),
    ).toEqual([]);
  });

  it("falls back to a long reasoning string only for turn-complete or coordination", () => {
    const reasoning = "long enough reasoning text";
    expect(
      extractInsightsFromResponse(
        `{"reasoning":"${reasoning}"}`,
        "turn-complete",
      ),
    ).toEqual([reasoning]);
    expect(
      extractInsightsFromResponse(
        `{"reasoning":"${reasoning}"}`,
        "coordination",
      ),
    ).toEqual([reasoning]);
  });

  it("rejects malformed Unicode instead of repairing recorded response text", () => {
    expect(() =>
      extractInsightsFromResponse("bad\ud800response", "reply"),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TEXT_MALFORMED_UNICODE" }),
    );
  });
});

describe("shouldRunObservationExtraction", () => {
  it("honors an explicit setting over the REFLECTION action and default-on", () => {
    expect(
      shouldRunObservationExtraction(
        runtimeStub({ getSetting: () => "false" }),
      ),
    ).toBe(false);
    expect(
      shouldRunObservationExtraction(
        runtimeStub({
          getSetting: () => "enabled",
          actions: [{ name: "REFLECTION" }],
        }),
      ),
    ).toBe(true);
    expect(
      shouldRunObservationExtraction(
        runtimeStub({
          getSetting: () => undefined,
          actions: [{ name: "REFLECTION" }],
        }),
      ),
    ).toBe(false);
    expect(shouldRunObservationExtraction(runtimeStub())).toBe(true);
  });
});

describe("shouldEnableTrajectoryLoggingByDefault", () => {
  it("hard-disables when ELIZA_DISABLE_TRAJECTORY_LOGGING is set", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "development",
        ELIZA_TRAJECTORY_LOGGING: "1",
        ELIZA_DISABLE_TRAJECTORY_LOGGING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("follows explicit logging, then the legacy recording alias, then env defaults", () => {
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
        ELIZA_TRAJECTORY_LOGGING: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
        ELIZA_TRAJECTORY_RECORDING: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      shouldEnableTrajectoryLoggingByDefault({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      shouldEnableTrajectoryLoggingByDefault({} as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("readOrchestratorTrajectoryContext", () => {
  it("returns undefined for missing, non-object, and incomplete context", () => {
    expect(readOrchestratorTrajectoryContext(null)).toBeUndefined();
    expect(readOrchestratorTrajectoryContext(undefined)).toBeUndefined();
    expect(readOrchestratorTrajectoryContext("runtime")).toBeUndefined();
    expect(readOrchestratorTrajectoryContext({})).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: null,
      }),
    ).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: {
          source: "other",
          decisionType: "plan",
        },
      }),
    ).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: { source: "orchestrator" },
      }),
    ).toBeUndefined();
  });

  it("returns the context when source is orchestrator and decisionType is a string", () => {
    const ctx = {
      source: "orchestrator" as const,
      decisionType: "observation-extraction",
      sessionId: "sess-1",
      taskLabel: "extract",
    };
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: ctx,
      }),
    ).toEqual(ctx);
  });
});

describe("computeBySource", () => {
  it("rejects a runtime with no database instead of fabricating an empty map", async () => {
    await expect(computeBySource(runtimeStub())).rejects.toThrow(
      "runtime database adapter unavailable",
    );
  });

  it("returns an empty map for an empty aggregation result", async () => {
    const runtime = dbRuntime(async () => ({ rows: [] }));
    await expect(computeBySource(runtime)).resolves.toEqual({});
  });

  it("aggregates a single source and preserves insertion order for distinct sources", async () => {
    const runtime = dbRuntime(async () => ({
      rows: [
        { source: " runtime ", cnt: 2 },
        { source: "orchestrator", cnt: "3" },
      ],
    }));
    await expect(computeBySource(runtime)).resolves.toEqual({
      runtime: 2,
      orchestrator: 3,
    });
  });

  it("lets a later row for the same source overwrite the earlier count", async () => {
    const runtime = dbRuntime(async () => ({
      rows: [
        { source: "runtime", cnt: 1 },
        { source: "runtime", cnt: 4 },
      ],
    }));
    await expect(computeBySource(runtime)).resolves.toEqual({ runtime: 4 });
  });

  it("rejects blank sources, non-integer counts, and missing counts", async () => {
    await expect(
      computeBySource(
        dbRuntime(async () => ({ rows: [{ source: "  ", cnt: 1 }] })),
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
    await expect(
      computeBySource(
        dbRuntime(async () => ({ rows: [{ source: "runtime", cnt: 1.5 }] })),
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
    await expect(
      computeBySource(
        dbRuntime(async () => ({ rows: [{ source: "runtime", cnt: -1 }] })),
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
    await expect(
      computeBySource(
        dbRuntime(async () => ({ rows: [{ source: "runtime" }] })),
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
    await expect(
      computeBySource(dbRuntime(async () => ({}))),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
  });
});

describe("getSteps pagination and ownership", () => {
  it("throws when storage is missing, then when the trajectory id is blank", async () => {
    await expect(getSteps(runtimeStub(), "traj-1")).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
    await expect(
      getSteps(
        dbRuntime(async () => ({ rows: [{ total: 0 }] })),
        "   ",
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ID_INVALID" });
  });

  it("returns an empty page for a genuine zero-step trajectory", async () => {
    const page = await getSteps(
      dbRuntime(async () => ({ rows: [{ total: 0 }] })),
      "traj-empty",
    );
    expect(page).toEqual({
      steps: [],
      total: 0,
      offset: 0,
      limit: DEFAULT_GET_STEPS_LIMIT,
    });
  });

  it("clamps a negative offset to zero and overflow/zero limits onto [1, MAX]", async () => {
    const page = await getSteps(
      dbRuntime(async () => ({ rows: [{ total: "0" }] })),
      "traj-clamp",
      -3.9,
      50_000,
    );
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(MAX_GET_STEPS_LIMIT);

    const zeroLimit = await getSteps(
      dbRuntime(async () => ({ rows: [{ total: 0 }] })),
      "traj-clamp",
      2.8,
      0,
    );
    expect(zeroLimit.offset).toBe(2);
    expect(zeroLimit.limit).toBe(1);
  });

  it("rejects a non-integer or missing total instead of reporting an empty page", async () => {
    await expect(
      getSteps(
        dbRuntime(async () => ({ rows: [{ total: 1.5 }] })),
        "traj-bad-total",
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_ROW_INVALID" });
    await expect(
      getSteps(
        dbRuntime(async () => ({ rows: [{}] })),
        "traj-missing-total",
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_ROW_INVALID" });
    await expect(
      getSteps(
        dbRuntime(async () => ({})),
        "traj-malformed",
      ),
    ).rejects.toMatchObject({ code: "TRAJECTORY_ROW_INVALID" });
  });

  it("rejects a non-record step row when the count says a page exists", async () => {
    const queue = [{ rows: [{ total: 1 }] }, { rows: ["not-a-row"] }];
    const runtime = dbRuntime(async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra query");
      return next;
    });
    await expect(getSteps(runtime, "traj-bad-row")).rejects.toMatchObject({
      code: "TRAJECTORY_STEP_ROW_INVALID",
    });
  });
});

describe("loadAllStepsForTrajectory", () => {
  it("returns an empty list when the owned trajectory has no dedicated steps", async () => {
    await expect(
      loadAllStepsForTrajectory(
        dbRuntime(async () => ({ rows: [{ total: 0 }] })),
        "traj-empty",
      ),
    ).resolves.toEqual([]);
  });
});

describe("step writers without a parent or database", () => {
  it("throws TRAJECTORY_DATABASE_UNAVAILABLE when the adapter is missing", async () => {
    const runtime = runtimeStub();
    await expect(
      upsertStep(runtime, "traj-1", missingStep),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
    await expect(
      replaceStepsForTrajectory(runtime, "traj-1", [missingStep]),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
    await expect(
      deleteStepsForTrajectories(runtime, ["traj-1"]),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
    await expect(clearAllSteps(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("treats an empty or blank trajectory-id list as a no-op delete of zero rows", async () => {
    const runtime = dbRuntime(async () => {
      throw new Error("delete must not run for an empty id list");
    });
    await expect(deleteStepsForTrajectories(runtime, [])).resolves.toBe(0);
    await expect(
      deleteStepsForTrajectories(runtime, ["", "   "]),
    ).resolves.toBe(0);
  });
});

describe("persisted row writes and query without a database", () => {
  it("throws TRAJECTORY_DATABASE_UNAVAILABLE for public load, delete, clear, and prune", async () => {
    const runtime = runtimeStub();
    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
    await expect(
      deletePersistedTrajectoryRows(runtime, ["traj-1"]),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
    await expect(clearPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
    await expect(pruneOldTrajectories(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("returns false from start, complete, and annotate when storage or the step id is missing", async () => {
    const noDb = runtimeStub();
    await expect(
      startTrajectoryStepInDatabase({ runtime: noDb, stepId: "step-1" }),
    ).resolves.toBe(false);
    await expect(
      completeTrajectoryStepInDatabase({ runtime: noDb, stepId: "step-1" }),
    ).resolves.toBe(false);
    await expect(
      annotateTrajectoryStep({ runtime: noDb, stepId: "step-1", kind: "llm" }),
    ).resolves.toBe(false);

    const withDb = dbRuntime(async () => {
      throw new Error("invalid step ids must not query");
    });
    await expect(
      startTrajectoryStepInDatabase({ runtime: withDb, stepId: "   " }),
    ).resolves.toBe(false);
    await expect(
      completeTrajectoryStepInDatabase({ runtime: withDb, stepId: "" }),
    ).resolves.toBe(false);
    await expect(
      annotateTrajectoryStep({ runtime: withDb, stepId: "  " }),
    ).resolves.toBe(false);
  });
});

describe("flushTrajectoryWrites", () => {
  it("resolves immediately when no write queue exists, including a missing step id", async () => {
    const runtime = runtimeStub();
    await expect(flushTrajectoryWrites(runtime)).resolves.toBeUndefined();
    await expect(
      flushTrajectoryWrites(runtime, "missing-step"),
    ).resolves.toBeUndefined();
  });
});

describe("observation buffer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes an empty buffer to an empty observation list", async () => {
    await expect(flushObservationBuffer(runtimeStub())).resolves.toEqual([]);
  });

  it("does not start a concurrent second flush while the first is in progress", async () => {
    let release!: () => void;
    const blocked = new Promise<string>((resolve) => {
      release = () => resolve('["kept-complete"]');
    });
    const runtime = runtimeStub({
      useModel: async () => blocked,
    });
    pushChatExchange(runtime, {
      userPrompt: "one",
      response: "ok",
      trajectoryId: "traj-1",
      timestamp: 1,
    });
    const first = flushObservationBuffer(runtime);
    await expect(flushObservationBuffer(runtime)).resolves.toEqual([]);
    release();
    await expect(first).resolves.toEqual([]);
  });

  it("returns parsed observations when the model yields a JSON array and no parent row exists", async () => {
    const runtime = dbRuntime(async () => ({ rows: [] }), {
      useModel: async () => 'prefix ["complete-observation"] suffix',
    });
    pushChatExchange(runtime, {
      userPrompt: "remember this",
      response: "noted",
      trajectoryId: "missing-parent",
      timestamp: 1,
    });
    await expect(flushObservationBuffer(runtime)).resolves.toEqual([
      "complete-observation",
    ]);
  });
});

describe("DatabaseTrajectoryLogger", () => {
  it("constructs a disabled-in-test logger that still vends a capture id", async () => {
    const runtime = runtimeStub();
    const logger = createDatabaseTrajectoryLogger(runtime);
    expect(logger).toBeInstanceOf(DatabaseTrajectoryLogger);
    expect(DatabaseTrajectoryLogger.serviceType).toBe("trajectories");
    expect(DatabaseTrajectoryLogger.allowsMultiple).toBe(true);
    expect(logger.capabilityDescription).toContain("trajectory logging");
    expect(logger.isEnabled()).toBe(false);

    const id = await logger.startTrajectory("agent-trajectory-persistence");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    logger.setEnabled(true);
    expect(logger.isEnabled()).toBe(true);
    logger.setEnabled(false);
    expect(logger.isEnabled()).toBe(false);
  });

  it("installs as a no-op when the runtime has no database adapter", async () => {
    await expect(
      installDatabaseTrajectoryLogger(runtimeStub()),
    ).resolves.toBeUndefined();
  });
});
