/**
 * Covers desktop permission authority, focused native refreshes, and runtime
 * merge behavior. Security controls fail closed when their authoritative
 * source cannot verify them, while non-macOS notifications retain the renderer
 * API that supplies their concrete platform state.
 */
import type { AllPermissionsState, PermissionState } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeDesktopBridgeRequestMock = vi.hoisted(() => vi.fn());
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: invokeDesktopBridgeRequestMock,
}));

import {
  checkDesktopPermissionFresh,
  installDesktopPermissionsClientPatch,
  mergeRuntimePermissions,
} from "./desktop-permissions-client";

const warnSpy = vi.fn();
vi.mock("@elizaos/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    info: () => {},
    debug: () => {},
  },
}));

function permissionState(
  overrides: Partial<PermissionState> = {},
): PermissionState {
  return {
    id: "website-blocking",
    status: "granted",
    canRequest: false,
    lastChecked: 0,
    platform: "darwin",
    ...overrides,
  } as PermissionState;
}

function baseSnapshot(websiteBlocking: PermissionState): AllPermissionsState {
  // Only the runtime permission id is exercised here; other ids are carried
  // through untouched by mergeRuntimePermissions.
  return {
    "website-blocking": websiteBlocking,
  } as unknown as AllPermissionsState;
}

afterEach(() => {
  warnSpy.mockClear();
  invokeDesktopBridgeRequestMock.mockReset();
  vi.unstubAllGlobals();
});

describe("mergeRuntimePermissions", () => {
  it("uses the authoritative runtime check when it succeeds", async () => {
    const snapshot = baseSnapshot(
      permissionState({ status: "granted", canRequest: false }),
    );
    const getPermission = vi.fn().mockResolvedValue(
      permissionState({
        status: "denied",
        canRequest: true,
        lastChecked: 123,
      }),
    );

    const merged = await mergeRuntimePermissions(
      snapshot,
      getPermission as never,
    );

    expect(merged["website-blocking"].status).toBe("denied");
    expect(merged["website-blocking"].canRequest).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fails closed to an unverified state when the runtime check throws (does not keep an optimistic granted snapshot)", async () => {
    const snapshot = baseSnapshot(
      // The bridged desktop-shell snapshot optimistically reports the blocking
      // control as enforced.
      permissionState({ status: "granted", canRequest: false }),
    );
    const getPermission = vi
      .fn()
      .mockRejectedValue(new Error("runtime route unreachable"));

    const merged = await mergeRuntimePermissions(
      snapshot,
      getPermission as never,
    );

    const result = merged["website-blocking"];
    // Must NOT continue advertising the unconfirmable control as granted.
    expect(result.status).not.toBe("granted");
    expect(result.status).toBe("not-determined");
    expect(result.canRequest).toBe(true);
    expect(typeof result.reason).toBe("string");
    expect(result.reason).toMatch(/unverified|unavailable/i);
    expect(result.id).toBe("website-blocking");
  });

  it("logs an observable warning when the runtime check throws", async () => {
    const snapshot = baseSnapshot(permissionState({ status: "granted" }));
    const getPermission = vi.fn().mockRejectedValue(new Error("boom"));

    await mergeRuntimePermissions(snapshot, getPermission as never);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [context, message] = warnSpy.mock.calls[0];
    expect(context).toMatchObject({ permissionId: "website-blocking" });
    expect(String(message)).toContain("[desktop-permissions]");
  });

  it("preserves the resolved platform of the previous snapshot on failure", async () => {
    const snapshot = baseSnapshot(
      permissionState({ status: "granted", platform: "win32" }),
    );
    const getPermission = vi.fn().mockRejectedValue(new Error("nope"));

    const merged = await mergeRuntimePermissions(
      snapshot,
      getPermission as never,
    );

    expect(merged["website-blocking"].platform).toBe("win32");
    expect(merged["website-blocking"].status).toBe("not-determined");
  });
});

describe("installDesktopPermissionsClientPatch", () => {
  it("force-refreshes only the permission being re-checked", async () => {
    const fresh = permissionState({
      id: "notifications",
      status: "granted",
      canRequest: false,
    });
    invokeDesktopBridgeRequestMock.mockResolvedValue(fresh);

    await expect(checkDesktopPermissionFresh("notifications")).resolves.toEqual(
      fresh,
    );
    expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith({
      rpcMethod: "permissionsCheck",
      ipcChannel: "permissions:check",
      params: { id: "notifications", forceRefresh: true },
    });
  });

  it("keeps native notification authorization authoritative when WKWebView misreports its platform", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const requestRendererPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", {
      permission: "denied",
      requestPermission: requestRendererPermission,
    });
    const bridged = permissionState({
      id: "notifications",
      status: "not-determined",
      canRequest: true,
    });
    invokeDesktopBridgeRequestMock.mockResolvedValue(bridged);
    const requestPermission = vi.fn(async (_id: PermissionState["id"]) =>
      permissionState({ id: "notifications", status: "denied" }),
    );
    const client = {
      getPermissions: vi.fn(),
      getPermission: vi.fn(),
      requestPermission,
      openPermissionSettings: vi.fn(),
      refreshPermissions: vi.fn(),
      setShellEnabled: vi.fn(),
      isShellEnabled: vi.fn(),
    };

    const restore = installDesktopPermissionsClientPatch(client as never);
    try {
      await expect(client.getPermission("notifications")).resolves.toEqual(
        bridged,
      );
      await expect(client.requestPermission("notifications")).resolves.toEqual(
        bridged,
      );
      expect(invokeDesktopBridgeRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcMethod: "permissionsRequest",
          params: { id: "notifications" },
        }),
      );
      expect(requestRendererPermission).not.toHaveBeenCalled();
      expect(requestPermission).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("keeps the renderer notification fallback on non-macOS desktops", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });
    invokeDesktopBridgeRequestMock.mockResolvedValue(
      permissionState({
        id: "notifications",
        status: "not-determined",
        canRequest: true,
        platform: "win32",
      }),
    );
    const originalRequestPermission = vi.fn();
    const client = {
      getPermissions: vi.fn(),
      getPermission: vi.fn(),
      requestPermission: originalRequestPermission,
      openPermissionSettings: vi.fn(),
      refreshPermissions: vi.fn(),
      setShellEnabled: vi.fn(),
      isShellEnabled: vi.fn(),
    };

    const restore = installDesktopPermissionsClientPatch(client as never);
    try {
      await expect(client.requestPermission("notifications")).resolves.toEqual(
        expect.objectContaining({
          id: "notifications",
          status: "granted",
          canRequest: false,
          platform: "win32",
        }),
      );
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(originalRequestPermission).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("keeps the renderer notification fallback in a macOS web browser", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });
    invokeDesktopBridgeRequestMock.mockResolvedValue(null);
    const originalGetPermission = vi.fn();
    const originalRequestPermission = vi.fn();
    const client = {
      getPermissions: vi.fn(),
      getPermission: originalGetPermission,
      requestPermission: originalRequestPermission,
      openPermissionSettings: vi.fn(),
      refreshPermissions: vi.fn(),
      setShellEnabled: vi.fn(),
      isShellEnabled: vi.fn(),
    };

    const restore = installDesktopPermissionsClientPatch(client as never);
    try {
      await expect(client.getPermission("notifications")).resolves.toEqual(
        expect.objectContaining({
          id: "notifications",
          status: "not-determined",
          platform: "darwin",
        }),
      );
      await expect(client.requestPermission("notifications")).resolves.toEqual(
        expect.objectContaining({
          id: "notifications",
          status: "granted",
          platform: "darwin",
        }),
      );
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(originalGetPermission).not.toHaveBeenCalled();
      expect(originalRequestPermission).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
