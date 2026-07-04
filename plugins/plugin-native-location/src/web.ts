import { WebPlugin } from "@capacitor/core";

import type {
  LocationOptions,
  LocationPermissionStatus,
  LocationResult,
  WatchLocationOptions,
} from "./definitions";

/**
 * Web implementation of the Location Plugin
 *
 * Uses the browser Geolocation API.
 */
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
    return {
      enableHighAccuracy:
        options?.accuracy === "best" || options?.accuracy === "high",
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

    const nativeWatchId = geolocation.watchPosition(
      (position) => {
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
    // On web, permissions are requested implicitly when calling getCurrentPosition
    // Try to get current position to trigger permission request
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
