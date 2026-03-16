/**
 * Location Native Module for Electron
 *
 * Provides geolocation services on desktop platforms using IP-based lookup.
 *
 * LIMITATION: Native platform location services (CoreLocation on macOS,
 * Windows.Devices.Geolocation on Windows) require native Node.js addons
 * which are not currently implemented. This module uses IP-based geolocation
 * as the primary method, which provides ~5km accuracy.
 *
 * For higher accuracy, the renderer should use the browser's Geolocation API
 * which can access native location services through Chromium.
 */

import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import https from "https";
import type { IpcValue } from "./ipc-types";

// Types
export interface LocationCoordinates {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy: number;
  altitudeAccuracy?: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

export interface LocationResult {
  coords: LocationCoordinates;
  cached: boolean;
}

export interface LocationOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maxAge?: number;
}

interface IPLocationResponse {
  lat?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
  city?: string;
  region?: string;
  country?: string;
}

/**
 * Location Manager
 */
export class LocationManager {
  private mainWindow: BrowserWindow | null = null;
  private watches: Map<string, NodeJS.Timeout> = new Map();
  private watchIdCounter = 0;
  private lastKnownLocation: LocationResult | null = null;

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Get current position using IP-based geolocation.
   *
   * Note: This uses IP geolocation which provides ~5km accuracy.
   * For higher accuracy on desktop, use the browser's Geolocation API
   * in the renderer process, which can access native location services.
   */
  async getCurrentPosition(_options?: LocationOptions): Promise<LocationResult> {
    const ipLocation = await this.getIPLocation();
    this.lastKnownLocation = ipLocation;
    return ipLocation;
  }

  /**
   * Get location from IP address
   */
  private async getIPLocation(): Promise<LocationResult> {
    return new Promise((resolve, reject) => {
      // Use a free IP geolocation service
      const services = [
        "http://ip-api.com/json/",
        "https://ipapi.co/json/",
        "https://freegeoip.app/json/",
      ];

      const tryService = (index: number) => {
        if (index >= services.length) {
          reject(new Error("All IP geolocation services failed"));
          return;
        }

        const url = new URL(services[index]);
        const protocol = url.protocol === "https:" ? https : require("http");

        const req = protocol.get(url.href, (res: NodeJS.ReadableStream & { statusCode?: number }) => {
          if (res.statusCode !== 200) {
            tryService(index + 1);
            return;
          }

          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });

          res.on("end", () => {
            try {
              const json = JSON.parse(data) as IPLocationResponse;
              const lat = json.lat ?? json.latitude;
              const lon = json.lon ?? json.longitude;

              if (lat !== undefined && lon !== undefined) {
                resolve({
                  coords: {
                    latitude: lat,
                    longitude: lon,
                    // IP-based geolocation typically has ~5km accuracy
                    // This is an estimate; actual accuracy varies by ISP and location
                    accuracy: 5000,
                    timestamp: Date.now(),
                  },
                  cached: false,
                });
              } else {
                console.warn(`[Location] Service ${services[index]} returned no coordinates, trying next`);
                tryService(index + 1);
              }
            } catch (parseError) {
              console.warn(`[Location] Failed to parse response from ${services[index]}:`, parseError);
              tryService(index + 1);
            }
          });
        });

        req.on("error", (err) => {
          console.warn(`[Location] Request to ${services[index]} failed:`, err.message);
          tryService(index + 1);
        });

        req.setTimeout(5000, () => {
          req.destroy();
          tryService(index + 1);
        });
      };

      tryService(0);
    });
  }

  /**
   * Watch position changes
   */
  async watchPosition(options?: LocationOptions & { watchId?: string }): Promise<{ watchId: string }> {
    const watchId = options?.watchId ?? `watch_${++this.watchIdCounter}`;

    // Poll for location changes
    const interval = options?.maxAge || 10000;

    const check = async (): Promise<void> => {
      try {
        const location = await this.getCurrentPosition(options);
        this.sendToRenderer("location:update", { watchId, location });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Location error";
        console.error(`[Location] Watch ${watchId} error:`, message);
        this.sendToRenderer("location:error", { watchId, error: message });
      }
    };

    // Initial check - errors are handled inside check()
    check().catch((err) => {
      console.error(`[Location] Initial check failed for ${watchId}:`, err);
    });

    // Set up interval
    const timer = setInterval(check, interval);
    this.watches.set(watchId, timer);

    return { watchId };
  }

  /**
   * Stop watching position
   */
  async clearWatch(watchId: string): Promise<void> {
    const timer = this.watches.get(watchId);
    if (timer) {
      clearInterval(timer);
      this.watches.delete(watchId);
    }
  }

  /**
   * Get last known location
   */
  getLastKnownLocation(): LocationResult | null {
    return this.lastKnownLocation;
  }

  private sendToRenderer(channel: string, data: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Clean up
   */
  dispose(): void {
    for (const timer of this.watches.values()) {
      clearInterval(timer);
    }
    this.watches.clear();
  }
}

// Singleton instance
let locationManager: LocationManager | null = null;

export function getLocationManager(): LocationManager {
  if (!locationManager) {
    locationManager = new LocationManager();
  }
  return locationManager;
}

/**
 * Register Location IPC handlers
 */
export function registerLocationIPC(): void {
  const manager = getLocationManager();

  ipcMain.handle("location:getCurrentPosition", async (_e: IpcMainInvokeEvent, options?: LocationOptions) => {
    return manager.getCurrentPosition(options);
  });

  ipcMain.handle("location:watchPosition", async (_e: IpcMainInvokeEvent, options?: LocationOptions & { watchId?: string }) => {
    return manager.watchPosition(options);
  });

  ipcMain.handle("location:clearWatch", async (_e: IpcMainInvokeEvent, options: { watchId: string }) => {
    return manager.clearWatch(options.watchId);
  });

  ipcMain.handle("location:getLastKnownLocation", () => {
    return { location: manager.getLastKnownLocation() };
  });
}
