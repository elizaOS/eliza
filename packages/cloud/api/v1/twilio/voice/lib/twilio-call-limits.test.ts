/** Verifies call duration and cross-worker revoke retention stay aligned. */

import { describe, expect, test } from "bun:test";
import {
  resolveTwilioMaxCallSeconds,
  resolveTwilioSessionDirectoryExpSeconds,
} from "./twilio-call-limits";

describe("Twilio call limits", () => {
  test("retains the session directory for a full call after delayed media bootstrap", () => {
    const bootstrapExpSeconds = 10_120;
    const env = { TWILIO_VOICE_MAX_CALL_SECONDS: "1800" };

    expect(resolveTwilioMaxCallSeconds(env)).toBe(1_800);
    expect(
      resolveTwilioSessionDirectoryExpSeconds(bootstrapExpSeconds, env),
    ).toBe(11_920);
  });

  test("defaults invalid call limits to thirty minutes", () => {
    expect(resolveTwilioMaxCallSeconds({})).toBe(1_800);
    expect(
      resolveTwilioMaxCallSeconds({ TWILIO_VOICE_MAX_CALL_SECONDS: "bad" }),
    ).toBe(1_800);
    expect(
      resolveTwilioMaxCallSeconds({ TWILIO_VOICE_MAX_CALL_SECONDS: "999999" }),
    ).toBe(86_400);
  });
});
