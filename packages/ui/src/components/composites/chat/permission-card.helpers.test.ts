/**
 * Unit tests for permission card helpers: validates label lookups and text parser.
 */
import { describe, expect, it } from "vitest";
import {
  parseFeatureRef,
  parsePermissionRequestFromText,
} from "./permission-card.helpers.ts";

describe("permission-card.helpers", () => {
  it("parses feature reference string into app and action", () => {
    expect(parseFeatureRef("browser.navigate.open")).toEqual({
      app: "browser",
      action: "navigate.open",
    });
  });

  it("parses permission_request markdown fenced json blocks", () => {
    const text =
      'I need access:\n```json\n{\n  "action": "permission_request",\n  "permission": "camera",\n  "reason": "take photo",\n  "feature": "camera.capture"\n}\n```';
    const parsed = parsePermissionRequestFromText(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.permission).toBe("camera");
    expect(parsed?.payload.reason).toBe("take photo");
  });
});
