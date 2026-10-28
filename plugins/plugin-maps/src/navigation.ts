/**
 * Typed contract between agent maps actions and the device that owns GPS,
 * active navigation and spoken guidance. The agent asks; the device decides,
 * plans from its own location fix and reports the resulting state. Nothing in
 * this contract carries the device position back to the agent.
 */

import type { PlaceRef, TravelMode } from "./types.js";

export type MapsDeviceNavigationState =
  | "selected"
  | "navigating"
  | "stopped"
  | "awaiting-location"
  | "awaiting-confirmation";

export interface MapsDeviceNavigationStatus {
  state: MapsDeviceNavigationState;
  /** Destination or selected place name, for the user-facing reply. */
  placeName?: string;
  travelMode?: TravelMode;
}

export interface MapsDeviceNavigation {
  /** Shows one place as the selected place on the device map. */
  select(place: PlaceRef): Promise<MapsDeviceNavigationStatus>;
  /** Plans from the device location and starts guidance after the device's own review. */
  start(request: {
    destination: PlaceRef;
    travelMode: TravelMode;
  }): Promise<MapsDeviceNavigationStatus>;
  /** Replans the active navigation from the current device location. */
  reroute(): Promise<MapsDeviceNavigationStatus>;
  /** Ends active navigation and releases the location watch. */
  stop(): Promise<MapsDeviceNavigationStatus>;
}
