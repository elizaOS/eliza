// spec/os/android/system.md, "Story: Report device facts honestly"
import type { PluginListenerHandle } from "@capacitor/core";

export type LocationAccuracy = "best" | "high" | "medium" | "low" | "passive";

export interface LocationCoordinates {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy: number;
  altitudeAccuracy?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
}

export interface LocationOptions {
  accuracy?: LocationAccuracy;
  maxAge?: number;
  timeout?: number;
}

export interface WatchLocationOptions extends LocationOptions {
  minDistance?: number;
  minInterval?: number;
}

export interface LocationResult {
  coords: LocationCoordinates;
  cached: boolean;
}

export type LocationGrant = "granted" | "denied" | "prompt";

export type LocationGrantAccuracy = "precise" | "approximate" | "none";

export interface LocationPermissionStatus {
  location: LocationGrant;
  accuracy?: LocationGrantAccuracy;
  background?: LocationGrant;
}

export type LocationErrorCode = "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "UNKNOWN";

export interface LocationErrorEvent {
  code: LocationErrorCode;
  message: string;
}

export interface LocationPlugin {
  getCurrentPosition(options?: LocationOptions): Promise<LocationResult>;
  watchPosition(options?: WatchLocationOptions): Promise<{ watchId: string }>;
  clearWatch(options: { watchId: string }): Promise<void>;
  checkPermissions(): Promise<LocationPermissionStatus>;
  requestPermissions(): Promise<LocationPermissionStatus>;
  addListener(eventName: "locationChange", listenerFunc: (location: LocationResult) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listenerFunc: (error: LocationErrorEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export type LocationReading =
  | { kind: "fix"; source: "fresh" | "cached"; coords: LocationCoordinates; precise: boolean }
  | { kind: "permission-denied" }
  | { kind: "timeout" }
  | { kind: "unavailable" };

export interface LocationClient {
  checkPermissions(): Promise<LocationPermissionStatus>;
  requestPermissions(): Promise<LocationPermissionStatus>;
  getCurrentPosition(options?: LocationOptions): Promise<LocationReading>;
  watchPosition(options?: WatchLocationOptions): Promise<{ watchId: string }>;
  clearWatch(options: { watchId: string }): Promise<void>;
  onLocation(listener: (location: LocationResult) => void): Promise<PluginListenerHandle>;
  onError(listener: (error: LocationErrorEvent) => void): Promise<PluginListenerHandle>;
}
