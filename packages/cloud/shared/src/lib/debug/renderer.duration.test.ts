/**
 * A trace just under one minute must not render as "60.00s".
 * toFixed(2) rounds 59.996s up to 60.00 while the value is still under 60000 ms.
 */

import { expect, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import { DebugTraceRenderer } from "./renderer";
import type { DebugTrace } from "./types";

function trace(durationMs: number): DebugTrace {
  const id = "11111111-1111-4111-8111-111111111111" as UUID;
  return {
    runId: id,
    roomId: id,
    entityId: id,
    agentId: id,
    agentMode: "chat",
    source: "test",
    startedAt: 0,
    durationMs,
    status: "completed",
    inputMessage: { text: "hi" },
    steps: [],
    failures: [],
    summary: {
      totalModelCalls: 0,
      totalActions: 0,
      failedActions: 0,
      successfulActions: 0,
      iterationCount: 0,
      maxIterations: 1,
      totalPromptTokens: 0,
      totalResponseTokens: 0,
      parseAttempts: 0,
      parseFailures: 0,
      totalDurationMs: durationMs,
    },
  };
}

test("a duration just under 60 seconds renders as one minute", () => {
  const summary = new DebugTraceRenderer(trace(59_996)).render({
    view: "summary",
  });
  expect(summary).toContain("- **Duration**: 1.00m");
  expect(summary).not.toContain("60.00s");
  expect(new DebugTraceRenderer(trace(45_000)).render({ view: "summary" })).toContain(
    "- **Duration**: 45.00s",
  );
  expect(new DebugTraceRenderer(trace(60_000)).render({ view: "summary" })).toContain(
    "- **Duration**: 1.00m",
  );
});
