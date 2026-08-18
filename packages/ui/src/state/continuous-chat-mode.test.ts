import { describe, expect, it } from "vitest";
import { resolveContinuousChatMode } from "./continuous-chat-mode";

describe("continuous chat mode boot policy", () => {
  it("keeps normal installs off even when a link requests always-on capture", () => {
    expect(resolveContinuousChatMode(null, "")).toBe("off");
    expect(resolveContinuousChatMode(null, "?elizaOSAlwaysOnVoice=1")).toBe(
      "off",
    );
  });

  it("honors the appliance default only inside a trusted native host", () => {
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
