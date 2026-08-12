/** Verifies renderer reconciliation cannot overwrite the authoritative native macOS notification state. */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AllPermissionsState, PermissionState } from "../../api";
import {
  type DesktopPermissionsSnapshot,
  reconcileRendererMediaPermissions,
} from "./permission-controls.hooks";

function notificationState(
  platform: PermissionState["platform"],
  status: PermissionState["status"],
): PermissionState {
  return {
    id: "notifications",
    platform,
    status,
    canRequest: status === "not-determined",
    lastChecked: 1,
  };
}

function snapshot(
  notification: PermissionState,
  nativeBridgeAvailable = true,
): DesktopPermissionsSnapshot {
  return {
    permissions: {
      notifications: notification,
    } as AllPermissionsState,
    platform: notification.platform,
    shellEnabled: true,
    nativeBridgeAvailable,
  };
}

describe("renderer permission reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the signed macOS host's notification decision", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    const native = snapshot(notificationState("darwin", "denied"));

    await expect(reconcileRendererMediaPermissions(native)).resolves.toBe(
      native,
    );
  });

  it("retains the renderer notification fallback on Windows", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const native = snapshot(notificationState("win32", "not-determined"));

    await expect(reconcileRendererMediaPermissions(native)).resolves.toEqual({
      ...native,
      permissions: {
        ...native.permissions,
        notifications: expect.objectContaining({
          status: "granted",
          canRequest: false,
        }),
      },
    });
  });

  it("retains the renderer notification fallback in a macOS web browser", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    const web = snapshot(notificationState("darwin", "not-determined"), false);

    await expect(reconcileRendererMediaPermissions(web)).resolves.toEqual({
      ...web,
      permissions: {
        ...web.permissions,
        notifications: expect.objectContaining({
          status: "granted",
          canRequest: false,
        }),
      },
    });
  });
});
