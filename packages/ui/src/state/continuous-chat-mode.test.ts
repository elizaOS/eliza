/**
 * Covers the pure continuous-voice boot policy, including the untrusted public
 * URL boundary and the trusted native-appliance opt-in.
 */
import { describe, expect, it } from "vitest";
import { resolveContinuousChatMode } from "./continuous-chat-mode";

describe("continuous chat mode boot policy", () => {
  it("keeps normal installs and forged public appliance links off", () => {
    expect(resolveContinuousChatMode(null, "")).toBe("off");
    expect(resolveContinuousChatMode(null, "?elizaOSAlwaysOnVoice=1")).toBe(
      "off",
    );
  });

  it("starts a fresh profile only for a trusted native appliance host", () => {
    expect(
      resolveContinuousChatMode(null, "?elizaOSAlwaysOnVoice=1", true),
    ).toBe("always-on");
  });

  it("honors an explicit device-local choice over appliance defaults", () => {
    expect(
      resolveContinuousChatMode("off", "?elizaOSAlwaysOnVoice=1", true),
    ).toBe("off");
    expect(resolveContinuousChatMode("vad-gated", "")).toBe("vad-gated");
  });
});
