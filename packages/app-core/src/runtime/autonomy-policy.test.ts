import { describe, expect, it } from "vitest";
import { isRuntimeAutonomyEnabled } from "./autonomy-policy";

describe("runtime autonomy policy", () => {
  it("defaults the autonomy loop off", () => {
    expect(isRuntimeAutonomyEnabled({})).toBe(false);
  });

  it("disables autonomy when ENABLE_AUTONOMY=false", () => {
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "false" })).toBe(false);
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "FALSE" })).toBe(false);
  });

  it("enables autonomy for explicit true values", () => {
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "true" })).toBe(true);
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "1" })).toBe(true);
  });

  it("leaves autonomy disabled for other explicit values", () => {
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "yes" })).toBe(false);
  });
});
