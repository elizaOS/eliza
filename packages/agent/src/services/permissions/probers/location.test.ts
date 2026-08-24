/**
 * Unit coverage for the location permission prober. Drives the real module
 * through Darwin CoreLocation status mapping, the missing-dylib TCC.db
 * fallback, the non-Darwin renderer hand-off, and request() including the
 * privacy-pane fallback re-check. The FFI dylib, TCC reads, bundle-id
 * resolution, and System Settings are stubbed at the _bridge boundary;
 * mapNativePrivacyAuthStatus and buildState stay production helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type DylibFn = ReturnType<typeof vi.fn<() => number>>;

const bridgeMock = {
  darwin: true,
  dylib: null as {
    checkLocationPermission: DylibFn;
    requestLocationPermission: DylibFn;
  } | null,
  dylibError: null as Error | null,
  bundleId: "ai.elizaos.app",
  bundleError: null as Error | null,
  tcc: null as "granted" | "denied" | null,
  tccError: null as Error | null,
  tccArgs: [] as Array<[service: string, client: string]>,
  paneArgs: [] as string[],
  paneError: null as Error | null,
};

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  type NativeLib = Awaited<ReturnType<(typeof actual)["getNativeDylib"]>>;
  return {
    ...actual,
    get IS_DARWIN() {
      return bridgeMock.darwin;
    },
    getNativeDylib: (): Promise<NativeLib> =>
      bridgeMock.dylibError
        ? Promise.reject(bridgeMock.dylibError)
        : Promise.resolve(bridgeMock.dylib as NativeLib),
    queryTccStatus: (service: string, client: string) => {
      bridgeMock.tccArgs.push([service, client]);
      if (bridgeMock.tccError) return Promise.reject(bridgeMock.tccError);
      return Promise.resolve(bridgeMock.tcc);
    },
    resolveBundleId: () => {
      if (bridgeMock.bundleError) throw bridgeMock.bundleError;
      return bridgeMock.bundleId;
    },
    openPrivacyPane: (pane: string): Promise<void> => {
      bridgeMock.paneArgs.push(pane);
      if (bridgeMock.paneError) return Promise.reject(bridgeMock.paneError);
      return Promise.resolve(undefined);
    },
  };
});

import { locationProber } from "./location.ts";

function nativeLib(
  check: () => number,
  request: () => number = check,
): { checkLocationPermission: DylibFn; requestLocationPermission: DylibFn } {
  return {
    checkLocationPermission: vi.fn(check),
    requestLocationPermission: vi.fn(request),
  };
}

describe("locationProber", () => {
  beforeEach(() => {
    bridgeMock.darwin = true;
    bridgeMock.dylib = null;
    bridgeMock.dylibError = null;
    bridgeMock.bundleId = "ai.elizaos.app";
    bridgeMock.bundleError = null;
    bridgeMock.tcc = null;
    bridgeMock.tccError = null;
    bridgeMock.tccArgs = [];
    bridgeMock.paneArgs = [];
    bridgeMock.paneError = null;
    vi.restoreAllMocks();
  });

  it("exports id location with callable check and request", () => {
    expect(locationProber.id).toBe("location");
    expect(typeof locationProber.check).toBe("function");
    expect(typeof locationProber.request).toBe("function");
  });
});

describe("locationProber.check", () => {
  beforeEach(() => {
    bridgeMock.darwin = true;
    bridgeMock.dylib = null;
    bridgeMock.dylibError = null;
    bridgeMock.bundleId = "ai.elizaos.app";
    bridgeMock.bundleError = null;
    bridgeMock.tcc = null;
    bridgeMock.tccError = null;
    bridgeMock.tccArgs = [];
    bridgeMock.paneArgs = [];
    bridgeMock.paneError = null;
    vi.restoreAllMocks();
  });

  it("returns not-determined with canRequest on non-Darwin without touching native boundaries", async () => {
    bridgeMock.darwin = false;
    const before = Date.now();
    const state = await locationProber.check();
    expect(state).toMatchObject({
      id: "location",
      status: "not-determined",
      canRequest: true,
      platform: process.platform,
    });
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(state.restrictedReason).toBeUndefined();
    expect(bridgeMock.tccArgs).toEqual([]);
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it("queries per-user TCC.db with the location service and resolved bundle id when no dylib exists", async () => {
    const state = await locationProber.check();
    expect(bridgeMock.tccArgs).toEqual([
      ["kTCCServiceLocation", "ai.elizaos.app"],
    ]);
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it.each([
    [0, "not-determined", true],
    [1, "denied", false],
    [2, "granted", false],
    [3, "restricted", false],
    [4, "restricted", false],
  ] as const)(
    "maps native privacy status %i to %s (canRequest=%s)",
    async (code, status, canRequest) => {
      const lib = nativeLib(() => code);
      bridgeMock.dylib = lib;
      const state = await locationProber.check();
      expect(lib.checkLocationPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(status);
      expect(state.canRequest).toBe(canRequest);
      expect(state.id).toBe("location");
      expect(state.platform).toBe(process.platform);
    },
  );

  it.each([-1, 99])(
    "maps unknown native privacy status %i to not-determined",
    async (code) => {
      bridgeMock.dylib = nativeLib(() => code);
      const state = await locationProber.check();
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
    },
  );

  it("flags os_policy only on restricted native states", async () => {
    bridgeMock.dylib = nativeLib(() => 3);
    const restricted = await locationProber.check();
    expect(restricted.status).toBe("restricted");
    expect(restricted.restrictedReason).toBe("os_policy");

    bridgeMock.dylib = nativeLib(() => 2);
    const granted = await locationProber.check();
    expect(granted.status).toBe("granted");
    expect(granted.restrictedReason).toBeUndefined();

    bridgeMock.dylib = nativeLib(() => 1);
    const denied = await locationProber.check();
    expect(denied.status).toBe("denied");
    expect(denied.restrictedReason).toBeUndefined();
  });

  it("never queries TCC or requests permission while checking through the dylib", async () => {
    const lib = nativeLib(() => 2);
    bridgeMock.dylib = lib;
    await locationProber.check();
    expect(bridgeMock.tccArgs).toEqual([]);
    expect(lib.requestLocationPermission).not.toHaveBeenCalled();
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it("maps a granted TCC row to granted without canRequest", async () => {
    bridgeMock.tcc = "granted";
    const state = await locationProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(state.lastRequested).toBeUndefined();
  });

  it("maps a denied TCC row to denied without canRequest", async () => {
    bridgeMock.tcc = "denied";
    const state = await locationProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("treats a missing TCC row (null) as not-determined", async () => {
    bridgeMock.tcc = null;
    const state = await locationProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.lastRequested).toBeUndefined();
  });

  it("propagates a rejected dylib lookup", async () => {
    const failure = new Error("dylib lookup exploded");
    bridgeMock.dylibError = failure;
    await expect(locationProber.check()).rejects.toBe(failure);
  });

  it("propagates a synchronous native check failure", async () => {
    const failure = new Error("CoreLocation exploded");
    bridgeMock.dylib = nativeLib(() => {
      throw failure;
    });
    await expect(locationProber.check()).rejects.toBe(failure);
  });

  it("propagates a rejected TCC read", async () => {
    const failure = new Error("sqlite3 exploded");
    bridgeMock.tccError = failure;
    await expect(locationProber.check()).rejects.toBe(failure);
  });

  it("propagates a bundle-id resolution failure before reading TCC", async () => {
    const failure = new Error("no Info.plist");
    bridgeMock.bundleError = failure;
    await expect(locationProber.check()).rejects.toBe(failure);
    expect(bridgeMock.tccArgs).toEqual([]);
  });
});

describe("locationProber.request", () => {
  beforeEach(() => {
    bridgeMock.darwin = true;
    bridgeMock.dylib = null;
    bridgeMock.dylibError = null;
    bridgeMock.bundleId = "ai.elizaos.app";
    bridgeMock.bundleError = null;
    bridgeMock.tcc = null;
    bridgeMock.tccError = null;
    bridgeMock.tccArgs = [];
    bridgeMock.paneArgs = [];
    bridgeMock.paneError = null;
    vi.restoreAllMocks();
  });

  it("returns not-determined on non-Darwin, ignoring reason and skipping every boundary including the clock", async () => {
    bridgeMock.darwin = false;
    const frozen = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
    const withReason = await locationProber.request({
      reason: "assistant needs directions",
    });
    const otherReason = await locationProber.request({
      reason: "a different explanation",
    });
    expect(withReason).toMatchObject({
      id: "location",
      status: "not-determined",
      canRequest: true,
      platform: process.platform,
    });
    expect(withReason.lastRequested).toBeUndefined();
    expect(withReason.lastChecked).toBe(frozen);
    expect(otherReason.status).toBe("not-determined");
    expect(otherReason.canRequest).toBe(true);
    expect(clock).toHaveBeenCalledTimes(2);
    expect(bridgeMock.paneArgs).toEqual([]);
    expect(bridgeMock.tccArgs).toEqual([]);
  });

  it.each([
    [0, "not-determined", true, undefined],
    [1, "denied", false, undefined],
    [2, "granted", false, undefined],
    [3, "restricted", false, "os_policy"],
    [4, "restricted", false, "os_policy"],
  ] as const)(
    "requests natively and stamps lastRequested when mapping status %i to %s",
    async (code, status, canRequest, restrictedReason) => {
      const frozen = 1_700_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
      const lib = nativeLib(
        () => 99,
        () => code,
      );
      bridgeMock.dylib = lib;
      const state = await locationProber.request({ reason: "unit-test" });
      expect(clock).toHaveBeenCalledTimes(2);
      expect(lib.requestLocationPermission).toHaveBeenCalledTimes(1);
      expect(lib.checkLocationPermission).not.toHaveBeenCalled();
      expect(bridgeMock.paneArgs).toEqual([]);
      expect(state.status).toBe(status);
      expect(state.canRequest).toBe(canRequest);
      expect(state.restrictedReason).toBe(restrictedReason);
      expect(state.lastRequested).toBe(frozen);
    },
  );

  it("opens the LocationServices pane and re-checks through TCC when no dylib exists", async () => {
    const captured = 1_000;
    const later = 2_000;
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(captured);
    clock.mockReturnValue(later);
    bridgeMock.tcc = "granted";
    const state = await locationProber.request({ reason: "unit-test" });
    expect(bridgeMock.paneArgs).toEqual(["LocationServices"]);
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBe(captured);
    expect(state.lastChecked).toBe(later);
  });

  it("preserves a denied re-check over the fallback state", async () => {
    bridgeMock.tcc = "denied";
    const state = await locationProber.request({ reason: "unit-test" });
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(bridgeMock.paneArgs).toEqual(["LocationServices"]);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("preserves a still not-determined re-check with canRequest intact", async () => {
    bridgeMock.tcc = null;
    const state = await locationProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(bridgeMock.paneArgs).toEqual(["LocationServices"]);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("does not open System Settings when the native dylib handles the request", async () => {
    bridgeMock.dylib = nativeLib(() => 0);
    await locationProber.request({ reason: "unit-test" });
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it("never reaches a native symbol when no dylib exists and falls back to TCC", async () => {
    bridgeMock.tcc = "granted";
    const state = await locationProber.request({ reason: "unit-test" });
    expect(bridgeMock.tccArgs).toEqual([
      ["kTCCServiceLocation", "ai.elizaos.app"],
    ]);
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
  });

  it("propagates a rejected dylib lookup", async () => {
    const failure = new Error("dylib lookup exploded");
    bridgeMock.dylibError = failure;
    await expect(locationProber.request({ reason: "unit-test" })).rejects.toBe(
      failure,
    );
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it("propagates a synchronous native request failure without opening settings", async () => {
    const failure = new Error("CoreLocation refused");
    bridgeMock.dylib = nativeLib(
      () => 0,
      () => {
        throw failure;
      },
    );
    await expect(locationProber.request({ reason: "unit-test" })).rejects.toBe(
      failure,
    );
    expect(bridgeMock.paneArgs).toEqual([]);
  });

  it("does not fabricate a state when the privacy pane fails to open", async () => {
    const failure = new Error("open failed");
    bridgeMock.paneError = failure;
    await expect(locationProber.request({ reason: "unit-test" })).rejects.toBe(
      failure,
    );
    expect(bridgeMock.tccArgs).toEqual([]);
  });

  it("propagates a rejected follow-up TCC read during the fallback re-check", async () => {
    const failure = new Error("sqlite3 exploded on recheck");
    bridgeMock.paneArgs = [];
    bridgeMock.tccError = failure;
    await expect(locationProber.request({ reason: "unit-test" })).rejects.toBe(
      failure,
    );
    expect(bridgeMock.paneArgs).toEqual(["LocationServices"]);
  });
});
