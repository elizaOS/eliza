/**
 * Tests for @milaidy/capacitor-location — geolocation, watches, error codes, permissions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LocationWeb } from "../../plugins/location/src/web";

describe("@milaidy/capacitor-location", () => {
  let loc: LocationWeb;

  beforeEach(() => {
    vi.restoreAllMocks();
    loc = new LocationWeb();
  });

  // -- Watch management --

  describe("watches", () => {
    it("clearWatch on unknown id is a no-op", async () => {
      await expect(loc.clearWatch({ watchId: "nope" })).resolves.toBeUndefined();
    });

    it("watchPosition returns unique watch IDs", async () => {
      vi.spyOn(navigator.geolocation, "watchPosition").mockReturnValueOnce(1).mockReturnValueOnce(2);
      const { watchId: a } = await loc.watchPosition();
      const { watchId: b } = await loc.watchPosition();
      expect(a).toMatch(/^watch-/);
      expect(a).not.toBe(b);
    });

    it("clearWatch delegates to native clearWatch with mapped id", async () => {
      vi.spyOn(navigator.geolocation, "watchPosition").mockReturnValueOnce(42);
      const clear = vi.spyOn(navigator.geolocation, "clearWatch");
      const { watchId } = await loc.watchPosition();
      await loc.clearWatch({ watchId });
      expect(clear).toHaveBeenCalledWith(42);
    });

    it("second clearWatch on same id is a no-op", async () => {
      vi.spyOn(navigator.geolocation, "watchPosition").mockReturnValueOnce(1);
      const clear = vi.spyOn(navigator.geolocation, "clearWatch");
      const { watchId } = await loc.watchPosition();
      await loc.clearWatch({ watchId });
      clear.mockClear();
      await loc.clearWatch({ watchId });
      expect(clear).not.toHaveBeenCalled();
    });

    it("multiple watches can be cleared independently", async () => {
      vi.spyOn(navigator.geolocation, "watchPosition").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);
      const clear = vi.spyOn(navigator.geolocation, "clearWatch");

      const w = await Promise.all([loc.watchPosition(), loc.watchPosition(), loc.watchPosition()]);
      await loc.clearWatch({ watchId: w[1].watchId });
      expect(clear).toHaveBeenCalledWith(2);
    });
  });

  // -- getCurrentPosition error codes --

  describe("getCurrentPosition errors", () => {
    const geoErr = (code: number, message: string) => ({
      code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
    } as GeolocationPositionError);

    it.each([
      [1, "PERMISSION_DENIED"],
      [2, "POSITION_UNAVAILABLE"],
      [3, "TIMEOUT"],
      [99, "UNKNOWN"],
    ])("error code %i maps to %s", async (code, expected) => {
      vi.spyOn(navigator.geolocation, "getCurrentPosition").mockImplementation(
        (_ok, err) => err!(geoErr(code, "msg")),
      );
      await expect(loc.getCurrentPosition()).rejects.toEqual({ code: expected, message: "msg" });
    });
  });

  // -- getCurrentPosition success --

  describe("getCurrentPosition success", () => {
    const mockPos = (overrides: Partial<GeolocationCoordinates> = {}): GeolocationPosition => ({
      coords: {
        latitude: 37.77, longitude: -122.42, altitude: null, accuracy: 15,
        altitudeAccuracy: null, speed: null, heading: null, ...overrides,
      },
      timestamp: 1700000000000,
    } as GeolocationPosition);

    it("maps coordinates correctly", async () => {
      vi.spyOn(navigator.geolocation, "getCurrentPosition").mockImplementation(
        (ok) => ok(mockPos({ altitude: 10.5, altitudeAccuracy: 5, speed: 2.3, heading: 45 })),
      );
      const r = await loc.getCurrentPosition();
      expect(r.coords.latitude).toBe(37.77);
      expect(r.coords.altitude).toBe(10.5);
      expect(r.coords.speed).toBe(2.3);
      expect(r.cached).toBe(false);
    });

    it("maps null optional fields to undefined", async () => {
      vi.spyOn(navigator.geolocation, "getCurrentPosition").mockImplementation(
        (ok) => ok(mockPos()),
      );
      const r = await loc.getCurrentPosition();
      expect(r.coords.altitude).toBeUndefined();
      expect(r.coords.altitudeAccuracy).toBeUndefined();
      expect(r.coords.speed).toBeUndefined();
      expect(r.coords.heading).toBeUndefined();
    });

    it("passes accuracy, timeout, maxAge options", async () => {
      const spy = vi.spyOn(navigator.geolocation, "getCurrentPosition").mockImplementation(
        (ok) => ok(mockPos()),
      );
      await loc.getCurrentPosition({ accuracy: "best", timeout: 5000, maxAge: 3000 });
      expect(spy).toHaveBeenCalledWith(
        expect.any(Function), expect.any(Function),
        expect.objectContaining({ enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 }),
      );
    });
  });

  // -- Permissions --

  describe("permissions", () => {
    it.each([
      ["granted", "granted"],
      ["denied", "denied"],
      ["prompt", "prompt"],
    ])("checkPermissions maps %s state", async (state, expected) => {
      vi.spyOn(navigator.permissions, "query").mockResolvedValueOnce({ state } as PermissionStatus);
      expect((await loc.checkPermissions()).location).toBe(expected);
    });

    it("checkPermissions falls back to prompt on query failure", async () => {
      vi.spyOn(navigator.permissions, "query").mockRejectedValueOnce(new Error("nope"));
      expect((await loc.checkPermissions()).location).toBe("prompt");
    });
  });
});
