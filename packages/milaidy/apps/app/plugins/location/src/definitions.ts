import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Location accuracy level
 */
export type LocationAccuracy = "best" | "high" | "medium" | "low" | "passive";

/**
 * Location coordinates
 */
export interface LocationCoordinates {
  /** Latitude in degrees */
  latitude: number;
  /** Longitude in degrees */
  longitude: number;
  /** Altitude in meters (if available) */
  altitude?: number;
  /** Horizontal accuracy in meters */
  accuracy: number;
  /** Vertical accuracy in meters (if available) */
  altitudeAccuracy?: number;
  /** Speed in meters per second (if available) */
  speed?: number;
  /** Heading in degrees (if available) */
  heading?: number;
  /** Timestamp of the location */
  timestamp: number;
}

/**
 * Options for getting location
 */
export interface LocationOptions {
  /** Desired accuracy level (default: high) */
  accuracy?: LocationAccuracy;
  /** Maximum age of cached location in milliseconds (default: 0 = no cache) */
  maxAge?: number;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * Options for watching location
 */
export interface WatchLocationOptions extends LocationOptions {
  /** Minimum distance in meters to trigger an update (default: 0) */
  minDistance?: number;
  /** Minimum time interval in milliseconds between updates (default: 0) */
  minInterval?: number;
}

/**
 * Location result
 */
export interface LocationResult {
  /** The location coordinates */
  coords: LocationCoordinates;
  /** Whether this is from cache */
  cached: boolean;
}

/**
 * Location permission status
 */
export interface LocationPermissionStatus {
  /** Current permission status */
  location: "granted" | "denied" | "prompt";
  /** Whether background location is allowed (iOS/Android) */
  background?: "granted" | "denied" | "prompt";
}

/**
 * Location error event
 */
export interface LocationErrorEvent {
  /** Error code */
  code: "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" | "UNKNOWN";
  /** Error message */
  message: string;
}

/**
 * Location Plugin Interface
 *
 * Provides access to device location services including GPS, network,
 * and fused location providers.
 */
export interface LocationPlugin {
  /**
   * Get the current location
   *
   * @param options - Location options
   * @returns Promise resolving to location result
   */
  getCurrentPosition(options?: LocationOptions): Promise<LocationResult>;

  /**
   * Start watching location changes
   *
   * Location updates are delivered via the 'locationChange' event.
   *
   * @param options - Watch options
   * @returns Promise resolving to a watch ID
   */
  watchPosition(options?: WatchLocationOptions): Promise<{ watchId: string }>;

  /**
   * Stop watching location changes
   *
   * @param options - Watch ID to stop
   * @returns Promise that resolves when watch is stopped
   */
  clearWatch(options: { watchId: string }): Promise<void>;

  /**
   * Check location permission status
   *
   * @returns Promise resolving to permission status
   */
  checkPermissions(): Promise<LocationPermissionStatus>;

  /**
   * Request location permissions
   *
   * @returns Promise resolving to permission status after request
   */
  requestPermissions(): Promise<LocationPermissionStatus>;

  /**
   * Add listener for location changes (when watching)
   */
  addListener(
    eventName: "locationChange",
    listenerFunc: (location: LocationResult) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for location errors
   */
  addListener(
    eventName: "error",
    listenerFunc: (error: LocationErrorEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all listeners
   */
  removeAllListeners(): Promise<void>;
}
