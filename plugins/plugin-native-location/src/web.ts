/**
 * Browser/Electrobun implementation of the location bridge, backed by
 * `navigator.geolocation`. Loaded lazily via index.ts's `web` factory; the
 * iOS/Android bridges implement the same `LocationPlugin` interface natively.
 */
import { WebPlugin } from "@capacitor/core";

import type {
  LocationOptions,
  LocationPermissionStatus,
  LocationResult,
  WatchLocationOptions,
} from "./definitions";

/** Great-circle distance in meters between two coordinates (haversine). */
function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(a));
}

export class LocationWeb extends WebPlugin {
  private watches = new Map<string, number>();

  private getGeolocation(): Geolocation {
    if (!navigator.geolocation) {
      throw new Error("Geolocation API is not available");
    }
    return navigator.geolocation;
  }

  private normalizePositionOptions(options?: LocationOptions): PositionOptions {
    const maxAge = options?.maxAge ?? 0;
    const timeout = options?.timeout ?? 10000;
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      throw new Error("maxAge must be a non-negative finite number");
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("timeout must be a positive finite number");
    }
    // The shared contract defaults accuracy to "high", and the Android and
    // iOS bridges substitute "high" when the caller omits it. Resolve the
    // effective value the same way so an omitted accuracy is not silently
    // low accuracy on web.
    const accuracy = options?.accuracy ?? "high";
    return {
      enableHighAccuracy: accuracy === "best" || accuracy === "high",
      maximumAge: Math.trunc(maxAge),
      timeout: Math.trunc(timeout),
    };
  }

  private validateWatchOptions(options?: WatchLocationOptions): void {
    if (options?.minDistance !== undefined) {
      if (!Number.isFinite(options.minDistance) || options.minDistance < 0) {
        throw new Error("minDistance must be a non-negative finite number");
      }
    }
    if (options?.minInterval !== undefined) {
      if (!Number.isFinite(options.minInterval) || options.minInterval < 0) {
        throw new Error("minInterval must be a non-negative finite number");
      }
    }
  }

  async getCurrentPosition(options?: LocationOptions): Promise<LocationResult> {
    const geolocation = this.getGeolocation();
    const geoOptions = this.normalizePositionOptions(options);
    return new Promise((resolve, reject) => {
      geolocation.getCurrentPosition(
        (position) => {
          resolve({
            coords: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              altitude: position.coords.altitude ?? undefined,
              accuracy: position.coords.accuracy,
              altitudeAccuracy: position.coords.altitudeAccuracy ?? undefined,
              speed: position.coords.speed ?? undefined,
              heading: position.coords.heading ?? undefined,
              timestamp: position.timestamp,
            },
            cached: false,
          });
        },
        (error) => {
          let code:
            | "PERMISSION_DENIED"
            | "POSITION_UNAVAILABLE"
            | "TIMEOUT"
            | "UNKNOWN";
          switch (error.code) {
            case error.PERMISSION_DENIED:
              code = "PERMISSION_DENIED";
              break;
            case error.POSITION_UNAVAILABLE:
              code = "POSITION_UNAVAILABLE";
              break;
            case error.TIMEOUT:
              code = "TIMEOUT";
              break;
            default:
              code = "UNKNOWN";
          }
          reject({ code, message: error.message });
        },
        geoOptions,
      );
    });
  }

  async watchPosition(
    options?: WatchLocationOptions,
  ): Promise<{ watchId: string }> {
    const watchId = `watch-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const geolocation = this.getGeolocation();
    this.validateWatchOptions(options);
    const geoOptions = this.normalizePositionOptions(options);

    // The browser API has no distance or interval filter, so enforce the
    // contract's minDistance and minInterval here, as both native bridges
    // do: a fix is delivered only when both thresholds are met relative to
    // the last delivered fix. Validating the options and then ignoring
    // them delivered every raw fix to listeners.
    const minDistance = options?.minDistance ?? 0;
    const minInterval = options?.minInterval ?? 0;
    let lastDelivered: {
      latitude: number;
      longitude: number;
      timestamp: number;
    } | null = null;

    const nativeWatchId = geolocation.watchPosition(
      (position) => {
        if (lastDelivered) {
          if (
            minInterval > 0 &&
            position.timestamp - lastDelivered.timestamp < minInterval
          ) {
            return;
          }
          if (
            minDistance > 0 &&
            distanceMeters(
              lastDelivered.latitude,
              lastDelivered.longitude,
              position.coords.latitude,
              position.coords.longitude,
            ) < minDistance
          ) {
            return;
          }
        }
        lastDelivered = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timestamp: position.timestamp,
        };
        this.notifyListeners("locationChange", {
          coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            altitude: position.coords.altitude ?? undefined,
            accuracy: position.coords.accuracy,
            altitudeAccuracy: position.coords.altitudeAccuracy ?? undefined,
            speed: position.coords.speed ?? undefined,
            heading: position.coords.heading ?? undefined,
            timestamp: position.timestamp,
          },
          cached: false,
        });
      },
      (error) => {
        let code:
          | "PERMISSION_DENIED"
          | "POSITION_UNAVAILABLE"
          | "TIMEOUT"
          | "UNKNOWN";
        switch (error.code) {
          case error.PERMISSION_DENIED:
            code = "PERMISSION_DENIED";
            break;
          case error.POSITION_UNAVAILABLE:
            code = "POSITION_UNAVAILABLE";
            break;
          case error.TIMEOUT:
            code = "TIMEOUT";
            break;
          default:
            code = "UNKNOWN";
        }
        this.notifyListeners("error", { code, message: error.message });
      },
      geoOptions,
    );

    this.watches.set(watchId, nativeWatchId);
    return { watchId };
  }

  async clearWatch(options: { watchId: string }): Promise<void> {
    const watchId = typeof options?.watchId === "string" ? options.watchId : "";
    // Reject missing IDs and whitespace-only IDs, matching Android cleanup.
    if (!watchId.trim()) {
      throw new Error("Missing watchId");
    }
    const nativeWatchId = this.watches.get(watchId);
    if (nativeWatchId !== undefined) {
      this.getGeolocation().clearWatch(nativeWatchId);
      this.watches.delete(watchId);
    }
  }

  async checkPermissions(): Promise<LocationPermissionStatus> {
    if ("permissions" in navigator) {
      try {
        const result = await navigator.permissions.query({
          name: "geolocation",
        });
        return {
          location:
            result.state === "granted"
              ? "granted"
              : result.state === "denied"
                ? "denied"
                : "prompt",
        };
      } catch {
        // error-policy:J4 permissions.query throws on browsers that don't
        // support the "geolocation" permission name; "prompt" (unknown, will
        // ask) is the correct state to report, not a masked failure.
        return { location: "prompt" };
      }
    }
    return { location: "prompt" };
  }

  async requestPermissions(): Promise<LocationPermissionStatus> {
    // No Permissions API entry for geolocation on web, so the only way to
    // trigger the browser's permission prompt is to request a position.
    try {
      await this.getCurrentPosition({ timeout: 5000 });
      return { location: "granted" };
    } catch (error) {
      // error-policy:J4 translate the geolocation rejection into an explicit
      // permission state (denied vs unknown/prompt) for the caller to render.
      const e = error as { code: string };
      if (e.code === "PERMISSION_DENIED") {
        return { location: "denied" };
      }
      return { location: "prompt" };
    }
  }
}
