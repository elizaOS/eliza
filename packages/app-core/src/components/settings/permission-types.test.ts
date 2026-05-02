import { describe, expect, it } from "vitest";
import { CAPABILITIES, SYSTEM_PERMISSIONS } from "./permission-types";

describe("computer-use permission metadata", () => {
  it("declares computer use as a capability with the required permissions", () => {
    expect(CAPABILITIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "computeruse",
          requiredPermissions: ["accessibility", "screen-recording"],
        }),
      ]),
    );
  });

  it("marks the relevant system permissions as required for computer use", () => {
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
