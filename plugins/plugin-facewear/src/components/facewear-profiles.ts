/**
 * Facewear profile helpers derive supported device rows and connected-state
 * labels for the unified view wrapper.
 */

import type { FacewearDeviceType } from "../devices/registry.ts";

/** A connected facewear device, mirrored from `/api/facewear/status`. */
export interface ConnectedDevice {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
}

export interface FacewearStatusResponse {
  connected: boolean;
  devices: ConnectedDevice[];
}

/** A supported device the operator can connect/manage. */
export interface FacewearDeviceProfileRow {
  type: FacewearDeviceType;
  name: string;
  manufacturer: string;
  connectionType: string;
  description: string;
}

export const FACEWEAR_DEVICE_PROFILES: readonly FacewearDeviceProfileRow[] = [
  {
    type: "meta-quest",
    name: "Meta Quest 3 / 3S / Pro",
    manufacturer: "Meta",
    connectionType: "WebXR",
    description: "Passthrough AR/VR",
  },
  {
    type: "xreal",
    name: "XReal Air 3 / One Pro",
    manufacturer: "XREAL",
    connectionType: "WebXR",
    description: "Spatial display",
  },
  {
    type: "even-realities",
    name: "Even Realities G1 / G2",
    manufacturer: "Even Realities",
    connectionType: "Bluetooth BLE",
    description: "OLED display and mic",
  },
  {
    type: "apple-vision-pro",
    name: "Apple Vision Pro",
    manufacturer: "Apple",
    connectionType: "WebXR",
    description: "visionOS headset",
  },
];

/**
 * A profile is connected when a live device matches it directly (deviceType),
 * via the Even Realities smartglasses rule (kind === "smartglasses"), or via the
 * WebXR rule (any xr-kind device lights up every WebXR profile).
 */
export function isProfileConnected(
  profile: FacewearDeviceProfileRow,
  devices: readonly ConnectedDevice[],
): boolean {
  return devices.some(
    (device) =>
      device.deviceType === profile.type ||
      (profile.type === "even-realities" && device.kind === "smartglasses") ||
      (profile.connectionType === "WebXR" && device.kind === "xr"),
  );
}
