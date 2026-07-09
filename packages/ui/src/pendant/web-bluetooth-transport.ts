/**
 * WebBluetoothPendantTransport — the `navigator.bluetooth` implementation of
 * {@link PendantTransport}.
 *
 * This is the exact GATT bring-up that shipped in the original pendant bridge,
 * factored out of `PendantConnection` so the audio pipeline is platform-agnostic
 * and a native Capacitor transport can slot in beside it. Behaviour is byte-for-
 * byte identical to the previous inline Web Bluetooth path:
 *   - request by name prefix OR audio service
 *   - GATT connect → audio service → codec read → audio char → notifications
 *   - best-effort standard Battery Service subscription
 *   - a remote `gattserverdisconnected` fires {@link onDisconnected}
 *
 * Available on Chrome/Edge desktop + Android Chrome; NOT iOS Safari / installed
 * PWA (there the native transport is used instead).
 */

import {
  BATTERY_LEVEL_CHAR_UUID,
  BATTERY_SERVICE_UUID,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
  OMI_NAME_PREFIXES,
  type OmiCodecId,
} from "./omi-protocol";
import {
  type PendantAudioListener,
  type PendantBatteryListener,
  type PendantTransport,
  PendantUserCancelledError,
} from "./pendant-transport";

/** True when the browser exposes the Web Bluetooth API. */
export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { bluetooth?: unknown }).bluetooth ===
      "object" &&
    (navigator as Navigator & { bluetooth?: { requestDevice?: unknown } })
      .bluetooth?.requestDevice !== undefined
  );
}

export class WebBluetoothPendantTransport implements PendantTransport {
  readonly kind = "web-bluetooth" as const;

  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private audioService: BluetoothRemoteGATTService | null = null;
  private audioChar: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;

  private audioListener: PendantAudioListener | null = null;
  private batteryListener: PendantBatteryListener | null = null;
  private disconnectedHandler: (() => void) | null = null;

  private readonly onAudioNotify = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value || !this.audioListener) return;
    // Respect the DataView's window into its ArrayBuffer — a bare
    // `new Uint8Array(value.buffer)` would read stale/extra bytes when the view
    // does not span the whole buffer.
    this.audioListener(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  };

  private readonly onBatteryNotify = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const pct = target.value?.getUint8(0);
    if (typeof pct === "number") this.batteryListener?.(pct);
  };

  private readonly onGattDisconnected = (): void => {
    this.disconnectedHandler?.();
  };

  async requestAndConnect(): Promise<{ deviceName: string | null }> {
    if (!isWebBluetoothAvailable()) {
      throw new Error("Web Bluetooth is not available in this browser.");
    }
    const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth })
      .bluetooth;
    let device: BluetoothDevice;
    try {
      device = await bluetooth.requestDevice({
        // Accept by advertised name prefix ("Friend" today, "eliza" soon) AND
        // by the audio service so a renamed device still matches.
        filters: [
          ...OMI_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
          { services: [OMI_AUDIO_SERVICE_UUID] },
        ],
        optionalServices: [OMI_AUDIO_SERVICE_UUID, BATTERY_SERVICE_UUID],
      });
    } catch (err) {
      // A user cancelling the chooser throws NotFoundError — normalize it.
      if (err instanceof DOMException && err.name === "NotFoundError") {
        throw new PendantUserCancelledError();
      }
      throw err;
    }
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);

    const server = await device.gatt?.connect();
    if (!server) throw new Error("GATT server unavailable");
    this.server = server;
    this.audioService = await server.getPrimaryService(OMI_AUDIO_SERVICE_UUID);

    return { deviceName: device.name ?? null };
  }

  async readCodec(): Promise<OmiCodecId> {
    const audioService = this.audioService;
    if (!audioService) return OMI_CODEC.OPUS_16K;
    try {
      const codecChar = await audioService.getCharacteristic(
        OMI_AUDIO_CODEC_CHAR_UUID,
      );
      const value = await codecChar.readValue();
      return value.getUint8(0) as OmiCodecId;
    } catch {
      // Codec characteristic missing/unreadable → assume the DK1 Opus default.
      return OMI_CODEC.OPUS_16K;
    }
  }

  async startAudio(listener: PendantAudioListener): Promise<void> {
    const audioService = this.audioService;
    if (!audioService) throw new Error("audio service not connected");
    this.audioListener = listener;
    const audioChar = await audioService.getCharacteristic(
      OMI_AUDIO_DATA_CHAR_UUID,
    );
    this.audioChar = audioChar;
    audioChar.addEventListener(
      "characteristicvaluechanged",
      this.onAudioNotify,
    );
    await audioChar.startNotifications();
  }

  async startBattery(
    listener: PendantBatteryListener,
  ): Promise<number | null> {
    const server = this.server;
    if (!server) return null;
    this.batteryListener = listener;
    try {
      const batteryService = await server.getPrimaryService(
        BATTERY_SERVICE_UUID,
      );
      const batteryChar = await batteryService.getCharacteristic(
        BATTERY_LEVEL_CHAR_UUID,
      );
      this.batteryChar = batteryChar;
      const initial = await batteryChar.readValue();
      const percent = initial.getUint8(0);
      batteryChar.addEventListener(
        "characteristicvaluechanged",
        this.onBatteryNotify,
      );
      await batteryChar.startNotifications();
      return percent;
    } catch {
      // No battery service — leave batteryPercent null.
      return null;
    }
  }

  onDisconnected(handler: () => void): void {
    this.disconnectedHandler = handler;
  }

  async disconnect(): Promise<void> {
    this.audioChar?.removeEventListener(
      "characteristicvaluechanged",
      this.onAudioNotify,
    );
    this.batteryChar?.removeEventListener(
      "characteristicvaluechanged",
      this.onBatteryNotify,
    );
    this.device?.removeEventListener(
      "gattserverdisconnected",
      this.onGattDisconnected,
    );
    try {
      await this.audioChar?.stopNotifications();
    } catch {
      /* already gone */
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.audioListener = null;
    this.batteryListener = null;
    this.audioChar = null;
    this.batteryChar = null;
    this.audioService = null;
    this.server = null;
    this.device = null;
  }
}
