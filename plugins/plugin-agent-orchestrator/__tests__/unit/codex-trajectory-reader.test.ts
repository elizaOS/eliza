/**
 * Tests for the Codex CLI trajectory reader + merger (W1-T2, closes C1
 * Codex path). Covers:
 *
 *   1. Path resolution under `$CODEX_HOME/sessions/...` and the flat fallback.
 *   2. JSONL parsing of real-shape Codex rollouts (response_item.message,
 *      reasoning, function_call/output; event_msg agent_message + token_count;
 *      malformed-line tolerance).
 *   3. Normalization into trajectory step records that line up with the
 *      Claude Code shape so downstream consumers stay agent-agnostic.
 *   4. End-to-end merge into a mocked trajectory logger, asserting the
 *      parent step's `childSteps[]` is appended and the steps land with
 *      the right kind / model / usage.
 *   5. Degraded-capture behavior: missing rollout → last-message-only path;
 *      missing both → reason="missing".
 *   6. Interactive-mode skip is enforced at the PTY layer (not this reader),
 *      so the reader does the right thing when called: it tries discovery
 *      and reports the result.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeCodexSessionIntoTrajectory,
  tagParentTrajectoryWithDegradedCodexCapture,
} from "../../src/services/codex-trajectory-merger.js";
import {
  findCodexRolloutFile,
  normalizeCodexEvents,
  parseCodexRolloutFile,
  parseCodexSessionLine,
  readCodexSession,
} from "../../src/services/codex-trajectory-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFixtureRolloutJsonl(): string {
  // Shape modeled after a real Codex `codex exec` rollout. Includes:
  //  - session_meta header (carries sessionId)
  //  - turn_context (carries model)
  //  - event_msg task_started
  //  - response_item.message developer (must be ignored — not assistant)
  //  - response_item.reasoning (with summary; plain text path)
  //  - response_item.message assistant commentary
  //  - response_item.function_call (Grep-shaped tool call)
  //  - response_item.function_call_output (paired tool result)
  //  - event_msg.token_count (cumulative usage)
  //  - response_item.message assistant final answer
  //  - event_msg task_complete (last_agent_message)
  //  - one queue-op housekeeping row we must ignore
  //  - one deliberately malformed line we must skip without throwing
  const lines = [
    {
      timestamp: "2026-04-21T01:34:34.308Z",
      type: "session_meta",
      payload: {
        id: "codex-session-fixture-1",
        timestamp: "2026-04-21T01:34:34.000Z",
        cwd: "/tmp/codex-fixture",
        cli_version: "0.100.0",
        model_provider: "openai",
      },
    },
    {
      timestamp: "2026-04-21T01:34:34.500Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: "/tmp/codex-fixture",
        model: "gpt-5.3-codex",
        effort: "high",
      },
    },
    {
      timestamp: "2026-04-21T01:34:34.700Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
        model_context_window: 200000,
      },
    },
    {
      timestamp: "2026-04-21T01:34:34.800Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "<permissions>...</permissions>" },
        ],
      },
    },
    {
      timestamp: "2026-04-21T01:34:35.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need to grep first." }],
        content: null,
      },
    },
    {
      timestamp: "2026-04-21T01:34:35.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Looking up the symbol now.",
          },
        ],
        phase: "commentary",
      },
    },
    {
      timestamp: "2026-04-21T01:34:35.400Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({
          cmd: "rg --files openExternalUrl",
          workdir: "/tmp/codex-fixture",
        }),
        call_id: "call_FdhLfH",
      },
    },
    {
      timestamp: "2026-04-21T01:34:35.500Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_FdhLfH",
        output: "Process exited with code 0\nOutput:\nsrc/a.ts\nsrc/b.ts\n",
      },
    },
    {
      timestamp: "2026-04-21T01:34:35.700Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 250,
            reasoning_output_tokens: 100,
            total_tokens: 1550,
          },
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            output_tokens: 250,
            reasoning_output_tokens: 100,
            total_tokens: 1550,
          },
          model_context_window: 200000,
        },
        rate_limits: { limit_id: "codex", limit_name: null },
      },
    },
    {
      timestamp: "2026-04-21T01:34:36.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Found openExternalUrl in src/a.ts and src/b.ts.",
          },
        ],
        phase: "final",
      },
    },
    {
      timestamp: "2026-04-21T01:34:36.200Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "Found openExternalUrl in src/a.ts and src/b.ts.",
      },
    },
    {
      timestamp: "2026-04-21T01:34:36.300Z",
      type: "queue-operation",
      payload: { operation: "drain" },
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{not json}\n`;
}

describe("codex-trajectory-reader: path resolution", () => {
  it("returns null when no codex sessions dir exists", async () => {
    const codexHome = await makeTempDir("codex-empty-");
    await expect(findCodexRolloutFile(codexHome)).resolves.toBeNull();
  });

  it("locates the most recent rollout under sessions/YYYY/MM/DD", async () => {
    const codexHome = await makeTempDir("codex-canon-");
    const nestedDir = join(codexHome, "sessions", "2026", "04", "21");
    await mkdir(nestedDir, { recursive: true });
    const older = join(nestedDir, "rollout-older.jsonl");
    const newer = join(nestedDir, "rollout-newer.jsonl");
    await writeFile(older, "");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(newer, "");
    const located = await findCodexRolloutFile(codexHome);
    expect(located?.filePath).toBe(newer);
  });

  it("falls back to flat sessions/*.jsonl layout", async () => {
    const codexHome = await makeTempDir("codex-flat-");
    const flatDir = join(codexHome, "sessions");
    await mkdir(flatDir, { recursive: true });
    const file = join(flatDir, "rollout-flat.jsonl");
    await writeFile(file, "");
    const located = await findCodexRolloutFile(codexHome);
    expect(located?.filePath).toBe(file);
  });
});

describe("codex-trajectory-reader: parsing", () => {
  it("returns null for blank, junk, or non-object lines", () => {
    expect(parseCodexSessionLine("")).toBeNull();
    expect(parseCodexSessionLine("   ")).toBeNull();
    expect(parseCodexSessionLine("not json")).toBeNull();
    expect(parseCodexSessionLine("[1,2,3]")).toBeNull();
    expect(parseCodexSessionLine('{"no_type":"x"}')).toBeNull();
  });

  it("parses the fixture rollout with malformed-line tolerance", async () => {
    const dir = await makeTempDir("codex-parse-");
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, makeFixtureRolloutJsonl());
    const events = await parseCodexRolloutFile(file);
    // 12 typed rows, one malformed dropped
    expect(events.length).toBe(12);
    expect(events[0].type).toBe("session_meta");
    expect(events[1].type).toBe("turn_context");
  });
});

describe("codex-trajectory-reader: normalization", () => {
  it("emits one normalized step per response item, with reasoning/text/tool linkage", async () => {
    const dir = await makeTempDir("codex-norm-");
    const file = join(dir, "rollout.jsonl");
    await writeFile(file, makeFixtureRolloutJsonl());
    const events = await parseCodexRolloutFile(file);
    const steps = normalizeCodexEvents(events, "parent-step-1");

    // dev message ignored, reasoning + commentary text + tool_call +
    // tool_result + final text = 5 normalized steps.
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.kind)).toEqual([
      "reasoning",
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);

    const reasoning = steps[0];
    expect(reasoning.reasoning).toBe("Need to grep first.");
    expect(reasoning.model).toBe("gpt-5.3-codex");
    expect(reasoning.turnId).toBe("turn-1");
    expect(reasoning.sessionId).toBe("codex-session-fixture-1");

    const commentary = steps[1];
    expect(commentary.text).toBe("Looking up the symbol now.");
    expect(commentary.phase).toBe("commentary");

    const toolCall = steps[2];
    expect(toolCall.toolName).toBe("shell");
    expect(toolCall.toolInput).toEqual({
      cmd: "rg --files openExternalUrl",
      workdir: "/tmp/codex-fixture",
    });
    expect(toolCall.toolUseId).toBe("call_FdhLfH");
    expect(toolCall.toolCustom).toBe(false);

    const toolResult = steps[3];
    expect(toolResult.toolUseId).toBe("call_FdhLfH");
    expect(toolResult.toolResult).toContain("src/a.ts");

    const finalText = steps[4];
    expect(finalText.phase).toBe("final");
    // The token_count event fired before the final message, so usage is
    // populated on it.
    expect(finalText.usage?.input_tokens).toBe(1200);
    expect(finalText.usage?.output_tokens).toBe(250);

    // Every child step id is parent-scoped and unique.
    const ids = new Set(steps.map((s) => s.stepId));
    expect(ids.size).toBe(steps.length);
    for (const id of ids) {
      expect(id.startsWith("parent-step-1-codex-")).toBe(true);
    }
  });

  it("flags reasoning_encrypted when only encrypted_content is present", () => {
    const event = JSON.parse(
      JSON.stringify({
        timestamp: "2026-04-21T01:34:35.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: "gAAAA...redacted...",
        },
      }),
    );
    const events = [event];
    const steps = normalizeCodexEvents(events, "p");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("reasoning");
    expect(steps[0].reasoning).toBe("");
    expect(steps[0].reasoningEncrypted).toBe(true);
  });

  it("normalizes custom_tool_call + custom_tool_call_output pairs", () => {
    const events = [
      JSON.parse(
        JSON.stringify({
          timestamp: "2026-04-21T01:34:35.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            arguments: "diff body",
            call_id: "custom-1",
          },
        }),
      ),
      JSON.parse(
        JSON.stringify({
          timestamp: "2026-04-21T01:34:35.100Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "custom-1",
            output: "ok",
          },
        }),
      ),
    ];
    const steps = normalizeCodexEvents(events, "p");
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("tool_call");
    expect(steps[0].toolCustom).toBe(true);
    expect(steps[0].toolName).toBe("apply_patch");
    // arguments not JSON → toolInput undefined, toolInputRaw kept.
    expect(steps[0].toolInput).toBeUndefined();
    expect(steps[0].toolInputRaw).toBe("diff body");
    expect(steps[1].kind).toBe("tool_result");
    expect(steps[1].toolCustom).toBe(true);
  });
});

describe("readCodexSession (integration)", () => {
  it("returns reason=missing and degraded quality when nothing exists", async () => {
    const codexHome = await makeTempDir("codex-int-missing-");
    const workspace = await makeTempDir("codex-int-workspace-");
    const result = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "p",
    });
    expect(result.reason).toBe("missing");
    expect(result.captureQuality).toBe("degraded");
    expect(result.steps).toHaveLength(0);
  });

  it("emits a synthetic final step when only the last-message file exists", async () => {
    const codexHome = await makeTempDir("codex-int-only-last-");
    const workspace = await makeTempDir("codex-int-only-last-ws-");
    const lastMessageDir = await makeTempDir("codex-int-only-last-out-");
    const lastMessagePath = join(lastMessageDir, "last-message.txt");
    await writeFile(lastMessagePath, "Synthesized final answer.\n");
    const result = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "p",
      lastMessagePath,
    });
    expect(result.reason).toBe("ok");
    expect(result.captureQuality).toBe("degraded");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].text).toBe("Synthesized final answer.");
    expect(result.finalMessage).toBe("Synthesized final answer.");
  });

  it("locates + parses + normalizes the canonical Codex rollout", async () => {
    const codexHome = await makeTempDir("codex-int-canonical-");
    const workspace = await makeTempDir("codex-int-canonical-ws-");
    const nestedDir = join(codexHome, "sessions", "2026", "04", "21");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "rollout-fixture.jsonl"),
      makeFixtureRolloutJsonl(),
    );
    // Also drop a last-message file matching the final message so the
    // reader doesn't append a duplicate synthetic step.
    const outDir = await makeTempDir("codex-int-canonical-out-");
    const lastMessagePath = join(outDir, "last-message.txt");
    await writeFile(
      lastMessagePath,
      "Found openExternalUrl in src/a.ts and src/b.ts.\n",
    );

    const result = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "step-parent-abc",
      lastMessagePath,
    });
    expect(result.reason).toBe("ok");
    expect(result.captureQuality).toBe("ok");
    expect(result.sessionId).toBe("codex-session-fixture-1");
    expect(result.steps.map((s) => s.kind)).toEqual([
      "reasoning",
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(result.models).toEqual(["gpt-5.3-codex"]);
    expect(result.totalUsage.input_tokens).toBe(1200);
    expect(result.totalUsage.output_tokens).toBe(250);
    expect(result.totalUsage.reasoning_output_tokens).toBe(100);
    expect(result.finalMessage).toBe(
      "Found openExternalUrl in src/a.ts and src/b.ts.",
    );
  });

  it("degrades to ok-with-degraded-quality when last-message file is missing but expected", async () => {
    const codexHome = await makeTempDir("codex-int-deg-");
    const workspace = await makeTempDir("codex-int-deg-ws-");
    const nestedDir = join(codexHome, "sessions", "2026", "04", "21");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "rollout.jsonl"),
      makeFixtureRolloutJsonl(),
    );
    const result = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "p",
      // Path provided but file never written.
      lastMessagePath: join(workspace, "last-message-missing.txt"),
    });
    expect(result.reason).toBe("ok");
    expect(result.captureQuality).toBe("degraded");
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe("mergeCodexSessionIntoTrajectory", () => {
  function mockLogger() {
    return {
      isEnabled: () => true,
      startTrajectory: vi.fn(
        async (id: string, opts?: unknown) => ({ id, opts }) as never,
      ),
      startStep: vi.fn((id: string) => id),
      logLlmCall: vi.fn(),
      annotateStep: vi.fn(),
      endTrajectory: vi.fn(async () => undefined),
    };
  }

  function mockRuntime(logger: ReturnType<typeof mockLogger>) {
    return {
      agentId: "agent-test",
      getService: (name: string) =>
        name === "trajectories" ? logger : undefined,
      getServicesByType: (type: string) =>
        type === "trajectories" ? [logger] : [],
    } as never;
  }

  it("returns no-steps when capture is empty", async () => {
    const logger = mockLogger();
    const result = await mergeCodexSessionIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "p",
      capture: {
        steps: [],
        models: [],
        totalUsage: {},
        reason: "empty",
        captureQuality: "degraded",
      },
    });
    expect(result.skippedReason).toBe("no-steps");
    expect(result.captureQuality).toBe("degraded");
    expect(logger.startTrajectory).not.toHaveBeenCalled();
  });

  it("returns no-trajectory-logger when none is registered", async () => {
    const runtime = {
      agentId: "agent-test",
      getService: () => undefined,
      getServicesByType: () => [],
    } as never;
    const result = await mergeCodexSessionIntoTrajectory({
      runtime,
      parentStepId: "p",
      capture: {
        steps: [
          {
            stepId: "p-codex-0001-x",
            kind: "text",
            timestamp: 0,
            source: "codex",
            sessionId: "s",
            text: "hi",
          },
        ],
        models: [],
        totalUsage: {},
        reason: "ok",
        captureQuality: "ok",
      },
    });
    expect(result.skippedReason).toBe("no-trajectory-logger");
  });

  it("writes LLM calls for reasoning/text/tool_call, annotates tool_result, links parent", async () => {
    const codexHome = await makeTempDir("codex-merge-home-");
    const workspace = await makeTempDir("codex-merge-ws-");
    const nestedDir = join(codexHome, "sessions", "2026", "04", "21");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "rollout.jsonl"),
      makeFixtureRolloutJsonl(),
    );
    const capture = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "parent-step-merge",
    });

    const logger = mockLogger();
    const result = await mergeCodexSessionIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "parent-step-merge",
      capture,
      ptySessionId: "pty-1",
      workspaceDir: workspace,
      codexHome,
    });

    expect(result.stepsWritten).toBe(5);
    expect(result.captureQuality).toBe("ok");
    expect(logger.startTrajectory).toHaveBeenCalledTimes(1);
    const startCall = logger.startTrajectory.mock.calls[0];
    expect(startCall[1]?.source).toBe("codex-session");
    expect(startCall[1]?.metadata).toMatchObject({
      parentTrajectoryStepId: "parent-step-merge",
      subAgentType: "codex",
      ptySessionId: "pty-1",
      workspaceDir: workspace,
      codexHome,
      codexSessionId: "codex-session-fixture-1",
      models: ["gpt-5.3-codex"],
      captureQuality: "ok",
    });

    // reasoning + commentary text + tool_call + final text = 4 LLM calls.
    // tool_result + parent annotation = 2 annotateStep calls.
    expect(logger.logLlmCall).toHaveBeenCalledTimes(4);
    expect(logger.annotateStep).toHaveBeenCalledTimes(2);

    const llmCalls = logger.logLlmCall.mock.calls;
    const firstLlm = llmCalls[0][0] as Record<string, unknown>;
    expect(firstLlm.provider).toBe("openai");
    expect(firstLlm.actionType).toBe("codex.reasoning");

    // The third LLM call is the tool_call; verify toolCalls structure.
    const toolCallLlm = llmCalls[2][0] as Record<string, unknown>;
    expect(toolCallLlm.actionType).toBe("codex.tool_call");
    const toolCalls = toolCallLlm.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("shell");

    const annotateCalls = logger.annotateStep.mock.calls;
    // First annotate is the tool_result step.
    expect(annotateCalls[0][0]).toMatchObject({ kind: "action" });
    expect(annotateCalls[0][0].script).toContain("call_FdhLfH");
    // Second annotate links the child trajectory to the parent.
    expect(annotateCalls[1][0]).toMatchObject({
      stepId: "parent-step-merge",
      appendChildSteps: [result.childTrajectoryId],
    });

    expect(logger.endTrajectory).toHaveBeenCalledWith(
      result.childTrajectoryId,
      "completed",
    );
  });

  it("preserves captureQuality='degraded' through to the metadata", async () => {
    const codexHome = await makeTempDir("codex-merge-degr-home-");
    const workspace = await makeTempDir("codex-merge-degr-ws-");
    const lastMessageDir = await makeTempDir("codex-merge-degr-out-");
    const lastMessagePath = join(lastMessageDir, "last-message.txt");
    await writeFile(lastMessagePath, "Done.\n");
    const capture = await readCodexSession({
      workspaceDir: workspace,
      codexHome,
      parentStepId: "parent-degr",
      lastMessagePath,
    });
    expect(capture.captureQuality).toBe("degraded");

    const logger = mockLogger();
    const result = await mergeCodexSessionIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "parent-degr",
      capture,
      ptySessionId: "pty-degr",
      workspaceDir: workspace,
      codexHome,
    });
    expect(result.captureQuality).toBe("degraded");
    const startCall = logger.startTrajectory.mock.calls[0];
    expect(startCall[1]?.metadata).toMatchObject({
      captureQuality: "degraded",
    });
  });

  it("returns captureQuality='degraded' for empty captures regardless of reader", async () => {
    const logger = mockLogger();
    const result = await mergeCodexSessionIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "p",
      capture: {
        steps: [],
        models: [],
        totalUsage: {},
        reason: "empty",
        captureQuality: "ok",
      },
    });
    expect(result.captureQuality).toBe("degraded");
    expect(result.skippedReason).toBe("no-steps");
  });
});

describe("tagParentTrajectoryWithDegradedCodexCapture", () => {
  it("annotates the parent step via the trajectory logger and resolves true", async () => {
    const annotateStep = vi.fn(async () => undefined);
    const trajectoryLogger = {
      isEnabled: () => true,
      startStep: vi.fn((id: string) => id),
      annotateStep,
      logLlmCall: vi.fn(),
    };
    const runtime = {
      agentId: "agent-test",
      getService: (name: string) =>
        name === "trajectories" ? trajectoryLogger : undefined,
      getServicesByType: (type: string) =>
        type === "trajectories" ? [trajectoryLogger] : [],
    } as never;

    const warnMessages: string[] = [];
    const debugMessages: string[] = [];
    const landed = await tagParentTrajectoryWithDegradedCodexCapture({
      runtime,
      parentStepId: "parent-step-xyz",
      reason: "codex-rollout-missing",
      detail: "codexHome=/tmp/codex-x",
      logger: {
        warn: (msg) => warnMessages.push(msg),
        debug: (msg) => debugMessages.push(msg),
      },
    });
    expect(landed).toBe(true);
    expect(annotateStep).toHaveBeenCalledTimes(1);
    const call = annotateStep.mock.calls[0][0] as Record<string, unknown>;
    expect(call.stepId).toBe("parent-step-xyz");
    expect(typeof call.script).toBe("string");
    const parsed = JSON.parse(call.script as string);
    expect(parsed).toMatchObject({
      marker: "capture_quality",
      capture_quality: "degraded",
      subAgentType: "codex",
      reason: "codex-rollout-missing",
      detail: "codexHome=/tmp/codex-x",
    });
    expect(typeof parsed.recordedAt).toBe("number");
    expect(
      warnMessages.some((m) => m.includes("capture_quality=degraded")),
    ).toBe(true);
  });

  it("resolves false and emits a debug log when no trajectory logger is registered", async () => {
    const runtime = {
      agentId: "agent-test",
      getService: () => undefined,
      getServicesByType: () => [],
    } as never;
    const debugMessages: string[] = [];
    const landed = await tagParentTrajectoryWithDegradedCodexCapture({
      runtime,
      parentStepId: "parent-step-none",
      reason: "codex-no-home",
      logger: {
        debug: (msg) => debugMessages.push(msg),
      },
    });
    expect(landed).toBe(false);
    expect(debugMessages.some((m) => m.includes("no trajectory logger"))).toBe(
      true,
    );
  });

  it("propagates every documented reason value through to the marker", async () => {
    const annotateStep = vi.fn(async () => undefined);
    const trajectoryLogger = {
      isEnabled: () => true,
      startStep: vi.fn((id: string) => id),
      annotateStep,
      logLlmCall: vi.fn(),
    };
    const runtime = {
      agentId: "agent-test",
      getService: (name: string) =>
        name === "trajectories" ? trajectoryLogger : undefined,
      getServicesByType: (type: string) =>
        type === "trajectories" ? [trajectoryLogger] : [],
    } as never;

    const reasons: Array<
      | "codex-rollout-missing"
      | "codex-rollout-empty"
      | "codex-rollout-error"
      | "codex-interactive-skipped"
      | "codex-no-home"
    > = [
      "codex-rollout-missing",
      "codex-rollout-empty",
      "codex-rollout-error",
      "codex-interactive-skipped",
      "codex-no-home",
    ];

    for (const reason of reasons) {
      await tagParentTrajectoryWithDegradedCodexCapture({
        runtime,
        parentStepId: `p-${reason}`,
        reason,
      });
    }

    expect(annotateStep).toHaveBeenCalledTimes(reasons.length);
    for (let i = 0; i < reasons.length; i += 1) {
      const call = annotateStep.mock.calls[i][0] as Record<string, unknown>;
      const parsed = JSON.parse(call.script as string);
      expect(parsed.reason).toBe(reasons[i]);
      expect(parsed.subAgentType).toBe("codex");
    }
  });
});
