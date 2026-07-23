/**
 * Error-policy pins for the shared-runtime REST adapter (#13415): a failed
 * internal coordinator/cache call must PROPAGATE, so
 * a broken pipeline surfaces as an error instead of reading as "no character",
 * "no messages", or a delivered-but-empty reply. The designed-empty answers
 * Empty turn history remains a distinct, non-throwing result. The adapter
 * already fails closed (no try/catch, no console); these tests lock that in.
 *
 * The legacy sandbox service is not a dependency of this adapter.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realConversationCoordinator from "./conversation-coordinator";
import * as realSharedRuntimeChat from "./shared-runtime-chat";

const coordinateSharedBridge = mock();
const coordinateSharedHistory = mock();
const getCharacter = mock();

mock.module("./conversation-coordinator", () => ({
  ...realConversationCoordinator,
  coordinateSharedBridge,
  coordinateSharedHistory,
}));
mock.module("./shared-runtime-chat", () => ({
  ...realSharedRuntimeChat,
  sharedRuntimeChatService: { getCharacter },
}));

const { sharedRestCharacter, sharedRestMessagesGet, sharedRestMessageSend } = await import(
  "./shared-rest-adapter"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.module("./conversation-coordinator", () => realConversationCoordinator);
  mock.module("./shared-runtime-chat", () => realSharedRuntimeChat);
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const EXECUTION_CTX = { waitUntil() {} };
const NAMESPACE = { getByName: () => ({ fetch: async () => new Response() }) };
const SHARED_AGENT = {
  id: AGENT,
  organization_id: ORG,
  execution_tier: "shared",
} as never;

describe("shared-rest-adapter error-policy — internal failure propagates vs designed-empty", () => {
  beforeEach(() => {
    coordinateSharedBridge.mockReset();
    coordinateSharedHistory.mockReset();
    getCharacter.mockReset();
    globalThis.fetch = mock(() => {
      throw new Error("[test] unexpected global fetch");
    }) as unknown as typeof fetch;
  });

  test("character: a resolver THROW propagates (broken pipeline is not empty character)", async () => {
    getCharacter.mockRejectedValue(new Error("character cache unavailable"));
    await expect(sharedRestCharacter(SHARED_AGENT, "Nova", EXECUTION_CTX)).rejects.toThrow(
      "character cache unavailable",
    );
  });

  test("messages: empty history is designed-empty ([]), NOT a swallowed failure", async () => {
    coordinateSharedHistory.mockResolvedValue([]);
    const out = await sharedRestMessagesGet(AGENT, AGENT, NAMESPACE);
    expect(out).toEqual({ messages: [] });
  });

  test("messages: a history load THROW propagates (broken pipeline is not empty history)", async () => {
    coordinateSharedHistory.mockRejectedValue(new Error("KV read failed"));
    await expect(sharedRestMessagesGet(AGENT, AGENT, NAMESPACE)).rejects.toThrow("KV read failed");
  });

  test("send: a bridge transport THROW propagates (never fabricates a delivered reply)", async () => {
    coordinateSharedBridge.mockRejectedValue(new Error("bridge fetch ECONNRESET"));
    await expect(
      sharedRestMessageSend(SHARED_AGENT, AGENT, "hi", "Eliza", EXECUTION_CTX, NAMESPACE),
    ).rejects.toThrow("bridge fetch ECONNRESET");
  });

  test("send: a successful bridge reply with no text is a distinct EMPTY string, not a throw", async () => {
    // No response.error and a result without `text` is a designed (if degenerate)
    // success shape — it must resolve to an empty reply, distinguishable from the
    // transport-throw path above, so the client can render an empty turn rather
    // than a failure overlay.
    coordinateSharedBridge.mockResolvedValue({ jsonrpc: "2.0", id: "x", result: {} });
    await expect(
      sharedRestMessageSend(SHARED_AGENT, AGENT, "hi", "Eliza", EXECUTION_CTX, NAMESPACE),
    ).resolves.toEqual({
      text: "",
      agentName: "Eliza",
    });
  });
});
