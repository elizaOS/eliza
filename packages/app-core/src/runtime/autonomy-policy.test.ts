import { describe, expect, it } from "vitest";
import { isRuntimeAutonomyEnabled } from "./autonomy-policy";

describe("runtime autonomy policy", () => {
  it("defaults autonomy on for existing deployments", () => {
    expect(isRuntimeAutonomyEnabled({})).toBe(true);
  });

  it("disables autonomy when ENABLE_AUTONOMY=false", () => {
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "false" })).toBe(false);
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "FALSE" })).toBe(false);
  });

  it("leaves autonomy enabled for other explicit values", () => {
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "true" })).toBe(true);
    expect(isRuntimeAutonomyEnabled({ ENABLE_AUTONOMY: "1" })).toBe(true);
  });
});
