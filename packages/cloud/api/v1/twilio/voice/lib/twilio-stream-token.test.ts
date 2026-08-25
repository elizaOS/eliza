/** Exercises real HMAC signing, expiry, tamper rejection, and immutable claims. */

import { describe, expect, test } from "bun:test";
import {
  mintTwilioStreamToken,
  prepareTwilioStreamToken,
  verifyTwilioStreamToken,
} from "./twilio-stream-token";
import {
  callOpeningClientMessageId,
  callOpeningPrompt,
} from "./voice-continuity";

const input = {
  accountSid: "AC123",
  callSid: "CA123",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "11111111-1111-4111-8111-111111111111",
  calledNumber: "+14484080429",
  returningCaller: true,
  previousInteractionAt: 987_654,
  callStartedAt: 999_000,
};

describe("Twilio stream token", () => {
  test("round-trips signed scoped claims", async () => {
    const minted = await mintTwilioStreamToken(
      input,
      "secret",
      () => 1_000_000,
    );
    expect(minted.token.length).toBeLessThan(500);
    expect(minted.claims.callStartedAt).toBe(input.callStartedAt);
    expect(
      await verifyTwilioStreamToken(minted.token, "secret", () => 1_001_000),
    ).toEqual(minted.claims);
  });

  test("signs the exact preallocated directory identity", async () => {
    const bootstrap = prepareTwilioStreamToken(() => 1_000_000);
    const minted = await mintTwilioStreamToken(
      input,
      "secret",
      () => 1_000_000,
      bootstrap,
    );

    expect(minted.claims).toMatchObject(bootstrap);
    expect(
      await verifyTwilioStreamToken(minted.token, "secret", () => 1_001_000),
    ).toEqual(minted.claims);
  });

  test("verifies rollout-window tokens without the call-start claim", async () => {
    const { callStartedAt: _callStartedAt, ...legacyInput } = input;
    const minted = await mintTwilioStreamToken(
      legacyInput,
      "secret",
      () => 1_000_000,
    );
    expect(
      await verifyTwilioStreamToken(minted.token, "secret", () => 1_001_000),
    ).toEqual(minted.claims);
    expect(minted.claims.callStartedAt).toBeUndefined();
  });

  test("converges duplicate webhook tokens on one canonical opener payload", async () => {
    const callStartedAt = Date.UTC(2026, 7, 15, 12);
    const duplicateInput = {
      ...input,
      callStartedAt,
      previousInteractionAt: callStartedAt - 59.6 * 60_000,
    };
    const first = await mintTwilioStreamToken(
      duplicateInput,
      "secret",
      () => callStartedAt,
    );
    const retry = await mintTwilioStreamToken(
      duplicateInput,
      "secret",
      () => callStartedAt + 90_000,
    );
    const firstClaims = await verifyTwilioStreamToken(
      first.token,
      "secret",
      () => callStartedAt + 1_000,
    );
    const retryClaims = await verifyTwilioStreamToken(
      retry.token,
      "secret",
      () => callStartedAt + 91_000,
    );
    expect(firstClaims).not.toBeNull();
    expect(retryClaims).not.toBeNull();
    if (!firstClaims || !retryClaims)
      throw new Error("signed claims did not verify");
    expect(retry.token).not.toBe(first.token);
    expect(
      callOpeningPrompt(
        retryClaims.returningCaller,
        retryClaims.previousInteractionAt,
        retryClaims.callStartedAt,
      ),
    ).toBe(
      callOpeningPrompt(
        firstClaims.returningCaller,
        firstClaims.previousInteractionAt,
        firstClaims.callStartedAt,
      ),
    );
    expect(callOpeningClientMessageId(retryClaims.callSid)).toBe(
      callOpeningClientMessageId(firstClaims.callSid),
    );
  });

  test("rejects tampering and the wrong signing secret", async () => {
    const minted = await mintTwilioStreamToken(input, "secret");
    expect(
      await verifyTwilioStreamToken(`${minted.token}x`, "secret"),
    ).toBeNull();
    expect(
      await verifyTwilioStreamToken(minted.token, "other-secret"),
    ).toBeNull();
  });

  test("rejects an expired token", async () => {
    const minted = await mintTwilioStreamToken(
      input,
      "secret",
      () => 1_000_000,
    );
    expect(
      await verifyTwilioStreamToken(minted.token, "secret", () => 1_130_000),
    ).toBeNull();
  });

  test("accepts personal Shared room ids and rejects arbitrary room text", async () => {
    const personal = {
      ...input,
      agentId: "personal:da729919-c9f5-5fe7-b5fe-3e0ca681a8c1",
      conversationId: "personal:da729919-c9f5-5fe7-b5fe-3e0ca681a8c1",
    };
    const minted = await mintTwilioStreamToken(personal, "secret");
    expect(await verifyTwilioStreamToken(minted.token, "secret")).toEqual(
      minted.claims,
    );
    await expect(
      mintTwilioStreamToken(
        { ...input, conversationId: "room-from-client" },
        "secret",
      ),
    ).rejects.toThrow();
  });
});
