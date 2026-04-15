import { describe, expect, it } from "vitest";
import { CAPABILITIES, SYSTEM_PERMISSIONS } from "./permission-types";

describe("computer use permission metadata", () => {
  it("declares Computer Use as a capability with required desktop permissions", () => {
    const computerUse = CAPABILITIES.find(
      (capability) => capability.id === "computeruse",
    );

    expect(computerUse).toBeDefined();
    expect(computerUse?.requiredPermissions).toEqual([
      "accessibility",
      "screen-recording",
    ]);
  });

  it("maps accessibility and screen recording back to the computeruse feature", () => {
    const accessibility = SYSTEM_PERMISSIONS.find(
      (permission) => permission.id === "accessibility",
    );
    const screenRecording = SYSTEM_PERMISSIONS.find(
      (permission) => permission.id === "screen-recording",
    );

    expect(accessibility?.requiredForFeatures).toContain("computeruse");
    expect(screenRecording?.requiredForFeatures).toContain("computeruse");
  });
});
