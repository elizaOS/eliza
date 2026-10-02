/**
 * A ```json5 fenced legacy triage array must classify instead of failing on
 * the "5" a shorter ```json label match leaves at the start of the body.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { classifyMessages } from "../src/inbox/triage-classifier.js";
import type { InboundMessage } from "../src/inbox/types.js";

const MESSAGE: InboundMessage = {
  id: "msg-1",
  source: "gmail",
  senderName: "Sam Rivera",
  channelName: "Primary",
  channelType: "dm",
  text: "Heads up: the office is closed Friday.",
  snippet: "Heads up: the office is closed Friday.",
  timestamp: 0,
};

it("classifies a ```json5 fenced legacy JSON array", async () => {
  const runtime = {
    getService: () => null,
    useModel: async () =>
      '```json5\n[{"classification":"info","urgency":"low","confidence":0.9,"reasoning":"FYI"}]\n```',
  } as unknown as IAgentRuntime;

  const [result] = await classifyMessages(runtime, [MESSAGE], {});

  expect(result).toMatchObject({
    classification: "info",
    urgency: "low",
    confidence: 0.9,
  });
});
