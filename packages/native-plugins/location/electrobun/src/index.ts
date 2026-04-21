/**
 * Location Plugin for Electrobun
 *
 * Provides geolocation services on desktop platforms.
 *
 * Location methods:
 * - Browser Geolocation API (requires permission, may use WiFi/IP)
 * - IP-based geolocation fallback (less accurate, no permission needed)
 * - Native location services via the Electrobun bridge (platform-specific)
 */

import type { PluginListenerHandle } from "@capacitor/core";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/app-core";
import type { EventCallback, ListenerEntry as BaseListenerEntry } from "../../../shared-types.js";
import type {
  LocationErrorEvent,
  LocationOptions,
  LocationPermissionStatus,
  LocationPlugin,
  LocationResult,
  WatchLocationOptions,
} from "../../src/definitions";

type LocationEventData = LocationResult | LocationErrorEvent;

type ListenerEntry = BaseListenerEntry<string, LocationEventData>;

interface NativeLocationPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

/**
 * Location Plugin implementation for Electrobun
 */
export class LocationElectrobun implements LocationPlugin {
  private watches: Map<string, number> = new Map();
  private nativeWatchSubscriptions = new Map<string, () => void>();
  private listeners: ListenerEntry[] = [];
  private watchIdCounter = 0;

  // MARK: - Position Methods

  async getCurrentPosition(options?: LocationOptions): Promise<LocationResult> {
    try {
      const result = await invokeDesktopBridgeRequest<NativeLocationPosition>({
        rpcMethod: "locationGetCurrentPosition",
        ipcChannel: "location:getCurrentPosition",
        params: options,
      });
      if (result) {
        return this.toNativeLocationResult(result);
      }
    } catch {
      // Fall through to browser API
    }

    // Use browser Geolocation API
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }

      const geoOptions: PositionOptions = {
        enableHighAccuracy:
          options?.accuracy === "best" || options?.accuracy === "high",
        timeout: options?.timeout || 30000,
        maximumAge: options?.maxAge || 0,
      };

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve(this.toLocationResult(position, false));
        },
        (error) => {
          this.notifyListeners("error", {
            code: this.getErrorCode(error.code),
            message: error.message,
          });
          reject(error);
        },
        geoOptions,
      );
    });
  }

  async watchPosition(
    options?: WatchLocationOptions,
  ): Promise<{ watchId: string }> {
    try {
      const nativeWatch = await invokeDesktopBridgeRequest<{ watchId: string }>(
        {
          rpcMethod: "locationWatchPosition",
          ipcChannel: "location:watchPosition",
          params: options,
        },
      );
      if (nativeWatch?.watchId) {
        const unsubscribe = subscribeDesktopBridgeEvent({
          rpcMessage: "locationUpdate",
          ipcChannel: "location:update",
          listener: (data) => {
            const location = this.extractNativeWatchLocation(
              nativeWatch.watchId,
              data,
            );
            if (location) {
              this.notifyListeners("locationChange", location);
            }
          },
        });
        this.nativeWatchSubscriptions.set(nativeWatch.watchId, unsubscribe);
        return nativeWatch;
      }
    } catch {
      // Fall through to browser API
    }

    // Use browser Geolocation API
    const watchId = `watch_${++this.watchIdCounter}`;
    const geoOptions: PositionOptions = {
      enableHighAccuracy:
        options?.accuracy === "best" || options?.accuracy === "high",
      timeout: options?.timeout || 30000,
      maximumAge: 0,
    };

    const nativeWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const result = this.toLocationResult(position, false);
        this.notifyListeners("locationChange", result);
      },
      (error) => {
        this.notifyListeners("error", {
          code: this.getErrorCode(error.code),
          message: error.message,
        });
      },
      geoOptions,
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

    const unsubscribe = this.nativeWatchSubscriptions.get(options.watchId);
    if (unsubscribe) {
      unsubscribe();
      this.nativeWatchSubscriptions.delete(options.watchId);
    }

    try {
      await invokeDesktopBridgeRequest({
        rpcMethod: "locationClearWatch",
        ipcChannel: "location:clearWatch",
        params: options,
      });
    } catch {
      // Ignore desktop bridge shutdown issues
    }
  }

  // MARK: - Permissions

  async checkPermissions(): Promise<LocationPermissionStatus> {
    let location: LocationPermissionStatus["location"] = "prompt";

    try {
      const result = await navigator.permissions.query({ name: "geolocation" });
      location = result.state as LocationPermissionStatus["location"];
    } catch {
      // Permissions API may not support geolocation query
    }

    return { location };
  }

  async requestPermissions(): Promise<LocationPermissionStatus> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ location: "denied" });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        () => {
          resolve({ location: "granted" });
        },
        (error) => {
          if (error.code === GeolocationPositionError.PERMISSION_DENIED) {
            resolve({ location: "denied" });
          } else {
            resolve({ location: "prompt" });
          }
        },
        { timeout: 10000 },
      );
    });
  }

  // MARK: - Helpers

  private toLocationResult(
    position: GeolocationPosition,
    cached: boolean,
  ): LocationResult {
    return {
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
      cached,
    };
  }

  private toNativeLocationResult(
    position: NativeLocationPosition,
  ): LocationResult {
    return {
      coords: {
        latitude: position.latitude,
        longitude: position.longitude,
        accuracy: position.accuracy,
        timestamp: position.timestamp,
      },
      cached: false,
    };
  }

  private extractNativeWatchLocation(
    watchId: string,
    data: unknown,
  ): LocationResult | null {
    if (this.isNativeWatchPayload(data) && data.watchId === watchId) {
      if (this.isLocationResult(data.location)) {
        return data.location;
      }

      if (this.isNativePosition(data.location)) {
        return this.toNativeLocationResult(data.location);
      }
    }

    if (this.isNativePosition(data)) {
      return this.toNativeLocationResult(data);
    }

    return null;
  }

  private isNativeWatchPayload(
    value: unknown,
  ): value is { watchId: string; location: unknown } {
    return (
      typeof value === "object" &&
      value !== null &&
      "watchId" in value &&
      typeof value.watchId === "string" &&
      "location" in value
    );
  }

  private isLocationResult(value: unknown): value is LocationResult {
    if (typeof value !== "object" || value === null || !("coords" in value)) {
      return false;
    }

    const { coords, cached } = value;
    return (
      typeof coords === "object" &&
      coords !== null &&
      "latitude" in coords &&
      typeof coords.latitude === "number" &&
      "longitude" in coords &&
      typeof coords.longitude === "number" &&
      "accuracy" in coords &&
      typeof coords.accuracy === "number" &&
      "timestamp" in coords &&
      typeof coords.timestamp === "number" &&
      "cached" in value &&
      typeof cached === "boolean"
    );
  }

  private isNativePosition(value: unknown): value is NativeLocationPosition {
    return (
      typeof value === "object" &&
      value !== null &&
      "latitude" in value &&
      typeof value.latitude === "number" &&
      "longitude" in value &&
      typeof value.longitude === "number" &&
      "accuracy" in value &&
      typeof value.accuracy === "number" &&
      "timestamp" in value &&
      typeof value.timestamp === "number"
    );
  }

  private getErrorCode(code: number): string {
    switch (code) {
      case GeolocationPositionError.PERMISSION_DENIED:
        return "PERMISSION_DENIED";
      case GeolocationPositionError.POSITION_UNAVAILABLE:
        return "POSITION_UNAVAILABLE";
      case GeolocationPositionError.TIMEOUT:
        return "TIMEOUT";
      default:
        return "UNKNOWN";
    }
  }

  // MARK: - Event Listeners

  private notifyListeners<T>(eventName: string, data: T): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<T>)(data);
      }
    }
  }

  async addListener(
    eventName: "locationChange",
    listenerFunc: (event: LocationResult) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "error",
    listenerFunc: (event: LocationErrorEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listenerFunc: EventCallback<LocationEventData>,
  ): Promise<PluginListenerHandle> {
    const entry: ListenerEntry = { eventName, callback: listenerFunc };
    this.listeners.push(entry);

    return {
      remove: async () => {
        const idx = this.listeners.indexOf(entry);
        if (idx >= 0) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    // Clear all watches
    for (const [watchId] of this.watches) {
      await this.clearWatch({ watchId });
    }

    for (const [, unsubscribe] of this.nativeWatchSubscriptions) {
      unsubscribe();
    }
    this.nativeWatchSubscriptions.clear();

    this.listeners = [];
  }
}

// Export the plugin instance
export const Location = new LocationElectrobun();
