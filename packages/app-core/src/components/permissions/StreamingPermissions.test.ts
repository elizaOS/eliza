import { describe, expect, it } from "vitest";
import {
  isStreamingPermissionVisibleForMode,
  type MediaPermissionDef,
} from "./StreamingPermissions";

const sharedPermission: MediaPermissionDef = {
  id: "camera",
  name: "Camera",
  nameKey: "camera",
  description: "Camera",
  descriptionKey: "camera.description",
  icon: "camera",
};

const webOnlyPermission: MediaPermissionDef = {
  id: "screen",
  name: "Screen",
  nameKey: "screen",
  description: "Screen",
  descriptionKey: "screen.description",
  icon: "monitor",
  modes: ["web"],
};

describe("isStreamingPermissionVisibleForMode", () => {
  it("shows shared permissions on web and mobile", () => {
    expect(isStreamingPermissionVisibleForMode(sharedPermission, "web")).toBe(
      true,
    );
    expect(
      isStreamingPermissionVisibleForMode(sharedPermission, "mobile"),
    ).toBe(true);
  });

  it("shows screen sharing on web but hides it on mobile", () => {
    expect(isStreamingPermissionVisibleForMode(webOnlyPermission, "web")).toBe(
      true,
    );
    expect(
      isStreamingPermissionVisibleForMode(webOnlyPermission, "mobile"),
    ).toBe(false);
  });
});
