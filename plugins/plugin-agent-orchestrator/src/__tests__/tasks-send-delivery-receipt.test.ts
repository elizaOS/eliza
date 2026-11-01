/**
 * REPRO (method-2 sweep): AcpService.sendToSession resolves with a
 * PromptResult whose stopReason is "cancelled"/"error" instead of throwing.
 * The TASKS send action must not report success for such a turn.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

function runtimeWith(result: Record<string, unknown>): IAgentRuntime {
  const session = {
    id: "sess-1",
    sessionId: "sess-1",
    status: "ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const service = {
    getSession: async () => session,
    listSessions: async () => [session],
    sendToSession: async () => result,
    sendPrompt: async () => result,
    emitsPromptTerminalEvents: false,
  };
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? service
        : null,
    hasService: () => false,
    services: new Map(),
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

const message = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "22222222-2222-4222-8222-222222222222",
  entityId: "33333333-3333-4333-8333-333333333333",
  content: { text: "Assign the task to the coding agent." },
} as Memory;

describe("TASKS send delivery receipt", () => {
  it("does not claim success when the turn settled cancelled", async () => {
    const runtime = runtimeWith({
      sessionId: "sess-1",
      response: "",
      finalText: "",
      stopReason: "cancelled",
      durationMs: 5,
    });
    const result = await tasksAction.handler(runtime, message, undefined, {
      parameters: { action: "send", sessionId: "sess-1", task: "Do the thing" },
    });
    console.log("SEND cancelled →", JSON.stringify(result, null, 2)?.slice(0, 1200));
    expect(result?.success).toBe(false);
  });

  it("claims success when the turn settles normally", async () => {
    const runtime = runtimeWith({
      sessionId: "sess-1",
      response: "done",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 5,
    });
    const result = await tasksAction.handler(runtime, message, undefined, {
      parameters: { action: "send", sessionId: "sess-1", task: "Do the thing" },
    });
    console.log("SEND end_turn →", JSON.stringify(result, null, 2)?.slice(0, 1200));
    expect(result?.success).toBe(true);
  });

  it("control continue does not claim delivery when the turn settled error", async () => {
    const runtime = runtimeWith({
      sessionId: "sess-1",
      response: "",
      finalText: "",
      stopReason: "error",
      error: "acpx prompt failed",
      durationMs: 5,
    });
    const result = await tasksAction.handler(runtime, message, undefined, {
      parameters: {
        action: "control",
        controlAction: "continue",
        sessionId: "sess-1",
        instruction: "Keep going",
      },
    });
    console.log("CONTROL error →", JSON.stringify(result, null, 2)?.slice(0, 1200));
    expect(result?.success).toBe(false);
  });
});
