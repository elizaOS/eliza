/**
 * Error-policy pins for the shared-runtime REST adapter (#13415): a failed
 * internal call (sandbox repo throw, bridge transport reject) must PROPAGATE, so
 * a broken pipeline surfaces as an error instead of reading as "no character",
 * "no messages", or a delivered-but-empty reply. The designed-empty answers
 * (`getSharedRuntimeCharacter` → `null`, empty turn history) must stay a
 * DISTINCT, non-throwing result. The adapter already fails closed (no
 * try/catch, no console); these tests lock that in against regressions.
 *
 * Dependency boundary is the `elizaSandboxService` singleton (the adapter makes
 * no direct `fetch`), mocked via bun's process-global `mock.module` and imported
 * after the mock, matching shared-rest-adapter.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realElizaSandbox from "../eliza-sandbox";

const bridge = mock();
const getSharedConversationHistory = mock();
const getSharedRuntimeCharacter = mock();

mock.module("../eliza-sandbox", () => ({
  ...realElizaSandbox,
  elizaSandboxService: { bridge, getSharedConversationHistory, getSharedRuntimeCharacter },
}));

const { sharedRestCharacter, sharedRestMessagesGet, sharedRestMessageSend } = await import(
  "./shared-rest-adapter"
);

// The adapter routes through elizaSandboxService, not global fetch; guard it
// anyway so a stray call fails loudly instead of hitting the network, and
// restore the original each test as required by the sweep.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.module("../eliza-sandbox", () => realElizaSandbox);
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";

describe("shared-rest-adapter error-policy — internal failure propagates vs designed-empty", () => {
  beforeEach(() => {
    bridge.mockReset();
    getSharedConversationHistory.mockReset();
    getSharedRuntimeCharacter.mockReset();
    globalThis.fetch = mock(() => {
      throw new Error("[test] unexpected global fetch");
    }) as unknown as typeof fetch;
  });

  test("character: resolver null is designed-empty ({}), NOT a swallowed failure", async () => {
    getSharedRuntimeCharacter.mockResolvedValue(null);
    const out = await sharedRestCharacter(AGENT, ORG, "Nova");
    expect(out).toEqual({ character: {}, agentName: "Nova" });
  });

  test("character: a resolver THROW propagates (broken pipeline is not empty character)", async () => {
    getSharedRuntimeCharacter.mockRejectedValue(new Error("db unreachable: findRunningSandbox"));
    await expect(sharedRestCharacter(AGENT, ORG, "Nova")).rejects.toThrow(
      "db unreachable: findRunningSandbox",
    );
  });

  test("messages: empty history is designed-empty ([]), NOT a swallowed failure", async () => {
    getSharedConversationHistory.mockResolvedValue([]);
    const out = await sharedRestMessagesGet(AGENT, AGENT);
    expect(out).toEqual({ messages: [] });
  });

  test("messages: a history load THROW propagates (broken pipeline is not empty history)", async () => {
    getSharedConversationHistory.mockRejectedValue(new Error("KV read failed"));
    await expect(sharedRestMessagesGet(AGENT, AGENT)).rejects.toThrow("KV read failed");
  });

  test("send: a bridge transport THROW propagates (never fabricates a delivered reply)", async () => {
    bridge.mockRejectedValue(new Error("bridge fetch ECONNRESET"));
    await expect(sharedRestMessageSend(AGENT, ORG, AGENT, "hi", "Eliza")).rejects.toThrow(
      "bridge fetch ECONNRESET",
    );
  });

  test("send: a successful bridge reply with no text is a distinct EMPTY string, not a throw", async () => {
    // No response.error and a result without `text` is a designed (if degenerate)
    // success shape — it must resolve to an empty reply, distinguishable from the
    // transport-throw path above, so the client can render an empty turn rather
    // than a failure overlay.
    bridge.mockResolvedValue({ jsonrpc: "2.0", id: "x", result: {} });
    await expect(sharedRestMessageSend(AGENT, ORG, AGENT, "hi", "Eliza")).resolves.toEqual({
      text: "",
      agentName: "Eliza",
    });
  });
});
