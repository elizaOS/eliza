/**
 * Unit coverage for the desktop permission client's runtime-permission merge.
 *
 * Focus: the security-relevant `website-blocking` control must NOT keep an
 * optimistic bridged snapshot when its authoritative runtime check fails.
 * A failed check has to fail closed to an explicit unverified state so the
 * permissions UI cannot advertise a blocking control as enforced when the
 * runtime could not confirm it.
 */
import type { AllPermissionsState, PermissionState } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeRuntimePermissions } from "./desktop-permissions-client";

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
