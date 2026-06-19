import { describe, expect, it } from "vitest";

import {
  renderTrajectoryRecordMarkdown,
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
});
