/**
 * Error-policy pin (#13415): in runSharedAgentTurn an INTERNAL inference/provider
 * failure must PROPAGATE (throw with `cause`) so the caller refunds the credit
 * hold and the failure surfaces, while the DESIGNED no-model-configured
 * "unavailable" state stays a distinguishable `degraded` result — the two must
 * never collapse into the same signal. Drives the real exported function with the
 * `ai` SDK's `generateText` and the language-model router stubbed via mock.module
 * (deterministic, no live model); global fetch is trapped and restored to prove
 * no accidental network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-test controls for the two collaborators runSharedAgentTurn calls.
let providerConfigured = true;
let generateTextImpl: () => Promise<{ text: string; usage?: unknown }> = async () => ({
  text: "ok reply",
});

mock.module("../../providers/language-model", () => ({
  // The returned handle is opaque here — generateText is stubbed, so it is never
  // actually invoked against a provider.
  getLanguageModel: () => ({ __sentinel: "model" }),
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("ai", () => ({
  generateText: async () => generateTextImpl(),
}));

const { runSharedAgentTurn } = await import("./run-shared-agent-turn");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  providerConfigured = true;
  generateTextImpl = async () => ({ text: "ok reply" });
  globalThis.fetch = mock(async () => {
    throw new Error("no network expected in this unit test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runSharedAgentTurn — internal failure propagates vs designed-empty degrades", () => {
  test("an internal inference/provider failure throws (propagates) instead of degrading", async () => {
    providerConfigured = true;
    generateTextImpl = async () => {
      throw new Error("provider 503 during shared-runtime turn");
    };

    const error = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [],
      message: "hello",
    }).then(
      () => {
        throw new Error("expected runSharedAgentTurn to throw on inference failure");
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    // Context is added (agent + model) and the original error is preserved as cause,
    // so the failure is diagnosable rather than swallowed into a canned reply.
    expect((error as Error).message).toContain("Nova");
    expect((error as Error).message).toContain("gpt-oss-120b");
    const cause = (error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("provider 503");
  });

  test("the designed no-model-configured state stays a distinguishable degraded result (no throw)", async () => {
    // No provider configured for any model → resolveSharedAgentTurnModel() is null,
    // so this is the intentional unavailable state, NOT an internal failure. It must
    // return degraded without ever calling generateText.
    providerConfigured = false;
    generateTextImpl = async () => {
      throw new Error("generateText must not be reached when no model is configured");
    };

    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "  hello there  ",
    });

    expect(result.degraded).toBe(true);
    expect(result.model).toBe("none");
    expect(result.reply).toContain("no shared model configured");
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toMatchObject({
      role: "user",
      content: "hello there",
    });
    expect(typeof result.history[0]?.createdAt).toBe("number");
    expect(result.history[1]?.role).toBe("assistant");
    expect(typeof result.history[1]?.createdAt).toBe("number");
  });

  test("a successful turn returns the reply with degraded:false (not a tautology — real SUT runs)", async () => {
    providerConfigured = true;
    generateTextImpl = async () => ({ text: "  hi from Nova  ", usage: { totalTokens: 7 } });

    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [
        { role: "user", content: "prev-q" },
        { role: "assistant", content: "prev-a" },
      ],
      message: "hi",
    });

    expect(result.degraded).toBe(false);
    expect(result.reply).toBe("hi from Nova");
    expect(result.model).toBe("gpt-oss-120b");
    expect(result.usage).toEqual({ totalTokens: 7 });
    // history + new user message + assistant reply.
    expect(result.history).toHaveLength(4);
    expect(result.history[2]).toMatchObject({ role: "user", content: "hi" });
    expect(typeof result.history[2]?.createdAt).toBe("number");
    expect(result.history[3]).toMatchObject({
      role: "assistant",
      content: "hi from Nova",
    });
    expect(typeof result.history[3]?.createdAt).toBe("number");
  });
});
