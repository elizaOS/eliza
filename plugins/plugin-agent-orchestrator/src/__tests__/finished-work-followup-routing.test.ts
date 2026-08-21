import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { hardenIncomingUserMessage } from "@elizaos/core";
import { finishedWorkFollowUpRoutingEvaluator } from "../evaluators/finished-work-followup-routing.js";

const ROOM = "room-1";

function runtimeWith(sessions: unknown[]): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "ACP_SERVICE" ? { listSessions: () => sessions } : null,
  } as unknown as IAgentRuntime;
}

function finishedLane(id: string) {
  return {
    id,
    status: "completed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    metadata: { roomId: ROOM, label: "card-picker" },
  };
}

function discordMessage(raw: string): Memory {
  const message = {
    id: "msg-1",
    entityId: "user-1",
    roomId: ROOM,
    content: {
      // The connector renders a context header + agent mention into text and
      // keeps the raw human message in currentMessageText.
      text: `[Discord #general | NUBot test server] @e2e (Fri 08/21/2026 20:56 UTC): remilio nubilio (@1490833425802854491) ${raw}`,
      currentMessageText: `remilio nubilio (@1490833425802854491) ${raw}`,
      source: "discord",
    },
  } as unknown as Memory;
  hardenIncomingUserMessage(message);
  return message;
}

async function route(message: Memory, sessions: unknown[]) {
  return finishedWorkFollowUpRoutingEvaluator.evaluate({
    runtime: runtimeWith(sessions),
    message,
    messageHandler: { processMessage: "RESPOND" },
  } as never);
}

describe("finished-work follow-up routing", () => {
  it("forwards only the user's words — no connector header, envelope, or agent mention", async () => {
    const message = discordMessage("run it again, i want another card");
    expect(finishedWorkFollowUpRoutingEvaluator.shouldRun?.({ message } as never)).toBe(true);
    const result = await route(message, [finishedLane("lane-1")]);
    expect(result?.deterministicToolCall).toEqual({
      name: "TASKS",
      params: {
        action: "send",
        sessionId: "lane-1",
        input: "run it again, i want another card",
      },
    });
  });

  it("stays out of the way while a lane is still running", async () => {
    const message = discordMessage("run it again");
    const result = await route(message, [
      finishedLane("lane-1"),
      { ...finishedLane("lane-2"), status: "running" },
    ]);
    expect(result).toBeUndefined();
  });

  it("does not fire for a fresh coding ask", () => {
    const message = discordMessage("write me a python script that picks a card");
    expect(finishedWorkFollowUpRoutingEvaluator.shouldRun?.({ message } as never)).toBe(false);
  });
});
