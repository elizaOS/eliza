import { WebPlugin } from "@capacitor/core";

import type {
  LocationOptions,
  LocationResult,
  WatchLocationOptions,
  LocationPermissionStatus,
} from "./definitions";

/**
 * Web implementation of the Location Plugin
 *
 * Uses the browser Geolocation API.
 */
export class LocationWeb extends WebPlugin {
  private watches = new Map<string, number>();

  async getCurrentPosition(options?: LocationOptions): Promise<LocationResult> {
    return new Promise((resolve, reject) => {
      const geoOptions: PositionOptions = {
        enableHighAccuracy: options?.accuracy === "best" || options?.accuracy === "high",
        maximumAge: options?.maxAge ?? 0,
        timeout: options?.timeout ?? 10000,
      };

      navigator.geolocation.getCurrentPosition(
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
          let code: "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "UNKNOWN";
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
        geoOptions
      );
    });
  }

  async watchPosition(options?: WatchLocationOptions): Promise<{ watchId: string }> {
    const watchId = `watch-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const geoOptions: PositionOptions = {
      enableHighAccuracy: options?.accuracy === "best" || options?.accuracy === "high",
      maximumAge: options?.maxAge ?? 0,
      timeout: options?.timeout ?? 10000,
    };

    const nativeWatchId = navigator.geolocation.watchPosition(
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
        let code: "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "UNKNOWN";
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
      geoOptions
    );

    this.watches.set(watchId, nativeWatchId);
    return { watchId };
  }

  async clearWatch(options: { watchId: string }): Promise<void> {
    const nativeWatchId = this.watches.get(options.watchId);
    if (nativeWatchId !== undefined) {
      navigator.geolocation.clearWatch(nativeWatchId);
      this.watches.delete(options.watchId);
    }
  }

  async checkPermissions(): Promise<LocationPermissionStatus> {
    if ("permissions" in navigator) {
      try {
        const result = await navigator.permissions.query({ name: "geolocation" });
        return {
          location: result.state === "granted" ? "granted" :
                   result.state === "denied" ? "denied" : "prompt",
        };
      } catch {
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
      const e = error as { code: string };
      if (e.code === "PERMISSION_DENIED") {
        return { location: "denied" };
      }
      return { location: "prompt" };
    }
  }
}
