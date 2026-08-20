/**
 * Deterministic unit tests for the sampled Shared-turn trace recorder: the
 * FNV-1a sampling decision (no randomness — same id, same verdict), the
 * defensive `SHARED_TURN_TRACES_SAMPLE` parse/clamp, the exact-match
 * `SHARED_TURN_TRACES_ENABLED` gate, the J7 no-throw insert failure path, and
 * the privacy contract that `buildTurnSummary` never copies prompt/reply text
 * into the persisted stages. Fully mocked deps (an injected insertTrace and
 * env map); no database or model is involved.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NewSharedTurnTraceRow } from "../../../db/schemas/shared-turn-traces";
import type { RunSharedAgentTurnResult } from "./run-shared-agent-turn";
import {
  buildTurnSummary,
  DEFAULT_SHARED_TURN_TRACES_SAMPLE,
  isSharedTurnTraceSampled,
  recordSharedTurnTrace,
  resolveSharedTurnTraceSampleRate,
  type SharedTurnSummary,
} from "./shared-turn-trace-recorder";

const ORG_ID = "0b6f9dd2-6a2f-4d55-b552-8f4f7bfb9f01";
const USER_ID = "4e2ffab7-9f21-4a2c-92b7-33dd25c7f8a2";

function summaryFixture(overrides: Partial<SharedTurnSummary> = {}): SharedTurnSummary {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: "agent-1",
    channelId: "shared:agent-1:room",
    traceId: "trace-1",
    startedAt: 1_787_860_800_000,
    latencyMs: 812,
    model: "gemma-4-31b",
    usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168 },
    finishReason: "reply",
    stages: [{ name: "model" }],
    ...overrides,
  };
}

describe("resolveSharedTurnTraceSampleRate", () => {
  test("defaults when unset or blank and clamps finite values into [0, 1]", () => {
    expect(resolveSharedTurnTraceSampleRate(undefined)).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("   ")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("0.25")).toBe(0.25);
    expect(resolveSharedTurnTraceSampleRate("0")).toBe(0);
    expect(resolveSharedTurnTraceSampleRate("1")).toBe(1);
    expect(resolveSharedTurnTraceSampleRate("2")).toBe(1);
    expect(resolveSharedTurnTraceSampleRate("-3")).toBe(0);
  });

  test("garbage input falls back to the default instead of a fake-valid rate", () => {
    expect(resolveSharedTurnTraceSampleRate("ten percent")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("0.1abc")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("NaN")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
    expect(resolveSharedTurnTraceSampleRate("Infinity")).toBe(DEFAULT_SHARED_TURN_TRACES_SAMPLE);
  });
});

describe("isSharedTurnTraceSampled", () => {
  test("is deterministic: the same trace id always gets the same verdict", () => {
    for (const traceId of ["trace-a", "trace-b", "5f2c", "", "🌊"]) {
      const first = isSharedTurnTraceSampled(traceId, 0.1);
      for (let i = 0; i < 5; i += 1) {
        expect(isSharedTurnTraceSampled(traceId, 0.1)).toBe(first);
      }
    }
  });

  test("rate 0 keeps nothing and rate 1 keeps everything", () => {
    for (const traceId of ["a", "b", "c", "trace-42"]) {
      expect(isSharedTurnTraceSampled(traceId, 0)).toBe(false);
      expect(isSharedTurnTraceSampled(traceId, 1)).toBe(true);
    }
  });

  test("keeps roughly the requested fraction of a deterministic id population", () => {
    let kept = 0;
    const total = 2000;
    for (let i = 0; i < total; i += 1) {
      if (isSharedTurnTraceSampled(`turn-${i}`, 0.1)) kept += 1;
    }
    // FNV-1a spreads uniformly enough that 10% of 2000 ids lands well inside
    // [5%, 15%]; the exact count is stable because nothing here is random.
    expect(kept).toBeGreaterThan(total * 0.05);
    expect(kept).toBeLessThan(total * 0.15);
  });
});

describe("recordSharedTurnTrace gating", () => {
  test('is a no-op unless SHARED_TURN_TRACES_ENABLED is exactly "true"', async () => {
    for (const enabled of [undefined, "", "1", "TRUE", "True", "yes", "false"]) {
      const insertTrace = mock(async (_trace: NewSharedTurnTraceRow) => {});
      const recorded = await recordSharedTurnTrace(
        {
          insertTrace,
          env: { SHARED_TURN_TRACES_ENABLED: enabled, SHARED_TURN_TRACES_SAMPLE: "1" },
        },
        summaryFixture(),
      );
      expect(recorded).toBe(false);
      expect(insertTrace).not.toHaveBeenCalled();
    }
  });

  test("drops unsampled traces without touching storage", async () => {
    const insertTrace = mock(async (_trace: NewSharedTurnTraceRow) => {});
    const recorded = await recordSharedTurnTrace(
      { insertTrace, env: { SHARED_TURN_TRACES_ENABLED: "true", SHARED_TURN_TRACES_SAMPLE: "0" } },
      summaryFixture(),
    );
    expect(recorded).toBe(false);
    expect(insertTrace).not.toHaveBeenCalled();
  });

  test("persists a sampled trace with tenant scope, timing, and compact payloads", async () => {
    const inserted: NewSharedTurnTraceRow[] = [];
    const insertTrace = mock(async (trace: NewSharedTurnTraceRow) => {
      inserted.push(trace);
    });
    const recorded = await recordSharedTurnTrace(
      { insertTrace, env: { SHARED_TURN_TRACES_ENABLED: "true", SHARED_TURN_TRACES_SAMPLE: "1" } },
      summaryFixture({
        stages: [{ name: "model" }, { name: "action", tool: "WEB_SEARCH", durationMs: 240 }],
        terminalTiming: {
          traceId: "trace-1",
          outcome: "success",
          historyMessageCount: 2,
          phases: {
            edgeContextDurationMs: 10,
            runtimeInitializeDurationMs: 20,
            connectionDurationMs: 5,
            historyProjectionDurationMs: 3,
          },
          offsets: {
            providerDispatchOffsetMs: 30,
            providerFirstTextOffsetMs: 80,
            completedOffsetMs: 120,
          },
          inference: {
            composeStateDurationMs: 4,
            shouldRespondAndContextDurationMs: 6,
            responseHandlerFieldsDurationMs: 2,
            providerTotalDurationMs: 40,
            slowestProviderDurationMs: 30,
          },
          routing: { decision: "respond", contextIds: ["simple"] },
        },
      }),
    );
    expect(recorded).toBe(true);
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.organization_id).toBe(ORG_ID);
    expect(row.user_id).toBe(USER_ID);
    expect(row.agent_id).toBe("agent-1");
    expect(row.channel_id).toBe("shared:agent-1:room");
    expect(row.trace_id).toBe("trace-1");
    expect(row.started_at).toEqual(new Date(1_787_860_800_000));
    expect(row.latency_ms).toBe(812);
    expect(row.model).toBe("gemma-4-31b");
    expect(row.usage).toEqual({ inputTokens: 120, outputTokens: 48, totalTokens: 168 });
    expect(row.stages).toEqual({
      finishReason: "reply",
      stages: [{ name: "model" }, { name: "action", tool: "WEB_SEARCH", durationMs: 240 }],
      terminalTiming: expect.objectContaining({
        traceId: "trace-1",
        outcome: "success",
      }),
    });
  });

  test("a missing channel id persists as an explicit null, and no usage stays absent", async () => {
    const inserted: NewSharedTurnTraceRow[] = [];
    const insertTrace = mock(async (trace: NewSharedTurnTraceRow) => {
      inserted.push(trace);
    });
    await recordSharedTurnTrace(
      { insertTrace, env: { SHARED_TURN_TRACES_ENABLED: "true", SHARED_TURN_TRACES_SAMPLE: "1" } },
      summaryFixture({ channelId: undefined, usage: undefined }),
    );
    expect(inserted[0].channel_id).toBeNull();
    expect("usage" in inserted[0]).toBe(false);
  });

  test("a failed insert is swallowed as diagnostics loss, never thrown (J7)", async () => {
    const insertTrace = mock(async (_trace: NewSharedTurnTraceRow) => {
      throw new Error("db down");
    });
    const recorded = await recordSharedTurnTrace(
      { insertTrace, env: { SHARED_TURN_TRACES_ENABLED: "true", SHARED_TURN_TRACES_SAMPLE: "1" } },
      summaryFixture(),
    );
    expect(recorded).toBe(false);
    expect(insertTrace).toHaveBeenCalledTimes(1);
  });
});

describe("buildTurnSummary compaction", () => {
  const PROMPT_TEXT = "please book me a flight to Tokyo tomorrow morning";
  const REPLY_TEXT = "Here is the plan I drafted for your Tokyo trip";

  function turnResult(overrides: Partial<RunSharedAgentTurnResult> = {}): RunSharedAgentTurnResult {
    return {
      reply: REPLY_TEXT,
      history: [
        { role: "user", content: PROMPT_TEXT },
        { role: "assistant", content: REPLY_TEXT },
      ],
      model: "gemma-4-31b",
      degraded: false,
      usage: { inputTokens: 10, outputTokens: 20 },
      ...overrides,
    };
  }

  const identity = {
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: "agent-1",
    channelId: "shared:agent-1:room",
    traceId: "trace-9",
    startedAt: 1_787_860_800_000,
    completedAt: 1_787_860_801_250,
  };

  test("derives model + action stages with tool names and never copies text", () => {
    const summary = buildTurnSummary({
      result: turnResult({
        actionResults: [
          {
            success: true,
            text: `searched the web for "${PROMPT_TEXT}"`,
            userFacingText: REPLY_TEXT,
            data: { actionName: "WEB_SEARCH" },
          },
          { success: true, data: { actionName: "TODO" } },
          { success: false },
        ],
      }),
      ...identity,
    });
    expect(summary.finishReason).toBe("reply");
    expect(summary.stages).toEqual([
      { name: "model" },
      { name: "action", tool: "WEB_SEARCH" },
      { name: "action", tool: "TODO" },
      { name: "action" },
    ]);
    expect(summary.latencyMs).toBe(1250);
    expect(summary.model).toBe("gemma-4-31b");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(PROMPT_TEXT);
    expect(serialized).not.toContain(REPLY_TEXT);
    expect(serialized).not.toContain("Tokyo");
  });

  test("caps the action stage list so a pathological turn stays compact", () => {
    const summary = buildTurnSummary({
      result: turnResult({
        actionResults: Array.from({ length: 40 }, (_, i) => ({
          success: true,
          data: { actionName: `ACTION_${i}` },
        })),
      }),
      ...identity,
    });
    // 1 model stage + the capped action stages.
    expect(summary.stages.length).toBe(17);
  });

  test("classifies capability-wall turns by capability label only", () => {
    const summary = buildTurnSummary({
      result: turnResult({
        model: "capability-wall",
        capabilityWall: {
          capability: "reminders",
          label: "Reminders",
          reply: "Reminders need Dedicated — but I can draft the reminder text for you.",
        },
      }),
      ...identity,
    });
    expect(summary.finishReason).toBe("capability-wall");
    expect(summary.stages).toEqual([{ name: "capability-wall", tool: "reminders" }]);
    expect(JSON.stringify(summary)).not.toContain("Dedicated");
  });

  test("classifies the designed no-model unavailable state as degraded", () => {
    const summary = buildTurnSummary({
      result: turnResult({ model: "none", degraded: true, usage: undefined }),
      ...identity,
    });
    expect(summary.finishReason).toBe("degraded");
    expect(summary.stages).toEqual([{ name: "unavailable" }]);
    expect(summary.usage).toBeUndefined();
  });

  test("negative clock skew clamps latency to zero instead of a fake negative", () => {
    const summary = buildTurnSummary({
      result: turnResult(),
      ...identity,
      completedAt: identity.startedAt - 500,
    });
    expect(summary.latencyMs).toBe(0);
  });
});
