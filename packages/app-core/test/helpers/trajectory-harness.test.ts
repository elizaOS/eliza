/** Exercises trajectory harness behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

import {
  renderTrajectoryRecordMarkdown,
  serializeLlmCallParams,
  serializeLlmCallResult,
  type TrajectoryRecord,
} from "./trajectory-harness.ts";

function baseTrajectoryRecord(overrides: Partial<TrajectoryRecord> = {}) {
  const now = Date.UTC(2026, 4, 9, 12, 0, 0);
  return {
    caseId: "markdown-review",
    scenarioId: "trajectory-formatting",
    startedAt: now,
    endedAt: now + 1000,
    durationMs: 1000,
    roomId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    transcript: [],
    agentTrajectory: {
      llmCalls: [],
      providerSnapshots: [],
    },
    actions: [],
    events: [],
    memoriesWritten: [],
    metadata: {},
    ...overrides,
  } as TrajectoryRecord;
}

describe("trajectory markdown rendering", () => {
  it("pretty-prints and wraps long JSON payloads for manual review", () => {
    const longContent = "cache efficient prompt section ".repeat(40);
    const record = baseTrajectoryRecord({
      metadata: {
        result: {
          selectionPass: true,
          plannerPass: true,
          executionPass: true,
        },
      },
      agentTrajectory: {
        llmCalls: [
          {
            callId: "llm-1",
            timestamp: Date.UTC(2026, 4, 9, 12, 0, 0),
            latencyMs: 42,
            modelType: "TEXT_LARGE",
            purpose: "action_planner",
            prompt: JSON.stringify({
              messages: [{ role: "system", content: longContent }],
            }),
            response: JSON.stringify({
              toolCalls: [
                {
                  toolName: "PROFILE",
                  input: { field: "travelBookingPreferences" },
                },
              ],
            }),
          },
        ],
        providerSnapshots: [],
      },
    });

    const markdown = renderTrajectoryRecordMarkdown(record);
    const maxLineLength = Math.max(
      ...markdown.split("\n").map((line) => line.length),
    );

    expect(markdown).toContain('"messages": [');
    expect(markdown).toContain('"toolName": "PROFILE"');
    expect(maxLineLength).toBeLessThanOrEqual(180);
  });

  it("redacts provider keys in markdown review artifacts", () => {
    const record = baseTrajectoryRecord({
      agentTrajectory: {
        llmCalls: [
          {
            callId: "llm-1",
            timestamp: Date.UTC(2026, 4, 9, 12, 0, 0),
            latencyMs: 42,
            modelType: "TEXT_LARGE",
            purpose: "action_planner",
            prompt:
              "Use csk-abcdefghijklmnopqrstuvwxyz1234567890 only for this run.",
            response: "ok",
          },
        ],
        providerSnapshots: [],
      },
    });

    const markdown = renderTrajectoryRecordMarkdown(record);

    expect(markdown).toContain("[REDACTED_CEREBRAS_KEY]");
    expect(markdown).not.toContain("csk-abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("preserves complete model and provider payloads above former capture caps", () => {
    const longPrompt = ` prompt-boundary ${"p".repeat(70_000)} prompt-tail `;
    const longResponse = ` response-boundary ${"r".repeat(70_000)} response-tail `;
    const providerText = ` provider-boundary ${"v".repeat(9_000)} provider-tail `;
    const actionText = ` action-boundary ${"a".repeat(200)} action-tail `;
    const record = baseTrajectoryRecord({
      agentTrajectory: {
        llmCalls: [
          {
            callId: "llm-complete",
            timestamp: Date.UTC(2026, 4, 9, 12, 0, 0),
            latencyMs: 42,
            modelType: "TEXT_LARGE",
            purpose: "reply",
            prompt: longPrompt,
            response: longResponse,
          },
        ],
        providerSnapshots: [
          {
            timestamp: Date.UTC(2026, 4, 9, 12, 0, 0),
            includeList: null,
            providers: [
              {
                name: "COMPLETE_PROVIDER",
                text: providerText,
                values: { repeated: [providerText, providerText] },
                data: { exact: providerText },
              },
            ],
            text: providerText,
          },
        ],
      },
      actions: [
        {
          phase: "completed",
          actionName: "COMPLETE_ACTION",
          timestamp: Date.UTC(2026, 4, 9, 12, 0, 0),
          contentText: actionText,
        },
      ],
    });

    const markdown = renderTrajectoryRecordMarkdown(record);
    const unwrappedMarkdown = markdown.replaceAll("\n", "");

    for (const completeValue of [
      longPrompt,
      longResponse,
      providerText,
      actionText,
    ]) {
      expect(unwrappedMarkdown).toContain(completeValue);
    }
    expect(markdown).not.toContain("[truncated]");
  });

  it("serializes complete results and rejects malformed model output", () => {
    const response = ` result-boundary ${"x".repeat(70_000)} result-tail `;
    const providerOption = ` option-boundary ${"o".repeat(70_000)} option-tail `;
    expect(serializeLlmCallResult({ response }).response).toContain(response);
    const request = serializeLlmCallParams({
      prompt: "short prompt",
      providerOptions: { complete: providerOption },
    }).prompt;
    expect(request).toContain("short prompt");
    expect(request).toContain(providerOption);
    expect(() => serializeLlmCallResult("bad \uD83D text")).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TEXT_MALFORMED_UNICODE" }),
    );
  });

  it("preserves repeated object values and rejects actual cycles", () => {
    const shared = { text: "same complete value" };
    const serialized = serializeLlmCallParams({
      providerOptions: { first: shared, second: shared },
    }).prompt;
    expect(JSON.parse(serialized)).toMatchObject({
      providerOptions: { first: shared, second: shared },
    });
    expect(serialized).not.toContain("[Circular]");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeLlmCallParams(circular)).toThrowError(
      expect.objectContaining({
        code: "TRAJECTORY_SERIALIZATION_CIRCULAR",
        context: { field: "self" },
      }),
    );
  });
});
