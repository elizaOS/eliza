/**
 * PendantTransport — the platform BLE abstraction the pendant voice loop sits on.
 *
 * The audio pipeline (frame reassembly → Opus decode → VAD → WAV → ASR →
 * VOICE_DM) is entirely platform-agnostic; the ONLY platform-specific piece is
 * how we talk BLE to the omi DevKit1. `PendantConnection` therefore drives a
 * `PendantTransport` and never touches Web Bluetooth (or Capacitor) directly.
 *
 * Two implementations exist:
 *  - {@link WebBluetoothPendantTransport} — desktop Chrome / Android Chrome, uses
 *    `navigator.bluetooth`.
 *  - `NativeBlePendantTransport` (native-ble-transport.ts) — the packaged
 *    Android app (Light Phone III), uses `@capacitor-community/bluetooth-le`.
 *
 * {@link selectPendantTransport} picks the right one at runtime: native Android
 * shell → native BLE; everything else → Web Bluetooth.
 *
 * The interface intentionally mirrors the shape of the connect sequence in
 * `pendant-connection.ts` so both transports drive the SAME `connectStep` trace
 * + per-step timeouts + one-retry logic. Each method maps to exactly one connect
 * step, and notifications are delivered as raw `Uint8Array` payloads (already
 * windowed to the notification's bytes) so the reassembler sees identical input
 * on every platform.
 */

import type { OmiCodecId } from "./omi-protocol";
import { pendantErrorCauseChain } from "./pendant-errors";

/** A raw BLE notification payload, windowed to exactly the notified bytes. */
export type PendantNotification = Uint8Array;

/** Callback invoked with each audio-data notification payload. */
export type PendantAudioListener = (payload: PendantNotification) => void;

/** Callback invoked with each battery-level notification (0-100), if supported. */
export type PendantBatteryListener = (percent: number) => void;

/**
 * A platform BLE transport for the omi pendant.
 *
 * Lifecycle (each step is driven under a named timeout by `PendantConnection`):
 *   1. {@link requestAndConnect}  — pick a device + establish the GATT link.
 *      (Web Bluetooth couples device choice + connect behind one user gesture;
 *       native scans then connects — both are folded into this one step so the
 *       connect trace is identical across platforms.)
 *   2. {@link readCodec}          — read the codec-type characteristic.
 *   3. {@link startAudio}         — subscribe to audio-data notifications.
 *   4. {@link startBattery}       — best-effort battery subscription.
 *   5. {@link disconnect}         — tear everything down.
 *
 * A remote disconnect (device off / out of range) is surfaced via
 * {@link onDisconnected}.
 */
export interface PendantTransport {
  /** Stable transport id, for tests + the connect trace. */
  readonly kind: "web-bluetooth" | "native-ble";

  /**
   * Request/choose a device and establish the GATT link. Resolves with the
   * advertised device name (or null if the platform does not expose one).
   *
   * Throws `PendantUserCancelledError` if the user dismissed the chooser (so the
   * caller lands in `idle`, not `error`).
   */
  requestAndConnect(): Promise<{ deviceName: string | null }>;

  /**
   * Read the codec-type characteristic. Implementations MUST fall back to the
   * DK1 Opus default (`OMI_CODEC.OPUS_16K`) when the characteristic is missing
   * or unreadable, never throw for that case.
   */
  readCodec(): Promise<OmiCodecId>;

  /** Subscribe to audio-data notifications, delivering each payload to `listener`. */
  startAudio(listener: PendantAudioListener): Promise<void>;

  /**
   * Best-effort battery subscription. Resolves the initial percent (or null if
   * the service is absent) and streams updates to `listener`. MUST NOT throw for
   * a missing battery service.
   */
  startBattery(listener: PendantBatteryListener): Promise<number | null>;

  /** Register a handler for an unsolicited remote disconnect. */
  onDisconnected(handler: () => void): void;

  /**
   * Tear down: stop notifications, disconnect GATT, release native handles.
   * Idempotent + best-effort (never throws).
   */
  disconnect(): Promise<void>;
}

/** Thrown by {@link PendantTransport.requestAndConnect} when the user cancels. */
export class PendantUserCancelledError extends Error {
  constructor(message = "Device selection cancelled") {
    super(message);
    this.name = "PendantUserCancelledError";
  }
}

/** True when an error is a user-cancelled device chooser (→ land in idle). */
export function isUserCancelled(err: unknown): boolean {
  return pendantErrorCauseChain(err).some(
    (cause) =>
      cause instanceof PendantUserCancelledError ||
      // Web Bluetooth surfaces a cancelled chooser as DOMException NotFoundError.
      (cause instanceof DOMException && cause.name === "NotFoundError"),
  );
}
