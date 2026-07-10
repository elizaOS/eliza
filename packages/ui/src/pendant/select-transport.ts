/**
 * Runtime transport selection for the pendant.
 *
 * The pendant can be reached two ways depending on where the UI is running:
 *  - In a browser with Web Bluetooth (desktop Chrome / Android Chrome) → use
 *    {@link WebBluetoothPendantTransport}.
 *  - In the packaged native Android shell (the Light Phone III), where the
 *    WebView has NO `navigator.bluetooth` → use {@link NativeBlePendantTransport}
 *    over the Capacitor BLE plugin.
 *
 * The choice is: native Android shell first (that's the daily-driver target and
 * its WebView can't reach Web Bluetooth), otherwise Web Bluetooth if available.
 * {@link isPendantSupported} mirrors this so the Settings card shows the connect
 * affordance on BOTH surfaces (previously it was Web-Bluetooth-only, which hid
 * the pendant on the native Android app).
 */

import { Capacitor } from "@capacitor/core";

import { NativeBlePendantTransport } from "./native-ble-transport";
import type { PendantTransport } from "./pendant-transport";
import {
  isWebBluetoothAvailable,
  WebBluetoothPendantTransport,
} from "./web-bluetooth-transport";

/** True when running inside the packaged native Android shell. */
export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/**
 * Whether the pendant can be connected in the current environment.
 *
 * True on native Android (native BLE transport) OR wherever Web Bluetooth is
 * available. Drives the Settings card's connect affordance.
 */
export function isPendantSupported(): boolean {
  return isNativeAndroid() || isWebBluetoothAvailable();
}

/**
 * Build the appropriate transport for the current runtime, or null if the
 * pendant is unsupported here.
 *
 * Native Android is checked FIRST because its WebView cannot reach Web
 * Bluetooth — the native BLE plugin is the only path there.
 */
export function selectPendantTransport(): PendantTransport | null {
  if (isNativeAndroid()) return new NativeBlePendantTransport();
  if (isWebBluetoothAvailable()) return new WebBluetoothPendantTransport();
  return null;
}
