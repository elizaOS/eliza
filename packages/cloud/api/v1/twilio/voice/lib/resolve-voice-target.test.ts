/** Proves signed Twilio calls receive isolated guest scopes, never phone-owned history. */

import { describe, expect, test } from "bun:test";
import { isCanonicalPersonalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-identity";
import { resolveTwilioVoiceTarget } from "./resolve-voice-target";

const PUBLIC_NUMBER = "+14484080429";
const publicEnv = { ELIZA_APP_TWILIO_PHONE_NUMBER: PUBLIC_NUMBER };

describe("resolveTwilioVoiceTarget", () => {
  test("uses a deterministic call-isolated guest without personal authority", async () => {
    const identity = { accountSid: "AC123", callSid: "CA123" };
    const first = await resolveTwilioVoiceTarget(
      publicEnv,
      PUBLIC_NUMBER,
      identity,
    );
    const replay = await resolveTwilioVoiceTarget(
      publicEnv,
      PUBLIC_NUMBER,
      identity,
    );

    expect(replay).toEqual(first);
    expect(first?.organizationId).toBe("anonymous");
    expect(first?.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.agentId).toBe(first?.userId);
    expect(first?.agent.execution_tier).toBe("shared");
    expect(isCanonicalPersonalSharedAgent(first!.agent)).toBe(false);
  });

  test("isolates every CallSid even when Twilio reports the same caller number", async () => {
    const first = await resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER, {
      accountSid: "AC123",
      callSid: "CA-first",
    });
    const next = await resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER, {
      accountSid: "AC123",
      callSid: "CA-next",
    });

    expect(next?.userId).not.toBe(first?.userId);
    expect(next?.agentId).not.toBe(first?.agentId);
  });

  test("rejects an unconfigured destination before deriving a guest", async () => {
    await expect(
      resolveTwilioVoiceTarget(publicEnv, "+12525914471", {
        accountSid: "AC123",
        callSid: "CA123",
      }),
    ).resolves.toBeNull();
  });
});
