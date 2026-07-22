/** Verifies canonical lease rotation, ambient fallback, and restart-seeded tier checks without external credentials. */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeChatCompletion,
  type ClaudeCompletionResult,
  ClaudeRateLimitError,
  type CompletionContext,
  type CompletionRunner,
  type CredentialLeaseBroker,
  RotatingCredentialCompletionRunner,
} from "../src/index.js";

const HMAC_KEY = Buffer.alloc(32, 7);

describe("RotatingCredentialCompletionRunner", () => {
  it("rotates linked leases on quota with one stable session key and token-only injection", async () => {
    const leases = [lease("a", "token-a"), lease("b", "token-b"), null];
    const leaseBroker = vi.fn(async () => leases.shift() ?? null);
    const broker: CredentialLeaseBroker = {
      lease: leaseBroker,
      report: vi.fn(async () => ({ ok: true })),
      release: vi.fn(() => ({ ok: true })),
    };
    const contexts: CompletionContext[] = [];
    const inner: CompletionRunner = {
      async complete(context) {
        contexts.push(context);
        context.credentialTierValidator?.("Claude Max");
        if (context.credentialOAuthToken === "token-a") {
          throw new ClaudeRateLimitError(
            2_000_000_000_000,
            "seven_day",
          );
        }
        return completionResult();
      },
    };
    const runner = new RotatingCredentialCompletionRunner({
      completionRunner: inner,
      broker,
      hmacKey: HMAC_KEY,
      now: () => 1_000,
    });

    const result = await runner.complete(completionContext());
    expect(contexts.map((context) => context.credentialOAuthToken)).toEqual([
      "token-a",
      "token-b",
    ]);
    expect(leaseBroker.mock.calls[0]?.[0].sessionKey).toBe(
      leaseBroker.mock.calls[1]?.[0].sessionKey,
    );
    expect(leaseBroker.mock.calls[1]?.[0].exclude).toEqual(["a"]);
    expect(broker.report).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        leaseId: "lease-a",
        httpStatus: 429,
        retryAfterMs: 2_000_000_000_000 - 1_000,
      }),
    );
    expect(broker.release).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      sdkApiKeySource: "none",
      credentialEpochHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      credentialTierHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain("token-a");
    expect(JSON.stringify(result)).not.toContain("lease-a");
  });

  it("uses one ambient keychain epoch when no linked account is selectable", async () => {
    const broker: CredentialLeaseBroker = {
      lease: vi.fn(async () => null),
      report: vi.fn(async () => ({ ok: true })),
      release: vi.fn(() => ({ ok: true })),
    };
    const contexts: CompletionContext[] = [];
    const runner = new RotatingCredentialCompletionRunner({
      completionRunner: {
        async complete(context) {
          contexts.push(context);
          context.credentialTierValidator?.("Claude Max");
          return completionResult();
        },
      },
      broker,
      hmacKey: HMAC_KEY,
    });

    await expect(runner.complete(completionContext())).resolves.toMatchObject({
      subscriptionType: "Claude Max",
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].credentialOAuthToken).toBeUndefined();
  });

  it("pauses without ambient fallback when linked accounts are configured but unselectable", async () => {
    let providerCalls = 0;
    const runner = new RotatingCredentialCompletionRunner({
      completionRunner: {
        async complete() {
          providerCalls += 1;
          return completionResult();
        },
      },
      broker: {
        lease: vi.fn(async () => null),
        report: vi.fn(async () => ({ ok: true })),
        release: vi.fn(() => ({ ok: true })),
      },
      hmacKey: HMAC_KEY,
      ambientFallbackAllowed: false,
    });

    await expect(runner.complete(completionContext())).rejects.toMatchObject({
      code: "subscription_rate_limited",
      retryAtMs: null,
    });
    expect(providerCalls).toBe(0);
  });

  it("rejects a restarted tier mismatch before simulated provider consumption", async () => {
    const expectedTier = hmac("tier:Claude Max");
    let providerConsumptions = 0;
    const runner = new RotatingCredentialCompletionRunner({
      completionRunner: {
        async complete(context) {
          context.credentialTierValidator?.("Claude Pro");
          providerConsumptions += 1;
          return completionResult("Claude Pro");
        },
      },
      broker: null,
      hmacKey: HMAC_KEY,
      expectedTierHmacSha256: expectedTier,
      expectedCapabilityHmacSha256: hmac(
        "firstParty:oauth:subscription",
      ),
    });

    await expect(runner.complete(completionContext())).rejects.toMatchObject({
      code: "credential_capability_mismatch",
    });
    expect(providerConsumptions).toBe(0);
  });
});

function lease(accountId: string, accessToken: string) {
  return {
    leaseId: `lease-${accountId}`,
    providerId: "anthropic-subscription",
    accountId,
    accessToken,
  };
}

function completionContext(): CompletionContext {
  return {
    requestId: `logical_${"a".repeat(64)}`,
    harness: "eliza",
    canonical: canonicalizeChatCompletion({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "PONG" }],
    }),
  };
}

function completionResult(
  subscriptionType = "Claude Max",
): ClaudeCompletionResult {
  return {
    text: "PONG",
    toolCalls: [],
    model: "claude-opus-4-8-actual",
    claudeCodeVersion: "test",
    sdkApiKeySource: "none",
    resultSubtype: "success",
    terminalReason: "completed",
    subscriptionType,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

function hmac(value: string): string {
  return createHmac("sha256", HMAC_KEY).update(value).digest("hex");
}
