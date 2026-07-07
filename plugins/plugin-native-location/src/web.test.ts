/**
 * Unit tests for `LocationWeb` (web.ts) against a stubbed `navigator.geolocation` /
 * `navigator.permissions` — no real browser geolocation hardware is exercised.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationWeb } from "./web";

type GeoSuccess = (position: GeolocationPosition) => void;
type GeoError = (error: GeolocationPositionError) => void;

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function position(): GeolocationPosition {
  return {
    coords: {
      latitude: 37.7,
      longitude: -122.4,
      altitude: null,
      accuracy: 5,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 123,
  } as GeolocationPosition;
}

function geoError(
  code: number,
  message = "geo failed",
): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  } as GeolocationPositionError;
}

describe("LocationWeb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps getCurrentPosition options and normalizes nullable coordinates", async () => {
    const getCurrentPosition = vi.fn(
      (success: GeoSuccess, _error: GeoError, options?: PositionOptions) => {
        expect(options).toEqual({
          enableHighAccuracy: true,
          maximumAge: 50,
          timeout: 250,
        });
        success(position());
      },
    );
    setNavigator({
      geolocation: { getCurrentPosition } as unknown as Geolocation,
    });

    await expect(
      new LocationWeb().getCurrentPosition({
        accuracy: "best",
        maxAge: 50,
        timeout: 250,
      }),
    ).resolves.toEqual({
      coords: {
        latitude: 37.7,
        longitude: -122.4,
        altitude: undefined,
        accuracy: 5,
        altitudeAccuracy: undefined,
        speed: undefined,
        heading: undefined,
        timestamp: 123,
      },
      cached: false,
    });
  });

  it.each([
    [1, "PERMISSION_DENIED"],
    [2, "POSITION_UNAVAILABLE"],
    [3, "TIMEOUT"],
    [999, "UNKNOWN"],
  ])("maps geolocation error code %s to %s", async (code, expected) => {
    const getCurrentPosition = vi.fn(
      (_success: GeoSuccess, error: GeoError) => {
        error(geoError(code));
      },
    );
    setNavigator({
      geolocation: { getCurrentPosition } as unknown as Geolocation,
    });

    await expect(new LocationWeb().getCurrentPosition()).rejects.toEqual({
      code: expected,
      message: "geo failed",
    });
  });

  it("tracks and clears watch ids without leaking native watches", async () => {
    const clearWatch = vi.fn();
    const watchPosition = vi.fn(
      (success: GeoSuccess, _error: GeoError, options?: PositionOptions) => {
        expect(options?.enableHighAccuracy).toBe(false);
        success(position());
        return 42;
      },
    );
    const plugin = new LocationWeb();
    const notify = vi
      .spyOn(
        plugin as unknown as {
          notifyListeners: (...args: unknown[]) => Promise<void>;
        },
        "notifyListeners",
      )
      .mockResolvedValue(undefined);
    setNavigator({
      geolocation: { watchPosition, clearWatch } as unknown as Geolocation,
    });

    const { watchId } = await plugin.watchPosition({ accuracy: "low" });
    expect(watchId).toMatch(/^watch-/);
    expect(notify).toHaveBeenCalledWith(
      "locationChange",
      expect.objectContaining({ cached: false }),
    );

    await plugin.clearWatch({ watchId });
    await plugin.clearWatch({ watchId });
    expect(clearWatch).toHaveBeenCalledTimes(1);
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  it.each([
    ["getCurrentPosition", { timeout: Number.POSITIVE_INFINITY }],
    ["getCurrentPosition", { maxAge: -1 }],
    ["watchPosition", { timeout: 0 }],
    ["watchPosition", { maxAge: Number.NaN }],
    ["watchPosition", { minDistance: -1 }],
    ["watchPosition", { minInterval: Number.POSITIVE_INFINITY }],
  ] as const)("rejects hostile %s options %#", async (method, options) => {
    setNavigator({
      geolocation: {
        getCurrentPosition: vi.fn(),
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      } as unknown as Geolocation,
    });

    const plugin = new LocationWeb();
    await expect(plugin[method](options)).rejects.toThrow(
      /must be .*finite number/,
    );
  });

  it("emits structured watch errors for geolocation failures", async () => {
    const watchPosition = vi.fn((_success: GeoSuccess, error: GeoError) => {
      error(geoError(2, "offline"));
      return 7;
    });
    const plugin = new LocationWeb();
    const notify = vi
      .spyOn(
        plugin as unknown as {
          notifyListeners: (...args: unknown[]) => Promise<void>;
        },
        "notifyListeners",
      )
      .mockResolvedValue(undefined);
    setNavigator({
      geolocation: {
        watchPosition,
        clearWatch: vi.fn(),
      } as unknown as Geolocation,
    });

    await expect(plugin.watchPosition()).resolves.toEqual({
      watchId: expect.stringMatching(/^watch-/),
    });
    expect(notify).toHaveBeenCalledWith("error", {
      code: "POSITION_UNAVAILABLE",
      message: "offline",
    });
  });

  it("fails explicitly when the geolocation API is unavailable", async () => {
    setNavigator({});

    await expect(new LocationWeb().getCurrentPosition()).rejects.toThrow(
      "Geolocation API is not available",
    );
  });

  it("normalizes permission query states and falls back to prompt on query errors", async () => {
    for (const [state, expected] of [
      ["granted", "granted"],
      ["denied", "denied"],
      ["prompt", "prompt"],
    ] as const) {
      setNavigator({
        permissions: {
          query: vi.fn(async () => ({ state })),
        } as unknown as Permissions,
      });
      await expect(new LocationWeb().checkPermissions()).resolves.toEqual({
        location: expected,
      });
    }

    setNavigator({
      permissions: {
        query: vi.fn(async () => {
          throw new Error("unsupported");
        }),
      } as unknown as Permissions,
    });
    await expect(new LocationWeb().checkPermissions()).resolves.toEqual({
      location: "prompt",
    });
  });

  it("uses current-position request outcome to infer requested permission", async () => {
    const granted = new LocationWeb();
    vi.spyOn(granted, "getCurrentPosition").mockResolvedValue({
      coords: {
        latitude: 0,
        longitude: 0,
        accuracy: 1,
        timestamp: 1,
      },
      cached: false,
    });
    await expect(granted.requestPermissions()).resolves.toEqual({
      location: "granted",
    });

    const denied = new LocationWeb();
    vi.spyOn(denied, "getCurrentPosition").mockRejectedValue({
      code: "PERMISSION_DENIED",
    });
    await expect(denied.requestPermissions()).resolves.toEqual({
      location: "denied",
    });
  });
});
