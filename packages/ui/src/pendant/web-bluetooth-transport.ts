/// <reference path="./web-bluetooth.d.ts" />
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

import { ElizaError, logger } from "@elizaos/core";
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
      throw new ElizaError("Web Bluetooth is not available in this browser.", {
        code: "PENDANT_WEB_BLUETOOTH_UNAVAILABLE",
        severity: "fatal",
      });
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
      // error-policy:J3 Browser chooser cancellation becomes an explicit typed signal.
      // A user cancelling the chooser throws NotFoundError — normalize it.
      if (err instanceof DOMException && err.name === "NotFoundError") {
        throw new PendantUserCancelledError();
      }
      throw err;
    }
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.onGattDisconnected);

    const server = await device.gatt?.connect();
    if (!server) {
      throw new ElizaError("Pendant GATT server is unavailable.", {
        code: "PENDANT_GATT_SERVER_UNAVAILABLE",
        severity: "fatal",
      });
    }
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
    } catch (error) {
      // error-policy:J4 Older DK1 firmware omits the optional codec characteristic.
      logger.debug(
        { error },
        "[WebBluetoothPendantTransport] Codec characteristic unavailable; using DK1 Opus default",
      );
      // Codec characteristic missing/unreadable → assume the DK1 Opus default.
      return OMI_CODEC.OPUS_16K;
    }
  }

  async startAudio(listener: PendantAudioListener): Promise<void> {
    const audioService = this.audioService;
    if (!audioService) {
      throw new ElizaError("Pendant audio service is not connected.", {
        code: "PENDANT_AUDIO_SERVICE_NOT_CONNECTED",
        severity: "fatal",
      });
    }
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

  async startBattery(listener: PendantBatteryListener): Promise<number | null> {
    const server = this.server;
    if (!server) return null;
    this.batteryListener = listener;
    try {
      const batteryService =
        await server.getPrimaryService(BATTERY_SERVICE_UUID);
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
    } catch (error) {
      // error-policy:J4 Battery telemetry is optional and renders as unavailable.
      logger.debug(
        { error },
        "[WebBluetoothPendantTransport] Battery service unavailable",
      );
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
    } catch (error) {
      // error-policy:J6 Notification teardown continues after a lost BLE link.
      logger.debug(
        { error },
        "[WebBluetoothPendantTransport] Audio notifications already stopped",
      );
    }
    try {
      this.device?.gatt?.disconnect();
    } catch (error) {
      // error-policy:J6 Local transport state must clear after a remote disconnect.
      logger.debug(
        { error },
        "[WebBluetoothPendantTransport] Device already disconnected",
      );
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
