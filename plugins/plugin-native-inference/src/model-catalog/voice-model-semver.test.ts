import { describe, expect, it } from "vitest";
import { compareVoiceModelSemver } from "./voice-models.js";

describe("voice model update precedence", () => {
  it("compares dot-separated numeric prerelease identifiers numerically", () => {
    expect(compareVoiceModelSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVoiceModelSemver("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
  });
  it("orders release, numeric, textual, and additional prerelease identifiers", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVoiceModelSemver(ordered[i - 1], ordered[i])).toBe(-1);
    }
    expect(compareVoiceModelSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareVoiceModelSemver("invalid", "1.0.0")).toBeNull();
  });
});
