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

import {
  type PendantTransport,
  PendantUserCancelledError,
} from "./pendant-transport";
import {
  isWebBluetoothAvailable,
  WebBluetoothPendantTransport,
} from "./web-bluetooth-transport";

/** True when running inside the packaged native Android shell. */
export function isNativeAndroid(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  } catch {
    // Capacitor absent (plain web / test env) → not native.
    return false;
  }
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
  if (isNativeAndroid()) return new LazyNativeBlePendantTransport();
  if (isWebBluetoothAvailable()) return new WebBluetoothPendantTransport();
  return null;
}

export class LazyNativeBlePendantTransport implements PendantTransport {
  readonly kind = "native-ble" as const;
  private transport: PendantTransport | null = null;
  private loadPromise: Promise<PendantTransport> | null = null;
  private disconnectedHandler: (() => void) | null = null;
  private cancelled = false;

  async requestAndConnect(): Promise<{ deviceName: string | null }> {
    const transport = await this.load();
    if (this.cancelled) throw new PendantUserCancelledError();
    const result = await transport.requestAndConnect();
    if (this.cancelled) {
      await transport.disconnect();
      throw new PendantUserCancelledError();
    }
    return result;
  }

  async readCodec() {
    return (await this.load()).readCodec();
  }

  async startAudio(listener: Parameters<PendantTransport["startAudio"]>[0]) {
    return (await this.load()).startAudio(listener);
  }

  async startBattery(
    listener: Parameters<PendantTransport["startBattery"]>[0],
  ) {
    return (await this.load()).startBattery(listener);
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
    this.transport?.onDisconnected(handler);
  }

  async disconnect(): Promise<void> {
    this.cancelled = true;
    const transport =
      this.transport ?? (await this.loadPromise?.catch(() => null));
    await transport?.disconnect();
  }

  private async load(): Promise<PendantTransport> {
    if (!this.loadPromise) {
      this.loadPromise = import("./native-ble-transport").then(
        ({ NativeBlePendantTransport }) => {
          this.transport = new NativeBlePendantTransport();
          if (this.disconnectedHandler) {
            this.transport.onDisconnected(this.disconnectedHandler);
          }
          return this.transport;
        },
      );
    }
    return this.loadPromise;
  }
}
