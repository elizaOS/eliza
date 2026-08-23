/**
 * Behavioral coverage for trajectory-internals.ts exported helpers: coercion,
 * tag and step-type inference, SQL quoting, row parsing, write-queue
 * ordering, logger scoring, and archive formatting. Drives the real module
 * with hand-built collaborators; no mocked return-value theatre.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  appendCompleteTrajectoryTextRecords,
  assertTrajectoryAgentOwnership,
  assertTrajectoryStepOwnership,
  assertTrajectoryStepParentOwnership,
  buildTrajectoryStepUpsertSql,
  collectTrajectoryTimestamps,
  createBaseTrajectory,
  enqueueStepWrite,
  enrichTrajectoryLlmCall,
  ensureStep,
  executeRawSql,
  executeRawSqlTransaction,
  extractInsightsFromResponse,
  extractRequiredRows,
  extractRows,
  getRuntimeDb,
  hasActionNamed,
  hasRuntimeDb,
  inferTrajectoryLlmStepType,
  inferTrajectoryLlmTags,
  isLegacyTrajectoryLogger,
  isNumericVectorString,
  mergeMetadata,
  normalizePersistedTrajectoryTiming,
  normalizePersistedUpdatedAt,
  normalizeProviderAccessPayload,
  normalizeStatus,
  normalizeStepId,
  normalizeTrajectoryMetadata,
  normalizeTrajectoryTag,
  type PersistedStep,
  type PersistedTrajectory,
  parseJsonValue,
  parseMetadata,
  parsePersistedEvaluatorName,
  parsePersistedLlmCall,
  parsePersistedMetadata,
  parsePersistedProviderAccess,
  parsePersistedSkillInvocations,
  parsePersistedStepObject,
  parsePersistedTrajectoryRow,
  parsePersistedTrajectoryStatus,
  parseSteps,
  type RawSqlExecutor,
  readOrchestratorTrajectoryContext,
  readRecordValue,
  resolvePreferredTrajectoryArchiveRoot,
  resolveTrajectoryGrouping,
  resolveTrajectoryLogger,
  shouldRunObservationExtraction,
  shouldSuppressNoInputEmbeddingCall,
  sqlNumber,
  sqlQuote,
  stepWriteQueues,
  stringifyArchiveRow,
  summarizeTrajectory,
  TRAJECTORY_ARCHIVE_DIRNAME,
  type TrajectoryLoggerLike,
  toArchiveSafeTimestamp,
  toNumber,
  toOptionalBoolean,
  toOptionalEpochMs,
  toOptionalNumber,
  toOptionalText,
  toText,
  warnRuntime,
} from "./trajectory-internals.ts";

function runtimeStub(overrides: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: "agent-test",
    actions: [],
    adapter: {},
    logger: { warn: () => undefined },
    reportError: () => undefined,
    getSetting: () => undefined,
    getService: () => null,
    getServicesByType: () => [],
    ...overrides,
  } as unknown as IAgentRuntime;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sqlExecutor(result: unknown): RawSqlExecutor {
  return async () => result;
}

function validStep(overrides: Record<string, unknown> = {}): PersistedStep {
  return {
    stepId: "step-1",
    stepNumber: 0,
    timestamp: 1_000,
    llmCalls: [],
    providerAccesses: [],
    ...overrides,
  } as PersistedStep;
}

describe("coercion helpers", () => {
  it("toText keeps strings, falls back for nullish, and stringifies other values", () => {
    expect(toText("keep")).toBe("keep");
    expect(toText(undefined, "fallback")).toBe("fallback");
    expect(toText(null, "fallback")).toBe("fallback");
    expect(toText(12)).toBe("12");
    expect(toText(false)).toBe("false");
  });

  it("toOptionalText trims and treats blank as missing", () => {
    expect(toOptionalText("  hi  ")).toBe("hi");
    expect(toOptionalText("   ")).toBeUndefined();
    expect(toOptionalText(null)).toBeUndefined();
    expect(toOptionalText(0)).toBe("0");
  });

  it("toNumber accepts finite numbers and numeric strings, otherwise the fallback", () => {
    expect(toNumber(3.5)).toBe(3.5);
    expect(toNumber("42")).toBe(42);
    expect(toNumber(" 7 ")).toBe(7);
    expect(toNumber(Number.NaN, 9)).toBe(9);
    expect(toNumber(Number.POSITIVE_INFINITY, 9)).toBe(9);
    expect(toNumber("nope", 4)).toBe(4);
    expect(toNumber(undefined, 1)).toBe(1);
  });

  it("toOptionalNumber treats nullish and non-finite as missing", () => {
    expect(toOptionalNumber(undefined)).toBeUndefined();
    expect(toOptionalNumber(null)).toBeUndefined();
    expect(toOptionalNumber("8")).toBe(8);
    expect(toOptionalNumber("bad")).toBeUndefined();
    expect(toOptionalNumber(Number.NaN)).toBeUndefined();
  });

  it("toOptionalBoolean accepts boolean, numeric, and known string tokens", () => {
    expect(toOptionalBoolean(true)).toBe(true);
    expect(toOptionalBoolean(false)).toBe(false);
    expect(toOptionalBoolean(2)).toBe(true);
    expect(toOptionalBoolean(0)).toBe(false);
    expect(toOptionalBoolean("YES")).toBe(true);
    expect(toOptionalBoolean("on")).toBe(true);
    expect(toOptionalBoolean("enabled")).toBe(true);
    expect(toOptionalBoolean("1")).toBe(true);
    expect(toOptionalBoolean("0")).toBe(false);
    expect(toOptionalBoolean("OFF")).toBe(false);
    expect(toOptionalBoolean("disabled")).toBe(false);
    expect(toOptionalBoolean("maybe")).toBeUndefined();
    expect(toOptionalBoolean({})).toBeUndefined();
  });
});

describe("normalizeTrajectoryTag and LLM step typing", () => {
  it("normalizes camelCase, separators, and empty input", () => {
    expect(normalizeTrajectoryTag("")).toBe("");
    expect(normalizeTrajectoryTag("  ")).toBe("");
    expect(normalizeTrajectoryTag("ShouldRespond")).toBe("should_respond");
    expect(normalizeTrajectoryTag("purpose::Action")).toBe("purpose::action");
    expect(normalizeTrajectoryTag("__foo--bar__")).toBe("foo_bar");
  });

  it("infers step type from explicit tag, purpose, then actionType", () => {
    expect(inferTrajectoryLlmStepType({ stepType: "ShouldRespond" })).toBe(
      "should_respond",
    );
    expect(inferTrajectoryLlmStepType({ purpose: "compose_state" })).toBe(
      "compose_state",
    );
    expect(inferTrajectoryLlmStepType({ purpose: "evaluation" })).toBe(
      "evaluation",
    );
    expect(
      inferTrajectoryLlmStepType({ actionType: "orchestrator_plan" }),
    ).toBe("orchestrator");
    expect(inferTrajectoryLlmStepType({ purpose: "action" })).toBe("action");
    expect(inferTrajectoryLlmStepType({ purpose: "custom_slot" })).toBe(
      "custom_slot",
    );
    expect(
      inferTrajectoryLlmStepType({ purpose: "other", actionType: "reply" }),
    ).toBe("reply");
    expect(inferTrajectoryLlmStepType({ purpose: "other" })).toBe("other");
    expect(inferTrajectoryLlmStepType({})).toBe("");
  });

  it("builds tags in input order, then derived tags, skipping duplicates", () => {
    expect(
      inferTrajectoryLlmTags({
        purpose: "should_respond",
        tags: ["LLM", "routing", "llm"],
      }),
    ).toEqual([
      "llm",
      "routing",
      "step:should_respond",
      "purpose:should_respond",
    ]);
    expect(
      inferTrajectoryLlmTags({
        purpose: "compose_state",
        actionType: "orchestrator_plan",
      }),
    ).toEqual([
      "llm",
      "step:compose_state",
      "purpose:compose_state",
      "action:orchestrator_plan",
      "context",
      "orchestrator",
    ]);
    expect(inferTrajectoryLlmTags({ tags: "not-an-array" })).toEqual(["llm"]);
  });

  it("enriches an LLM call with inferred stepType and tags without dropping fields", () => {
    const enriched = enrichTrajectoryLlmCall({
      purpose: "reasoning",
      model: "test-model",
    });
    expect(enriched.purpose).toBe("reasoning");
    expect(enriched.model).toBe("test-model");
    expect(enriched.stepType).toBe("reasoning");
    expect(enriched.tags).toEqual([
      "llm",
      "step:reasoning",
      "purpose:reasoning",
    ]);
  });
});

describe("record, JSON, grouping, and SQL helpers", () => {
  it("readRecordValue returns the first present key and otherwise undefined", () => {
    expect(readRecordValue({ b: 2, a: 1 }, ["a", "b"])).toBe(1);
    expect(readRecordValue({ b: 2 }, ["a", "b"])).toBe(2);
    expect(readRecordValue({ b: undefined }, ["b"])).toBeUndefined();
    expect(readRecordValue({}, ["missing"])).toBeUndefined();
  });

  it("parseJsonValue parses JSON strings and returns non-strings and invalid JSON as-is", () => {
    expect(parseJsonValue({ keep: true })).toEqual({ keep: true });
    expect(parseJsonValue("[1,2]")).toEqual([1, 2]);
    expect(parseJsonValue("not-json")).toBe("not-json");
    expect(parseJsonValue("null")).toBeNull();
  });

  it("parseMetadata returns {} for non-records while parsePersistedMetadata rejects them", () => {
    expect(parseMetadata("[]")).toEqual({});
    expect(parseMetadata(undefined)).toEqual({});
    expect(parseMetadata('{"ok":true}')).toEqual({ ok: true });
    expect(() => parsePersistedMetadata("[]", "traj-1")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }),
    );
    expect(parsePersistedMetadata(null, "traj-1")).toEqual({});
    expect(parsePersistedMetadata('{"n":1}', "traj-1")).toEqual({ n: 1 });
  });

  it("parseSteps accepts empty, arrays, nested objects, and rejects invalid shapes", () => {
    expect(parseSteps(undefined)).toEqual([]);
    expect(parseSteps(null)).toEqual([]);
    expect(parseSteps("[]")).toEqual([]);
    const nested = parseSteps({
      steps: [
        {
          stepId: "s1",
          stepNumber: 0,
          timestamp: 1,
          llmCalls: [],
          providerAccesses: [],
        },
      ],
    });
    expect(nested).toHaveLength(1);
    expect(nested[0]?.stepId).toBe("s1");
    expect(() => parseSteps("nope", "traj-x")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }),
    );
  });

  it("sqlQuote doubles apostrophes and sqlNumber emits NULL for non-finite values", () => {
    expect(sqlQuote("plain")).toBe("'plain'");
    expect(sqlQuote("it's")).toBe("'it''s'");
    expect(sqlNumber(0)).toBe("0");
    expect(sqlNumber(12.5)).toBe("12.5");
    expect(sqlNumber(Number.NaN)).toBe("NULL");
    expect(sqlNumber(Number.POSITIVE_INFINITY)).toBe("NULL");
    expect(sqlNumber(null)).toBe("NULL");
    expect(sqlNumber(undefined)).toBe("NULL");
  });

  it("extractRows is permissive; extractRequiredRows rejects missing row arrays", () => {
    expect(extractRows([1, 2])).toEqual([1, 2]);
    expect(extractRows({ rows: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(extractRows({ rows: "nope" })).toEqual([]);
    expect(extractRows(null)).toEqual([]);
    expect(extractRequiredRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(extractRequiredRows({ rows: [] })).toEqual([]);
    expect(() => extractRequiredRows({ rows: "nope" })).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }),
    );
    expect(() => extractRequiredRows({})).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }),
    );
  });

  it("resolveTrajectoryGrouping and metadata normalization prefer record keys then fallback", () => {
    expect(
      resolveTrajectoryGrouping({ scenario_id: " sc-1 ", batchId: "b-1" }),
    ).toEqual({ scenarioId: "sc-1", batchId: "b-1" });
    expect(
      resolveTrajectoryGrouping(undefined, {
        scenarioId: "fb-sc",
        batchId: "fb-b",
      }),
    ).toEqual({ scenarioId: "fb-sc", batchId: "fb-b" });

    const cleared = normalizeTrajectoryMetadata({
      scenarioId: "   ",
      other: 1,
    });
    expect(cleared.metadata).toEqual({ other: 1 });
    expect(cleared.scenarioId).toBeUndefined();

    const filled = normalizeTrajectoryMetadata(
      { keep: true },
      { scenarioId: "s", batchId: "b" },
    );
    expect(filled.scenarioId).toBe("s");
    expect(filled.batchId).toBe("b");
    expect(filled.metadata.scenarioId).toBe("s");
    expect(filled.metadata.batchId).toBe("b");
  });
});

describe("status, timing, and step ids", () => {
  it("normalizeStatus falls back; parsePersistedTrajectoryStatus rejects unknown values", () => {
    expect(normalizeStatus("ACTIVE", "completed")).toBe("active");
    expect(normalizeStatus("timeout", "completed")).toBe("timeout");
    expect(normalizeStatus("terminated", "completed")).toBe("terminated");
    expect(normalizeStatus("nope", "error")).toBe("error");
    expect(parsePersistedTrajectoryStatus("completed", "t1")).toBe("completed");
    expect(() => parsePersistedTrajectoryStatus("running", "t1")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }),
    );
  });

  it("toOptionalEpochMs accepts numbers and parseable date strings", () => {
    expect(toOptionalEpochMs(1_700)).toBe(1_700);
    expect(toOptionalEpochMs("2020-01-01T00:00:00.000Z")).toBe(
      Date.parse("2020-01-01T00:00:00.000Z"),
    );
    expect(toOptionalEpochMs("not-a-date")).toBeUndefined();
    expect(toOptionalEpochMs(undefined)).toBeUndefined();
  });

  it("normalizePersistedTrajectoryTiming leaves active open and repairs completed rows", () => {
    expect(
      normalizePersistedTrajectoryTiming({
        status: "active",
        startTime: 10,
        endTime: 20,
        durationMs: 10,
      }),
    ).toEqual({ endTime: null, durationMs: null });

    expect(
      normalizePersistedTrajectoryTiming({
        status: "completed",
        startTime: 100,
        endTime: 150,
        durationMs: 50,
      }),
    ).toEqual({ endTime: 150, durationMs: 50 });

    expect(
      normalizePersistedTrajectoryTiming({
        status: "completed",
        startTime: 100,
        endTime: null,
        updatedAt: "1970-01-01T00:00:00.250Z",
      }),
    ).toEqual({ endTime: 250, durationMs: 150 });

    expect(
      normalizePersistedTrajectoryTiming({
        status: "error",
        startTime: 100,
        endTime: 50,
      }),
    ).toEqual({ endTime: 100, durationMs: 0 });
  });

  it("normalizePersistedUpdatedAt prefers updatedAt, then endTime, then createdAt", () => {
    expect(
      normalizePersistedUpdatedAt({
        startTime: 100,
        endTime: 150,
        updatedAt: 200,
        createdAt: 120,
      }),
    ).toBe(new Date(200).toISOString());
    expect(
      normalizePersistedUpdatedAt({
        startTime: 100,
        endTime: 150,
        updatedAt: 90,
      }),
    ).toBe(new Date(150).toISOString());
    expect(
      normalizePersistedUpdatedAt({
        startTime: 100,
        endTime: null,
        createdAt: 180,
      }),
    ).toBe(new Date(180).toISOString());
  });

  it("normalizeStepId trims and rejects non-strings and blanks", () => {
    expect(normalizeStepId("  s-1  ")).toBe("s-1");
    expect(normalizeStepId("")).toBeNull();
    expect(normalizeStepId("   ")).toBeNull();
    expect(normalizeStepId(12)).toBeNull();
    expect(normalizeStepId(null)).toBeNull();
  });
});

describe("embedding suppression and insights", () => {
  it("isNumericVectorString requires brackets and at least eight numeric samples", () => {
    expect(isNumericVectorString("[array]")).toBe(true);
    expect(isNumericVectorString("[]")).toBe(false);
    expect(isNumericVectorString("[1,2,3,4,5,6,7]")).toBe(false);
    expect(isNumericVectorString("[1,2,3,4,5,6,7,8]")).toBe(true);
    expect(isNumericVectorString("[1,2,3,4,5,6,7,abc]")).toBe(false);
    expect(isNumericVectorString("1,2,3,4,5,6,7,8")).toBe(false);
    const seventeen = `[${Array.from({ length: 16 }, (_, i) => i).join(",")},nope]`;
    expect(isNumericVectorString(seventeen)).toBe(true);
  });

  it("shouldSuppressNoInputEmbeddingCall only for embedding calls with empty input", () => {
    expect(
      shouldSuppressNoInputEmbeddingCall({
        model: "text-embedding-3",
        userPrompt: "",
        response: "",
      }),
    ).toBe(true);
    expect(
      shouldSuppressNoInputEmbeddingCall({
        model: "text-embedding-3",
        userPrompt: "hello",
        response: "",
      }),
    ).toBe(false);
    expect(
      shouldSuppressNoInputEmbeddingCall({
        model: "gpt-4",
        userPrompt: "",
        response: "",
      }),
    ).toBe(false);
    expect(
      shouldSuppressNoInputEmbeddingCall({
        purpose: "embed",
        userPrompt: "",
        response: "[1,2,3,4,5,6,7,8]",
      }),
    ).toBe(true);
    expect(
      shouldSuppressNoInputEmbeddingCall({
        actionType: "embed",
        userPrompt: "",
        response: "plain text",
      }),
    ).toBe(false);
  });

  it("extractInsightsFromResponse collects DECISION and keyDecision lines in order", () => {
    expect(
      extractInsightsFromResponse(
        'DECISION: first\nignored\nDECISION: second\n{"keyDecision":"third"}',
        "reply",
      ),
    ).toEqual(["first", "second", "third"]);
    expect(extractInsightsFromResponse("no markers", "reply")).toEqual([]);
    expect(
      extractInsightsFromResponse('{"reasoning":"too-short"}', "coordination"),
    ).toEqual([]);
    expect(
      extractInsightsFromResponse(
        `{"reasoning":"${"long enough reasoning text"}"}`,
        "turn-complete",
      ),
    ).toEqual(["long enough reasoning text"]);
    expect(
      extractInsightsFromResponse(
        `{"reasoning":"${"long enough reasoning text"}"}`,
        "reply",
      ),
    ).toEqual([]);
  });
});

describe("actions, observation gate, and runtime db", () => {
  it("hasActionNamed compares trimmed uppercase names and rejects a non-array", () => {
    const named = runtimeStub({
      actions: [{ name: " reflection " }, { name: "OTHER" }],
    });
    expect(hasActionNamed(named, "REFLECTION")).toBe(true);
    expect(hasActionNamed(named, " missing ")).toBe(false);
    expect(hasActionNamed(runtimeStub({ actions: null }), "REFLECTION")).toBe(
      false,
    );
  });

  it("shouldRunObservationExtraction honors the explicit setting, then REFLECTION", () => {
    expect(
      shouldRunObservationExtraction(
        runtimeStub({ getSetting: () => "false" }),
      ),
    ).toBe(false);
    expect(
      shouldRunObservationExtraction(
        runtimeStub({ getSetting: () => "enabled" }),
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

  it("getRuntimeDb prefers adapter.db, then databaseAdapter.db, and requires execute", () => {
    const execute = async () => [];
    expect(getRuntimeDb(runtimeStub())).toBeNull();
    expect(hasRuntimeDb(runtimeStub())).toBe(false);
    const adapterRuntime = runtimeStub({
      adapter: { db: { execute } },
    });
    expect(getRuntimeDb(adapterRuntime)?.execute).toBe(execute);
    expect(hasRuntimeDb(adapterRuntime)).toBe(true);
    const fallbackRuntime = runtimeStub({
      adapter: {},
      databaseAdapter: { db: { execute } },
    });
    expect(getRuntimeDb(fallbackRuntime)?.execute).toBe(execute);
  });

  it("executeRawSql and executeRawSqlTransaction fail fast without a capable adapter", async () => {
    await expect(executeRawSql(runtimeStub(), "SELECT 1")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(
      executeRawSqlTransaction(runtimeStub(), async () => 1),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TRANSACTION_UNAVAILABLE" }),
    );
  });

  it("warnRuntime is a no-op when logger.warn is missing and otherwise forwards", () => {
    const messages: unknown[] = [];
    warnRuntime(runtimeStub({ logger: {} }), "silent");
    warnRuntime(
      runtimeStub({
        logger: {
          warn: (meta: unknown, message: unknown) => {
            messages.push([meta, message]);
          },
        },
      }),
      "heard",
      new Error("cause"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual([
      expect.objectContaining({
        src: "eliza",
        subsystem: "trajectory-db",
      }),
      "heard",
    ]);
  });
});

describe("trajectory logger scoring", () => {
  it("treats a logger as legacy only when both list and detail functions exist", () => {
    expect(
      isLegacyTrajectoryLogger({
        listTrajectories: () => undefined,
        getTrajectoryDetail: () => undefined,
      }),
    ).toBe(true);
    expect(
      isLegacyTrajectoryLogger({ listTrajectories: () => undefined }),
    ).toBe(false);
    expect(isLegacyTrajectoryLogger({})).toBe(false);
  });

  it("returns null for an empty candidate queue", async () => {
    expect(await resolveTrajectoryLogger(runtimeStub())).toBeNull();
  });

  it("scores a legacy logger above capture-only loggers and keeps the first on a tie", async () => {
    const captureOnly: TrajectoryLoggerLike = {
      logLlmCall: () => undefined,
    };
    const alsoCapture: TrajectoryLoggerLike = {
      logLlmCall: () => undefined,
      logProviderAccess: () => undefined,
    };
    const legacy: TrajectoryLoggerLike = {
      listTrajectories: () => undefined,
      getTrajectoryDetail: () => undefined,
    };
    const winner = await resolveTrajectoryLogger(
      runtimeStub({
        getServicesByType: () => [captureOnly, alsoCapture, legacy],
        getService: () => captureOnly,
      }),
    );
    expect(winner).toBe(legacy);

    const sameScore: TrajectoryLoggerLike = {
      logLlmCall: () => undefined,
    };
    const tied = await resolveTrajectoryLogger(
      runtimeStub({
        getServicesByType: () => [captureOnly, sameScore],
        getService: () => null,
      }),
    );
    expect(tied).toBe(captureOnly);
  });

  it("accepts a single non-array getServicesByType result and dedupes getService", async () => {
    const only: TrajectoryLoggerLike = {
      logProviderAccess: () => undefined,
    };
    expect(
      await resolveTrajectoryLogger(
        runtimeStub({
          getServicesByType: () => only,
          getService: () => only,
        }),
      ),
    ).toBe(only);
  });
});

describe("enqueueStepWrite queueing", () => {
  it("runs a single write and removes it from the empty-after-complete map", async () => {
    const rt = runtimeStub();
    const seen: string[] = [];
    await enqueueStepWrite(rt, "s1", async () => {
      seen.push("one");
    });
    expect(seen).toEqual(["one"]);
    expect(stepWriteQueues.get(rt as object)?.has("s1")).toBeFalsy();
  });

  it("serializes writes for the same stepId even when the first is still in flight", async () => {
    const rt = runtimeStub();
    const order: number[] = [];
    const hold = deferred();
    const firstStarted = deferred();
    const first = enqueueStepWrite(rt, "shared", async () => {
      firstStarted.resolve();
      await hold.promise;
      order.push(1);
    });
    await firstStarted.promise;
    const second = enqueueStepWrite(rt, "shared", async () => {
      order.push(2);
    });
    hold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(stepWriteQueues.get(rt as object)?.has("shared")).toBeFalsy();
  });

  it("lets a later write on the same stepId run after a prior failure", async () => {
    const rt = runtimeStub();
    await expect(
      enqueueStepWrite(rt, "s-fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const recovered: string[] = [];
    await enqueueStepWrite(rt, "s-fail", async () => {
      recovered.push("ok");
    });
    expect(recovered).toEqual(["ok"]);
  });
});

describe("createBaseTrajectory, ensureStep, mergeMetadata, and summaries", () => {
  it("createBaseTrajectory defaults source, seeds one step, and copies grouping", () => {
    const trajectory = createBaseTrajectory("s-new", 1_000, "agent-1", "  ", {
      scenarioId: "sc",
      extra: true,
    });
    expect(trajectory.source).toBe("runtime");
    expect(trajectory.status).toBe("active");
    expect(trajectory.endTime).toBeNull();
    expect(trajectory.scenarioId).toBe("sc");
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.stepId).toBe("s-new");
    expect(trajectory.rewardComponents).toEqual({ environmentReward: 0 });
  });

  it("ensureStep returns the existing step and appends a missing one at the next ordinal", () => {
    const trajectory = createBaseTrajectory("s-new", 1_000, "agent-1");
    const existing = ensureStep(trajectory, "s-new", 2_000);
    expect(existing.stepNumber).toBe(0);
    expect(existing.timestamp).toBe(1_000);
    const added = ensureStep(trajectory, "s-missing", 3_000);
    expect(added.stepId).toBe("s-missing");
    expect(added.stepNumber).toBe(1);
    expect(trajectory.steps).toHaveLength(2);
  });

  it("mergeMetadata ignores undefined incoming values and normalizes grouping keys", () => {
    const existing = { keep: 1, dropMe: 2 };
    expect(mergeMetadata(existing)).toBe(existing);
    expect(
      mergeMetadata(existing, {
        dropMe: undefined,
        add: "yes",
        scenarioId: "s",
      }),
    ).toEqual({ keep: 1, dropMe: 2, add: "yes", scenarioId: "s" });
  });

  it("collectTrajectoryTimestamps and summarizeTrajectory handle empty, single, and multi-step rows", () => {
    const empty: PersistedTrajectory = {
      id: "s0",
      agentId: "agent-1",
      source: "runtime",
      status: "active",
      startTime: Number.NaN,
      endTime: null,
      steps: [],
      metadata: {},
      metrics: {},
      rewardComponents: { environmentReward: 0 },
      totalReward: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const before = Date.now();
    const emptySummary = summarizeTrajectory(empty);
    const after = Date.now();
    expect(collectTrajectoryTimestamps(empty)).toEqual([]);
    expect(emptySummary.startTime).toBeGreaterThanOrEqual(before);
    expect(emptySummary.startTime).toBeLessThanOrEqual(after);
    expect(emptySummary.endTime).toBe(emptySummary.startTime);
    expect(emptySummary.llmCallCount).toBe(0);

    const single = createBaseTrajectory("s0", 100, "agent-1");
    expect(collectTrajectoryTimestamps(single)).toEqual([100, 100]);
    expect(summarizeTrajectory(single)).toMatchObject({
      startTime: 100,
      endTime: 100,
      llmCallCount: 0,
      providerAccessCount: 0,
    });

    const multi = createBaseTrajectory("s0", 100, "agent-1");
    const extra = ensureStep(multi, "s1", 400);
    extra.llmCalls.push({
      callId: "c1",
      timestamp: 250,
      model: "m",
      response: "ok",
      purpose: "action",
      actionType: "reply",
      promptTokens: 3,
      completionTokens: 5,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 2,
    });
    extra.providerAccesses.push({
      providerId: "p1",
      providerName: "world",
      timestamp: 500,
      purpose: "lookup",
      data: {},
    });
    expect(collectTrajectoryTimestamps(multi)).toEqual([
      100, 100, 400, 250, 500,
    ]);
    expect(summarizeTrajectory(multi)).toEqual({
      startTime: 100,
      endTime: 500,
      llmCallCount: 1,
      providerAccessCount: 1,
      totalPromptTokens: 3,
      totalCompletionTokens: 5,
      totalCacheReadInputTokens: 1,
      totalCacheCreationInputTokens: 2,
    });
  });
});

describe("persisted parsers", () => {
  it("parsePersistedEvaluatorName and skill invocations reject invalid shapes", () => {
    expect(parsePersistedEvaluatorName(undefined)).toBeUndefined();
    expect(parsePersistedEvaluatorName("judge")).toBe("judge");
    expect(() => parsePersistedEvaluatorName("  ")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_EVALUATOR_NAME_INVALID" }),
    );
    expect(parsePersistedSkillInvocations(undefined)).toBeUndefined();
    expect(() => parsePersistedSkillInvocations({})).toThrowError(
      expect.objectContaining({
        code: "TRAJECTORY_SKILL_INVOCATIONS_INVALID",
      }),
    );
    expect(
      parsePersistedSkillInvocations([
        {
          skillSlug: "search",
          durationMs: 12,
          parentStepId: "s1",
          success: true,
          startedAt: 1,
          mode: "script",
        },
      ]),
    ).toEqual([
      {
        skillSlug: "search",
        durationMs: 12,
        parentStepId: "s1",
        success: true,
        startedAt: 1,
        mode: "script",
      },
    ]);
    expect(() =>
      parsePersistedSkillInvocations([
        {
          skillSlug: "search",
          durationMs: 12,
          parentStepId: "s1",
          success: true,
          startedAt: 1,
          mode: "other",
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_SKILL_INVOCATION_INVALID" }),
    );
  });

  it("parsePersistedLlmCall and parsePersistedProviderAccess require identity fields", () => {
    expect(
      parsePersistedLlmCall(
        {
          callId: "c1",
          timestamp: 1,
          model: "m",
          response: "",
          purpose: "action",
          actionType: "reply",
        },
        "t1",
        "s1",
        0,
      ),
    ).toMatchObject({ callId: "c1", response: "" });
    expect(() =>
      parsePersistedLlmCall({ model: "m" }, "t1", "s1", 0),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));

    expect(
      parsePersistedProviderAccess(
        {
          providerId: "p1",
          providerName: "world",
          timestamp: 2,
          purpose: "lookup",
          data: { k: 1 },
        },
        "t1",
        "s1",
        0,
      ),
    ).toMatchObject({ providerId: "p1", data: { k: 1 } });
    expect(() =>
      parsePersistedProviderAccess(
        {
          providerId: "p1",
          providerName: "world",
          timestamp: 2,
          purpose: "lookup",
          data: "nope",
        },
        "t1",
        "s1",
        0,
      ),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));
  });

  it("parsePersistedStepObject accepts empty captures and rejects bad ordinals and kinds", () => {
    const step = parsePersistedStepObject(
      {
        stepId: "s1",
        stepNumber: 0,
        timestamp: 1,
        llmCalls: [],
        providerAccesses: [],
      },
      "t1",
      0,
    );
    expect(step.stepId).toBe("s1");
    expect(step.llmCalls).toEqual([]);
    expect(() =>
      parsePersistedStepObject(
        {
          stepId: "s1",
          stepNumber: -1,
          timestamp: 1,
          llmCalls: [],
          providerAccesses: [],
        },
        "t1",
        0,
      ),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));
    expect(() =>
      parsePersistedStepObject(
        {
          stepId: "s1",
          stepNumber: 0,
          timestamp: 1,
          llmCalls: [],
          providerAccesses: [],
          kind: "other",
        },
        "t1",
        0,
      ),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));
  });

  it("parsePersistedTrajectoryRow enforces active/completed timing and fills environmentReward", () => {
    const completed = parsePersistedTrajectoryRow(
      {
        id: "t1",
        agent_id: "agent-1",
        source: "runtime",
        status: "completed",
        start_time: 100,
        end_time: 150,
        duration_ms: 50,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.150Z",
        steps_json: "[]",
        metadata_json: "{}",
        metrics_json: "{}",
        reward_components_json: "{}",
        total_reward: 4,
      },
      "t1",
    );
    expect(completed.endTime).toBe(150);
    expect(completed.rewardComponents.environmentReward).toBe(4);

    const active = parsePersistedTrajectoryRow(
      {
        id: "t2",
        agent_id: "agent-1",
        source: "runtime",
        status: "active",
        start_time: 100,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        steps_json: "[]",
        metadata_json: "{}",
        metrics_json: "{}",
        reward_components_json: "{}",
        total_reward: 0,
      },
      "t2",
    );
    expect(active.endTime).toBeNull();

    expect(() =>
      parsePersistedTrajectoryRow(
        {
          id: "t3",
          agent_id: "agent-1",
          source: "runtime",
          status: "active",
          start_time: 100,
          end_time: 150,
          duration_ms: 50,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.150Z",
          steps_json: "[]",
          metadata_json: "{}",
          metrics_json: "{}",
          reward_components_json: "{}",
          total_reward: 0,
        },
        "t3",
      ),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));

    expect(() =>
      parsePersistedTrajectoryRow(
        {
          id: "t4",
          agent_id: "agent-1",
          source: "runtime",
          status: "completed",
          start_time: 100,
          end_time: 150,
          duration_ms: 49,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.150Z",
          steps_json: "[]",
          metadata_json: "{}",
          metrics_json: "{}",
          reward_components_json: "{}",
          total_reward: 0,
        },
        "t4",
      ),
    ).toThrowError(expect.objectContaining({ code: "TRAJECTORY_ROW_INVALID" }));
  });
});

describe("SQL upsert generation and ownership asserts", () => {
  it("buildTrajectoryStepUpsertSql quotes identifiers and defaults kind to llm", () => {
    const sql = buildTrajectoryStepUpsertSql("traj-1", validStep());
    expect(sql).toContain("INSERT INTO trajectory_steps");
    expect(sql).toContain("'step-1'");
    expect(sql).toContain("'traj-1'");
    expect(sql).toContain("'llm'");
    expect(sql).toContain("script");
    expect(sql).toContain("DO UPDATE SET");
    expect(sql).not.toContain("DO NOTHING");
  });

  it("buildTrajectoryStepUpsertSql honors DO NOTHING and evaluator names", () => {
    const sql = buildTrajectoryStepUpsertSql(
      "traj-1",
      validStep({
        kind: "evaluator",
        evaluatorName: "quality",
        script: "echo hi",
        parentStepId: "parent-1",
      }),
      undefined,
      "DO NOTHING",
    );
    expect(sql).toContain("DO NOTHING");
    expect(sql).toContain("'evaluator'");
    expect(sql).toContain("'quality'");
    expect(sql).toContain("'echo hi'");
    expect(sql).toContain("'parent-1'");
  });

  it("assertTrajectoryStepOwnership allows a missing row and rejects a foreign owner", async () => {
    await expect(
      assertTrajectoryStepOwnership(sqlExecutor({ rows: [] }), "t1", "s1"),
    ).resolves.toBeUndefined();
    await expect(
      assertTrajectoryStepOwnership(
        sqlExecutor({ rows: [{ trajectory_id: "other" }] }),
        "t1",
        "s1",
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT" }),
    );
  });

  it("assertTrajectoryAgentOwnership distinguishes missing, foreign, and matching owners", async () => {
    await expect(
      assertTrajectoryAgentOwnership(
        sqlExecutor({ rows: [] }),
        "t1",
        "agent-1",
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertTrajectoryAgentOwnership(
        sqlExecutor({ rows: [] }),
        "t1",
        "agent-1",
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_PARENT_NOT_FOUND" }),
    );
    await expect(
      assertTrajectoryAgentOwnership(
        sqlExecutor({ rows: [{ agent_id: "other" }] }),
        "t1",
        "agent-1",
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
      }),
    );
    await expect(
      assertTrajectoryAgentOwnership(
        sqlExecutor({ rows: [{ agent_id: "agent-1" }] }),
        "t1",
        "agent-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("assertTrajectoryStepParentOwnership skips missing parents and rejects self or foreign parents", async () => {
    await expect(
      assertTrajectoryStepParentOwnership(
        sqlExecutor({ rows: [] }),
        "t1",
        validStep(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertTrajectoryStepParentOwnership(sqlExecutor({ rows: [] }), "t1", {
        ...validStep(),
        parentStepId: "step-1",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_STEP_PARENT_INVALID" }),
    );
    await expect(
      assertTrajectoryStepParentOwnership(
        sqlExecutor({ rows: [{ trajectory_id: "other" }] }),
        "t1",
        { ...validStep(), parentStepId: "parent-1" },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_STEP_PARENT_INVALID" }),
    );
    await expect(
      assertTrajectoryStepParentOwnership(
        sqlExecutor({ rows: [{ trajectory_id: "t1" }] }),
        "t1",
        { ...validStep(), parentStepId: "parent-1" },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("provider capture, orchestrator context, and archive helpers", () => {
  it("normalizeProviderAccessPayload accepts both call shapes and rejects empty or invalid payloads", () => {
    const details = {
      providerName: "world",
      purpose: "lookup",
      data: { k: 1 },
    };
    expect(normalizeProviderAccessPayload(["s-1", details])?.stepId).toBe(
      "s-1",
    );
    expect(
      normalizeProviderAccessPayload([{ stepId: "s-2", ...details }])?.stepId,
    ).toBe("s-2");
    expect(() => normalizeProviderAccessPayload([])).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }),
    );
    expect(() =>
      normalizeProviderAccessPayload([{ stepId: "  ", ...details }]),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }),
    );
    expect(() =>
      normalizeProviderAccessPayload([
        { stepId: "s-3", providerName: "world", purpose: "lookup", data: 1 },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }),
    );
  });

  it("readOrchestratorTrajectoryContext requires source=orchestrator and a decisionType", () => {
    expect(readOrchestratorTrajectoryContext(null)).toBeUndefined();
    expect(readOrchestratorTrajectoryContext({})).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: { source: "runtime", decisionType: "x" },
      }),
    ).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: { source: "orchestrator" },
      }),
    ).toBeUndefined();
    expect(
      readOrchestratorTrajectoryContext({
        __orchestratorTrajectoryCtx: {
          source: "orchestrator",
          decisionType: "observation-extraction",
          repo: "elizaOS/eliza",
        },
      }),
    ).toEqual({
      source: "orchestrator",
      decisionType: "observation-extraction",
      repo: "elizaOS/eliza",
    });
  });

  it("formats archive timestamps and stringifies bigint rows", () => {
    expect(TRAJECTORY_ARCHIVE_DIRNAME).toBe("trajectory-archive");
    expect(toArchiveSafeTimestamp("2026-08-23T12:00:00.000Z")).toBe(
      "2026-08-23T12-00-00-000Z",
    );
    expect(stringifyArchiveRow({ n: 1n, s: "ok" })).toBe('{"n":"1","s":"ok"}');
  });

  it("resolvePreferredTrajectoryArchiveRoot prefers workspace dir, then root", () => {
    const prevDir = process.env.ELIZA_WORKSPACE_DIR;
    const prevRoot = process.env.ELIZA_WORKSPACE_ROOT;
    try {
      process.env.ELIZA_WORKSPACE_DIR = " /tmp/ws-dir ";
      process.env.ELIZA_WORKSPACE_ROOT = "/tmp/ws-root";
      expect(resolvePreferredTrajectoryArchiveRoot()).toBe("/tmp/ws-dir");
      delete process.env.ELIZA_WORKSPACE_DIR;
      expect(resolvePreferredTrajectoryArchiveRoot()).toBe("/tmp/ws-root");
    } finally {
      if (prevDir === undefined) delete process.env.ELIZA_WORKSPACE_DIR;
      else process.env.ELIZA_WORKSPACE_DIR = prevDir;
      if (prevRoot === undefined) delete process.env.ELIZA_WORKSPACE_ROOT;
      else process.env.ELIZA_WORKSPACE_ROOT = prevRoot;
    }
  });
});

describe("appendCompleteTrajectoryTextRecords empty and single-element queues", () => {
  it("treats undefined existing as an empty queue and preserves a single addition", () => {
    expect(
      appendCompleteTrajectoryTextRecords(undefined, [], "insights"),
    ).toEqual([]);
    expect(
      appendCompleteTrajectoryTextRecords(undefined, ["only"], "insights"),
    ).toEqual(["only"]);
    expect(
      appendCompleteTrajectoryTextRecords(["keep"], ["next"], "insights"),
    ).toEqual(["keep", "next"]);
  });
});
