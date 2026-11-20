import {
  type Content,
  type IAgentRuntime,
  type Memory,
  PseudonymSession,
  runWithTrajectoryContext,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { wrapSingleTurnVisibleCallback } from "./delivery.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000b2" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000b3" as UUID;

const message = {
  id: MESSAGE_ID,
  roomId: ROOM_ID,
  entityId: AGENT_ID,
  content: { text: "Call Maria Gonzalez before noon." },
} as unknown as Memory;

function runtimeStub(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportError: vi.fn(),
    // Keep the voice rewrite out of this unit: it spends a model call.
    getSetting: (key: string) =>
      key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
    getService: () => undefined,
  } as unknown as IAgentRuntime;
}

/** Deliver one visible callback and return the text the channel receives. */
async function deliverVisible(text: string): Promise<string[]> {
  const delivered: string[] = [];
  const callback = wrapSingleTurnVisibleCallback(
    runtimeStub(),
    message,
    async (content: Content) => {
      delivered.push(typeof content.text === "string" ? content.text : "");
      return [];
    },
  );
  if (!callback) throw new Error("expected a wrapped visible callback");
  await callback({ text }, "REPLY");
  return delivered;
}

function piiSession(source: string): PseudonymSession {
  const session = new PseudonymSession({ salt: "delivery-pii-fixture" });
  session.learnSpans(source, [
    { kind: "person", value: "Maria Gonzalez", start: 5, end: 19 },
  ]);
  return session;
}

describe("visible callback reply-text egress", () => {
  it("restores PII surrogates before the text reaches the channel", async () => {
    const source = "Call Maria Gonzalez before noon.";
    const session = piiSession(source);
    // Model output is re-pseudonymized inside model dispatch, so a callback
    // that quotes the model carries the surrogate, never the real name.
    const modelText = session.substituteText(source);
    expect(modelText).not.toContain("Maria Gonzalez");

    const delivered = await runWithTrajectoryContext(
      { roomId: ROOM_ID, piiSwapSession: session },
      () => deliverVisible(modelText),
    );

    expect(delivered).toEqual([source]);
  });

  it("keeps the callback text unchanged when no swap session is active", async () => {
    const text = "Call Maria Gonzalez before noon.";
    expect(await deliverVisible(text)).toEqual([text]);
  });
});
