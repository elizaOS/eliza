/**
 * Location Plugin for Electron
 *
 * Provides geolocation services on desktop platforms.
 *
 * Location methods:
 * - Browser Geolocation API (requires permission, may use WiFi/IP)
 * - IP-based geolocation fallback (less accurate, no permission needed)
 * - Native location services via Electron IPC (platform-specific)
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  LocationPlugin,
  LocationOptions,
  LocationResult,
  WatchLocationOptions,
  LocationPermissionStatus,
  LocationErrorEvent,
} from "../../src/definitions";

type EventCallback<T> = (event: T) => void;
type LocationEventData = LocationResult | LocationErrorEvent;

interface ListenerEntry {
  eventName: string;
  callback: EventCallback<LocationEventData>;
}

type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = { [key: string]: IpcValue };
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;
type IpcListener = (...args: IpcValue[]) => void;

// Type for Electron IPC
interface ElectronAPI {
  ipcRenderer: {
    invoke(channel: string, ...args: IpcValue[]): Promise<IpcValue>;
    on(channel: string, listener: IpcListener): void;
    removeListener(channel: string, listener: IpcListener): void;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

/**
 * Location Plugin implementation for Electron
 */
export class LocationElectron implements LocationPlugin {
  private watches: Map<string, number> = new Map();
  private listeners: ListenerEntry[] = [];
  private watchIdCounter = 0;

  // MARK: - Position Methods

  async getCurrentPosition(options?: LocationOptions): Promise<LocationResult> {
    // Try Electron IPC for native location services first
    if (window.electron?.ipcRenderer) {
      try {
        const result = await window.electron.ipcRenderer.invoke("location:getCurrentPosition", options as IpcValue);
        return result as LocationResult;
      } catch {
        // Fall through to browser API
      }
    }

    // Use browser Geolocation API
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }

      const geoOptions: PositionOptions = {
        enableHighAccuracy: options?.accuracy === "best" || options?.accuracy === "high",
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
        geoOptions
      );
    });
  }

  async watchPosition(options?: WatchLocationOptions): Promise<{ watchId: string }> {
    const watchId = `watch_${++this.watchIdCounter}`;

    // Try Electron IPC for native location services
    if (window.electron?.ipcRenderer) {
      try {
        await window.electron.ipcRenderer.invoke("location:watchPosition", {
          ...options,
          watchId,
        });

        // Set up IPC listener for location updates
        const handler = (data: { watchId: string; location: LocationResult }) => {
          if (data.watchId === watchId) {
            this.notifyListeners("locationChange", data.location);
          }
        };
        window.electron.ipcRenderer.on("location:update", handler);

        return { watchId };
      } catch {
        // Fall through to browser API
      }
    }

    // Use browser Geolocation API
    const geoOptions: PositionOptions = {
      enableHighAccuracy: options?.accuracy === "best" || options?.accuracy === "high",
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

    // Also notify Electron if using native
    if (window.electron?.ipcRenderer) {
      try {
        await window.electron.ipcRenderer.invoke("location:clearWatch", options);
      } catch {
        // Ignore
      }
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
        { timeout: 10000 }
      );
    });
  }

  // MARK: - Helpers

  private toLocationResult(position: GeolocationPosition, cached: boolean): LocationResult {
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
    listenerFunc: (event: LocationResult) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "error",
    listenerFunc: (event: LocationErrorEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listenerFunc: EventCallback<LocationEventData>
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
    this.listeners = [];
  }
}

// Export the plugin instance
export const Location = new LocationElectron();
