/**
 * shouldRespond reads the user's own words, not the connector envelope.
 *
 * A Discord group message carries its envelope in content.text:
 * `[Discord #channel] @sender (time): <user text>`. Rule 4 (text address
 * with tagged participants) must not fire when the agent token appears
 * only in the sender handle or in the channel label, because the user
 * did not address the agent. It must still fire when the user's own
 * words name the agent beside another tag.
 */

import type { IAgentRuntime, Memory, Room } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DefaultMessageService } from "../message.ts";

const service = new DefaultMessageService();

const runtime = {
  getSetting: () => undefined,
  character: { name: "testagent", username: "testagent" },
  agentId: "agent-1",
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
} as unknown as IAgentRuntime;

const room = { type: "group" } as unknown as Room;

function decide(text: string, currentMessageText?: string) {
  const message = {
    content: { text, currentMessageText, source: "discord" },
  } as unknown as Memory;
  return service.shouldRespond(runtime, message, room, undefined);
}

describe("shouldRespond envelope words", () => {
  it("does not respond when only the sender handle carries the agent token", () => {
    const decision = decide(
      "[Discord #general] @testagent_fan (2026-11-02T08:00:00.000Z): hello everyone",
      "hello everyone",
    );
    expect(decision.shouldRespond).toBe(false);
    expect(decision.skipEvaluation).toBe(false);
  });

  it("does not respond when only the channel label carries the agent token", () => {
    const decision = decide(
      "[Discord #testagent-lounge] @alice (2026-11-02T08:00:00.000Z): hello everyone",
      "hello everyone",
    );
    expect(decision.shouldRespond).toBe(false);
    expect(decision.skipEvaluation).toBe(false);
  });

  it("responds when the user words name the agent beside another tag", () => {
    const decision = decide(
      "[Discord #general] @alice (2026-11-02T08:00:00.000Z): hey @bob, ask testagent later",
      "hey @bob, ask testagent later",
    );
    expect(decision.shouldRespond).toBe(true);
    expect(decision.skipEvaluation).toBe(true);
    expect(decision.reason).toBe("text address with tagged participants");
  });

  it("responds when plain unenveloped words name the agent beside another tag", () => {
    // Pins the getUserMessageText fallback: with no currentMessageText,
    // the reader falls back to content.text, so a plain group message
    // whose own words address the agent still triggers rule 4.
    const decision = decide("hey @bob, ask testagent later");
    expect(decision.shouldRespond).toBe(true);
    expect(decision.skipEvaluation).toBe(true);
    expect(decision.reason).toBe("text address with tagged participants");
  });

  it("does not respond to plain ambient group text", () => {
    const decision = decide("hello everyone");
    expect(decision.shouldRespond).toBe(false);
    expect(decision.skipEvaluation).toBe(false);
  });
});
