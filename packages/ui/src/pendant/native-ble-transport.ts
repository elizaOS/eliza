/**
 * NativeBlePendantTransport — the Capacitor implementation of
 * {@link PendantTransport}, backed by `@capacitor-community/bluetooth-le`.
 *
 * This is the transport the PACKAGED Android app (the Light Phone III daily
 * driver) uses: the WebView has no `navigator.bluetooth`, so the pendant must
 * reach BLE through the native plugin instead. Everything downstream of the
 * transport (frame reassembly → Opus decode → VAD → WAV → ASR → VOICE_DM) is
 * unchanged and shared with the Web Bluetooth path.
 *
 * ### Plugin API (`@capacitor-community/bluetooth-le`, v8, Capacitor 8)
 *   - `BleClient.initialize()`               — bootstraps the native stack.
 *   - `BleClient.requestDevice({ services })` — native chooser, returns a
 *     `{ deviceId, name }`. On Android 13+ this uses the new BLUETOOTH_SCAN/
 *     CONNECT runtime permissions (declared in the manifest), NOT legacy
 *     location.
 *   - `BleClient.connect(deviceId, onDisconnect)` — establishes GATT; the
 *     callback fires on a remote disconnect.
 *   - `BleClient.read(deviceId, service, char)`  — returns a `DataView`.
 *   - `BleClient.startNotifications(deviceId, service, char, cb)` — `cb` gets a
 *     `DataView` per notification.
 *   - `BleClient.stopNotifications(...)` / `BleClient.disconnect(deviceId)`.
 *
 * The plugin is a NATIVE-ONLY dependency — it is not part of the web bundle. We
 * therefore import it dynamically so this module tree-shakes cleanly out of the
 * browser build and never forces `@capacitor-community/bluetooth-le` to resolve
 * on the web (where it would pull native shims that don't exist). The dynamic
 * import target is injectable for tests via {@link NativeBleTransportDeps}.
 */

import { ElizaError, logger } from "@elizaos/core";
import {
  BATTERY_LEVEL_CHAR_UUID_128,
  BATTERY_SERVICE_UUID_128,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
  type OmiCodecId,
} from "./omi-protocol";
import {
  type PendantAudioListener,
  type PendantBatteryListener,
  type PendantTransport,
  PendantUserCancelledError,
} from "./pendant-transport";

/**
 * The subset of `@capacitor-community/bluetooth-le`'s `BleClient` we use. Kept
 * minimal + structural so a mock in tests only has to implement what we call.
 */
export interface BleClientLike {
  initialize(options?: { androidNeverForLocation?: boolean }): Promise<void>;
  requestDevice(options?: {
    services?: string[];
    optionalServices?: string[];
    namePrefix?: string;
  }): Promise<{ deviceId: string; name?: string }>;
  connect(
    deviceId: string,
    onDisconnect?: (deviceId: string) => void,
  ): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  read(
    deviceId: string,
    service: string,
    characteristic: string,
  ): Promise<DataView>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
  stopNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
  ): Promise<void>;
}

/** Injectable dependency surface (for tests). */
export interface NativeBleTransportDeps {
  /** Resolve the `BleClient` singleton (defaults to a dynamic plugin import). */
  loadClient: () => Promise<BleClientLike>;
}

/**
 * Default loader: dynamic-import the real plugin.
 *
 * The specifier is a STATIC string literal so Vite resolves + code-splits it
 * into its own lazy chunk at build time (the Capacitor WebView has no import
 * map for bare specifiers, so a `@vite-ignore`'d runtime import would 404). The
 * chunk is only fetched when this loader runs, which only happens on the native
 * Android path (selectPendantTransport gates NativeBlePendantTransport on
 * `Capacitor.getPlatform() === "android"`) — so the web bundle never executes it
 * even though the chunk exists.
 */
async function loadRealBleClient(): Promise<BleClientLike> {
  const mod = (await import("@capacitor-community/bluetooth-le")) as {
    BleClient: BleClientLike;
  };
  return mod.BleClient;
}

export class NativeBlePendantTransport implements PendantTransport {
  readonly kind = "native-ble" as const;

  private readonly loadClient: () => Promise<BleClientLike>;
  private client: BleClientLike | null = null;
  private deviceId: string | null = null;

  private audioSubscribed = false;
  private batterySubscribed = false;
  private disconnectedHandler: (() => void) | null = null;

  constructor(deps?: Partial<NativeBleTransportDeps>) {
    this.loadClient = deps?.loadClient ?? loadRealBleClient;
  }

  private async ensureClient(): Promise<BleClientLike> {
    if (!this.client) this.client = await this.loadClient();
    return this.client;
  }

  async requestAndConnect(): Promise<{ deviceName: string | null }> {
    const client = await this.ensureClient();
    // `androidNeverForLocation` tells the plugin the scan is not used to derive
    // physical location, so on API 31+ the runtime prompt is BLUETOOTH_SCAN/
    // CONNECT only — no location permission (matches the manifest patch).
    await client.initialize({ androidNeverForLocation: true });

    let device: { deviceId: string; name?: string };
    try {
      device = await client.requestDevice({
        services: [OMI_AUDIO_SERVICE_UUID],
        optionalServices: [OMI_AUDIO_SERVICE_UUID, BATTERY_SERVICE_UUID_128],
      });
    } catch (err) {
      // error-policy:J3 Native chooser cancellation becomes an explicit typed signal.
      // The plugin rejects a dismissed chooser / no-selection — normalize to the
      // shared cancelled error so the caller lands in idle, not error.
      if (isNativeCancel(err)) throw new PendantUserCancelledError();
      throw err;
    }

    this.deviceId = device.deviceId;
    await client.connect(device.deviceId, () => {
      this.disconnectedHandler?.();
    });

    return { deviceName: device.name ?? null };
  }

  async readCodec(): Promise<OmiCodecId> {
    const client = this.client;
    const deviceId = this.deviceId;
    if (!client || !deviceId) return OMI_CODEC.OPUS_16K;
    try {
      const value = await client.read(
        deviceId,
        OMI_AUDIO_SERVICE_UUID,
        OMI_AUDIO_CODEC_CHAR_UUID,
      );
      return value.getUint8(0) as OmiCodecId;
    } catch (error) {
      // error-policy:J4 Older DK1 firmware omits the optional codec characteristic.
      logger.debug(
        { error },
        "[NativeBlePendantTransport] Codec characteristic unavailable; using DK1 Opus default",
      );
      // Codec characteristic missing/unreadable → assume the DK1 Opus default.
      return OMI_CODEC.OPUS_16K;
    }
  }

  async startAudio(listener: PendantAudioListener): Promise<void> {
    const client = this.client;
    const deviceId = this.deviceId;
    if (!client || !deviceId) {
      throw new ElizaError("Pendant audio started without a BLE connection.", {
        code: "PENDANT_BLE_NOT_CONNECTED",
        severity: "fatal",
      });
    }
    await client.startNotifications(
      deviceId,
      OMI_AUDIO_SERVICE_UUID,
      OMI_AUDIO_DATA_CHAR_UUID,
      (value: DataView) => {
        // Window the payload to exactly the notified bytes so the reassembler
        // sees identical input to the Web Bluetooth path.
        listener(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        );
      },
    );
    this.audioSubscribed = true;
  }

  async startBattery(listener: PendantBatteryListener): Promise<number | null> {
    const client = this.client;
    const deviceId = this.deviceId;
    if (!client || !deviceId) return null;
    try {
      const initial = await client.read(
        deviceId,
        BATTERY_SERVICE_UUID_128,
        BATTERY_LEVEL_CHAR_UUID_128,
      );
      const percent = initial.getUint8(0);
      await client.startNotifications(
        deviceId,
        BATTERY_SERVICE_UUID_128,
        BATTERY_LEVEL_CHAR_UUID_128,
        (value: DataView) => listener(value.getUint8(0)),
      );
      this.batterySubscribed = true;
      return percent;
    } catch (error) {
      // error-policy:J4 Battery telemetry is optional and renders as unavailable.
      logger.debug(
        { error },
        "[NativeBlePendantTransport] Battery service unavailable",
      );
      // No battery service — leave batteryPercent null.
      return null;
    }
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const deviceId = this.deviceId;
    if (client && deviceId) {
      if (this.audioSubscribed) {
        try {
          await client.stopNotifications(
            deviceId,
            OMI_AUDIO_SERVICE_UUID,
            OMI_AUDIO_DATA_CHAR_UUID,
          );
        } catch (error) {
          // error-policy:J6 Notification teardown continues after a lost BLE link.
          logger.debug(
            { error },
            "[NativeBlePendantTransport] Audio notifications already stopped",
          );
        }
      }
      if (this.batterySubscribed) {
        try {
          await client.stopNotifications(
            deviceId,
            BATTERY_SERVICE_UUID_128,
            BATTERY_LEVEL_CHAR_UUID_128,
          );
        } catch (error) {
          // error-policy:J6 Notification teardown continues after a lost BLE link.
          logger.debug(
            { error },
            "[NativeBlePendantTransport] Battery notifications already stopped",
          );
        }
      }
      try {
        await client.disconnect(deviceId);
      } catch (error) {
        // error-policy:J6 Local transport state must clear after a remote disconnect.
        logger.debug(
          { error },
          "[NativeBlePendantTransport] Device already disconnected",
        );
      }
    }
    this.audioSubscribed = false;
    this.batterySubscribed = false;
    this.deviceId = null;
  }
}

/** Best-effort detection of a user-cancelled native chooser. */
function isNativeCancel(err: unknown): boolean {
  if (!err) return false;
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("no device") ||
    message.includes("not selected") ||
    message.includes("dismiss")
  );
}
