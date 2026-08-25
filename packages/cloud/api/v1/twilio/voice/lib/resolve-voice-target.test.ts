/**
 * Proves the public Twilio line resolves callers to account-native personal
 * Shared agents and rejects every unconfigured destination.
 */

import { describe, expect, mock, test } from "bun:test";

const resolvePersonalDelivery = mock(async () => ({
  userId: "11111111-1111-4111-a111-111111111111",
  organizationId: "22222222-2222-4222-a222-222222222222",
  dedicatedTarget: null,
  isNew: false,
  resolution: "single-query-repeat" as const,
}));

mock.module("@/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: { resolvePersonalDelivery },
}));

const { resolveTwilioVoiceTarget } = await import("./resolve-voice-target");

const PUBLIC_NUMBER = "+14484080429";
const CALLER_NUMBER = "+14155550100";
const publicEnv = { ELIZA_APP_TWILIO_PHONE_NUMBER: PUBLIC_NUMBER };

describe("resolveTwilioVoiceTarget", () => {
  test("resolves the caller through the verified-phone projection", async () => {
    resolvePersonalDelivery.mockClear();
    const result = await resolveTwilioVoiceTarget(
      publicEnv,
      PUBLIC_NUMBER,
      CALLER_NUMBER,
    );

    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "phone",
      phoneNumber: CALLER_NUMBER,
    });
    expect(result?.agentId).toMatch(/^personal:[0-9a-f-]{36}$/);
    expect(result?.agent.id).toBe(result?.agentId);
    expect(result).toMatchObject({
      organizationId: "22222222-2222-4222-a222-222222222222",
      resolution: "single-query-repeat",
      userId: "11111111-1111-4111-a111-111111111111",
      agent: {
        execution_tier: "shared",
      },
    });
  });

  test("rejects an unconfigured destination before creating an account", async () => {
    resolvePersonalDelivery.mockClear();
    await expect(
      resolveTwilioVoiceTarget(publicEnv, "+12525914471", CALLER_NUMBER),
    ).resolves.toBeNull();
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });
});
