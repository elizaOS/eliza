/** Verifies a real HTTP conversation persists ordered user and assistant messages using one strict deterministic reply fixture. */

import {
  createDeterministicModelPlugin,
  strictTerminalReplyFixture,
} from "@elizaos/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../helpers/http.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

const userText = "Hello from the deterministic live test.";
const replyText = "Hello from the deterministic model provider.";
const model = createDeterministicModelPlugin({
  fixtures: [strictTerminalReplyFixture({ input: userText, text: replyText })],
});

describe("conversation deterministic real coverage", () => {
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "conversation-deterministic-",
      plugins: [model],
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  function port(): number {
    if (!harness) {
      throw new Error("Live runtime harness was not started");
    }
    return harness.port;
  }

  it("creates a conversation, sends a message, and persists a deterministic assistant reply", async () => {
    const created = await createConversation(port(), {
      title: "Deterministic chat",
    });
    expect(created.status).toBe(200);
    const conversationId = created.conversationId;
    expect(typeof conversationId).toBe("string");
    expect(conversationId.length).toBeGreaterThan(0);

    const sent = await postConversationMessage(
      port(),
      conversationId,
      { text: userText },
      undefined,
      { timeoutMs: 90_000 },
    );
    expect(sent.status).toBe(200);
    expect(sent.data.text).toBe(replyText);
    expect(typeof sent.data.agentName).toBe("string");

    const history = await req(
      port(),
      "GET",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    expect(history.status).toBe(200);
    const messages = history.data.messages as ConversationMessage[];
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    expect(userMessages.some((m) => m.text === userText)).toBe(true);
    for (const assistant of assistantMessages) {
      expect(assistant.text).toBe(replyText);
    }

    expect(messages[0].role).toBe("user");
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    const firstAssistantIndex = messages.findIndex(
      (m) => m.role === "assistant",
    );
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(
        messages[i - 1].timestamp,
      );
    }
    model.assertFixturesConsumed();
  }, 120_000);
});
