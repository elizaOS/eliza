/**
 * Proves the public Twilio line resolves callers to account-native personal
 * Shared agents and rejects every unconfigured destination.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findOrCreateByPhone = mock(async (_phone: string) => ({
  user: { id: "11111111-1111-4111-a111-111111111111" },
  organization: { id: "22222222-2222-4222-a222-222222222222" },
}));

mock.module("@/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: { findOrCreateByPhone },
}));

const { resolveTwilioVoiceTarget } = await import("./resolve-voice-target");

const PUBLIC_NUMBER = "+14484080429";
const CALLER_NUMBER = "+14155550100";
const publicEnv = { ELIZA_APP_TWILIO_PHONE_NUMBER: PUBLIC_NUMBER };

beforeEach(() => findOrCreateByPhone.mockClear());

describe("resolveTwilioVoiceTarget", () => {
  test("finds or creates the caller account and returns its personal Shared agent", async () => {
    const result = await resolveTwilioVoiceTarget(
      publicEnv,
      PUBLIC_NUMBER,
      CALLER_NUMBER,
    );

    expect(findOrCreateByPhone).toHaveBeenCalledWith(CALLER_NUMBER);
    expect(result?.agentId).toMatch(/^personal:[0-9a-f-]{36}$/);
    expect(result?.agent.id).toBe(result?.agentId);
    expect(result).toMatchObject({
      organizationId: "22222222-2222-4222-a222-222222222222",
      userId: "11111111-1111-4111-a111-111111111111",
      agent: {
        execution_tier: "shared",
      },
    });
  });

  test("rejects an unconfigured destination before creating an account", async () => {
    await expect(
      resolveTwilioVoiceTarget(publicEnv, "+12525914471", CALLER_NUMBER),
    ).resolves.toBeNull();
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
  });
});
