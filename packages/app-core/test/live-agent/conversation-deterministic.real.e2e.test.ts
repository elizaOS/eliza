/**
 * Keyless real-runtime conversation coverage with a DETERMINISTIC LLM proxy.
 *
 * Boots a REAL AgentRuntime + the REAL app-core HTTP stack via
 * {@link startLiveRuntimeServer}, registering
 * {@link createDeterministicLlmProxyPlugin} (priority 1000) so every model call
 * resolves deterministically with NO provider keys. The proxy supplies
 * TEXT_EMBEDDING (zero-vector, 384 dims to match the PGLite vector column the
 * real runtime configures) and deterministic RESPONSE_HANDLER/ACTION_PLANNER
 * text, so the full chat pipeline runs end-to-end without a network call.
 *
 * Routes + shapes grounded in packages/agent/src/api/conversation-routes.ts:
 *   - POST /api/conversations                 :1190 → { conversation: { id, ... } }
 *   - POST /api/conversations/:id/messages    :1916 → { text, agentName }
 *     (request body field is `text`: chat-routes.ts:1666 normalizeIncomingChatPrompt(body.text, …))
 *   - GET  /api/conversations/:id/messages    :1269 → { messages: [{ id, role, text, timestamp, … }] }
 *     sorted by createdAt ascending; role = "assistant" when entityId === agentId, else "user".
 * Deterministic proxy: packages/test/mocks/helpers/llm-proxy-plugin.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../../../test/mocks/helpers/llm-proxy-plugin.ts";
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

describe("conversation deterministic real coverage", () => {
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "conversation-deterministic-",
      // Match the 384-dim local embedding column the real runtime configures
      // for PGLite vector search (real-runtime.ts sets EMBEDDING_DIMENSION=384).
      plugins: [
        createDeterministicLlmProxyPlugin({ embeddingDimensions: 384 }),
      ],
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
    // 1. POST /api/conversations → conversation with an id.
    const created = await createConversation(port(), {
      title: "Deterministic chat",
    });
    expect(created.status).toBe(200);
    const conversationId = created.conversationId;
    expect(typeof conversationId).toBe("string");
    expect(conversationId.length).toBeGreaterThan(0);

    // 2. POST a user message — the real pipeline runs against the deterministic
    //    proxy and returns a synchronous { text, agentName } reply.
    const userText = "Hello from the deterministic live test.";
    const sent = await postConversationMessage(
      port(),
      conversationId,
      { text: userText },
      undefined,
      { timeoutMs: 90_000 },
    );
    expect(sent.status).toBe(200);
    expect(typeof sent.data.text).toBe("string");
    expect((sent.data.text as string).length).toBeGreaterThan(0);
    expect(typeof sent.data.agentName).toBe("string");

    // 3. GET the persisted message history. The runtime persists the user turn
    //    and (for a deterministic reply) the assistant turn.
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

    // The user's exact text round-trips through persistence.
    expect(userMessages.some((m) => m.text === userText)).toBe(true);
    // Every assistant turn carries deterministic, non-empty text.
    for (const assistant of assistantMessages) {
      expect(assistant.text.length).toBeGreaterThan(0);
    }

    // 4. Ordering: the first message is the user turn, the assistant reply
    //    comes after it (history is sorted by createdAt ascending).
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
  }, 120_000);
});
