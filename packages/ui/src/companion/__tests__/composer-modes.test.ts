import { describe, expect, it } from "vitest";
import { describeRightButton } from "../ComposerBar";

describe("companion/ComposerBar describeRightButton", () => {
  it("returns voice when idle and no text", () => {
    expect(describeRightButton({ hasText: false, mode: "idle" })).toBe("voice");
  });

  it("returns send when text is present and idle", () => {
    expect(describeRightButton({ hasText: true, mode: "idle" })).toBe("send");
  });

  it("returns check when dictate mode is active", () => {
    expect(describeRightButton({ hasText: false, mode: "dictate" })).toBe(
      "check",
    );
    expect(describeRightButton({ hasText: true, mode: "dictate" })).toBe(
      "check",
    );
  });

  it("voice mode without text still returns voice (stop button rendered separately)", () => {
    expect(describeRightButton({ hasText: false, mode: "voice" })).toBe(
      "voice",
    );
  });

  it("text wins over voice mode (allows sending while voice listening)", () => {
    expect(describeRightButton({ hasText: true, mode: "voice" })).toBe("send");
  });
});
