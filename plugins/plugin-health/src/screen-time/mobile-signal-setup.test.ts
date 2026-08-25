/**
 * Covers mobile signal setup badge and label helpers.
 * Pins the status-to-variant mapping and permission-target resolution so the
 * screen-time UI never shows the wrong badge or requests the wrong permission.
 */
import { describe, expect, it, vi } from "vitest";

import {
  mobileSignalPermissionTargetForAction,
  mobileSignalSetupActionBadge,
  mobileSignalSetupPrimaryActionLabel,
} from "./mobile-signal-setup";

function t(key: string, opts?: { defaultValue?: string }): string {
  return opts?.defaultValue ?? key;
}

describe("mobileSignalSetupActionBadge", () => {
  it("returns secondary Ready for ready status", () => {
    const res = mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "ready", canRequest: false },
      t,
    );
    expect(res.variant).toBe("secondary");
    expect(res.label).toBe("Ready");
  });

  it("returns outline Unavailable for unavailable status", () => {
    const res = mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "unavailable", canRequest: false },
      t,
    );
    expect(res.variant).toBe("outline");
    expect(res.label).toBe("Unavailable");
  });

  it("returns outline Needs action for other statuses", () => {
    const res = mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "needs_action", canRequest: false },
      t,
    );
    expect(res.variant).toBe("outline");
    expect(res.label).toBe("Needs action");
  });

  it("handles unknown string status as Needs action", () => {
    const res = mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "custom", canRequest: false },
      t,
    );
    expect(res.label).toBe("Needs action");
    expect(res.variant).toBe("outline");
  });

  it("calls translator with correct keys", () => {
    const spy = vi.fn(
      (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    );
    mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "ready", canRequest: false },
      spy,
    );
    expect(spy).toHaveBeenCalledWith(
      "lifeopssettings.deviceSetupReady",
      expect.any(Object),
    );
    spy.mockClear();
    mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "unavailable", canRequest: false },
      spy,
    );
    expect(spy).toHaveBeenCalledWith(
      "lifeopssettings.deviceSetupUnavailable",
      expect.any(Object),
    );
    spy.mockClear();
    mobileSignalSetupActionBadge(
      { id: "a", label: "x", status: "other", canRequest: false },
      spy,
    );
    expect(spy).toHaveBeenCalledWith(
      "lifeopssettings.deviceSetupNeedsAction",
      expect.any(Object),
    );
  });
});

describe("mobileSignalSetupPrimaryActionLabel", () => {
  it("returns Grant when canRequest is true", () => {
    expect(
      mobileSignalSetupPrimaryActionLabel(
        { id: "a", label: "x", status: "ready", canRequest: true },
        t,
      ),
    ).toBe("Grant");
  });

  it("returns Open Settings when canRequest is false", () => {
    expect(
      mobileSignalSetupPrimaryActionLabel(
        { id: "a", label: "x", status: "ready", canRequest: false },
        t,
      ),
    ).toBe("Open Settings");
  });

  it("uses translator keys", () => {
    const spy = vi.fn(
      (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    );
    mobileSignalSetupPrimaryActionLabel(
      { id: "a", label: "x", status: "ready", canRequest: true },
      spy,
    );
    expect(spy).toHaveBeenCalledWith(
      "lifeopssettings.deviceSetupGrant",
      expect.any(Object),
    );
    spy.mockClear();
    mobileSignalSetupPrimaryActionLabel(
      { id: "a", label: "x", status: "ready", canRequest: false },
      spy,
    );
    expect(spy).toHaveBeenCalledWith(
      "lifeopssettings.deviceSetupOpenSettings",
      expect.any(Object),
    );
  });
});

describe("mobileSignalPermissionTargetForAction", () => {
  it("maps known action IDs to permission targets", () => {
    expect(
      mobileSignalPermissionTargetForAction({ id: "health_permissions" }),
    ).toBe("health");
    expect(
      mobileSignalPermissionTargetForAction({
        id: "screen_time_authorization",
      }),
    ).toBe("screenTime");
    expect(
      mobileSignalPermissionTargetForAction({ id: "notification_settings" }),
    ).toBe("notifications");
  });

  it("returns null for unknown IDs", () => {
    expect(mobileSignalPermissionTargetForAction({ id: "unknown" })).toBeNull();
    expect(mobileSignalPermissionTargetForAction({ id: "" })).toBeNull();
    expect(mobileSignalPermissionTargetForAction({ id: "health" })).toBeNull();
  });
});
