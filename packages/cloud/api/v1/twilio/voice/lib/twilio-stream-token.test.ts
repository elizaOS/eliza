/** Exercises real HMAC signing, expiry, tamper rejection, and immutable claims. */

import { describe, expect, test } from "bun:test";
import {
  mintTwilioStreamToken,
  verifyTwilioStreamToken,
} from "./twilio-stream-token";

const input = {
  accountSid: "AC123",
  callSid: "CA123",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  conversationId: "11111111-1111-4111-8111-111111111111",
  calledNumber: "+14484080429",
  callerNumber: "+12525914471",
  returningCaller: true,
  previousInteractionAt: 987_654,
};

describe("Twilio stream token", () => {
  test("round-trips signed scoped claims", async () => {
    const minted = await mintTwilioStreamToken(
      input,
      "secret",
      () => 1_000_000,
    );
    expect(minted.token.length).toBeLessThan(500);
    expect(
      await verifyTwilioStreamToken(minted.token, "secret", () => 1_001_000),
    ).toEqual(minted.claims);
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
