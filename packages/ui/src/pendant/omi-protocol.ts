/**
 * omi DevKit1 BLE audio protocol — constants + frame reassembly.
 *
 * VERIFIED against the actual firmware source (Omi v2.0.x, Zephyr) at
 * `firmware/devkit/src/{transport.c,codec.c,config.h}`:
 *
 * - Audio service UUID: `19B10000-E8F2-537E-4F6C-D104768A1214`
 *   (transport.c:74-81, "Audio service with UUID 19B10000-…")
 * - Audio data characteristic (notify): `19B10001-…` (transport.c:83) — the
 *   firmware `bt_gatt_notify`s each packet on `audio_service.attrs[1]`.
 * - Codec-type characteristic (read): `19B10002-…` (transport.c:85, 303-310) —
 *   returns a single byte `CODEC_ID`.
 * - `CODEC_ID = 20` (config.h:37) → **Opus**. The firmware default for the DK1
 *   is `CONFIG_OMI_CODEC_OPUS=y` (prj_xiao_ble_sense_devkitv1.conf), and the
 *   encoder is initialised at **16 kHz mono, RESTRICTED_LOWDELAY, 32 kbps VBR,
 *   complexity 3** (codec.c:98-108). Frame size = `CODEC_PACKAGE_SAMPLES = 160`
 *   samples @ 16 kHz = **10 ms per Opus frame** (config.h:25).
 *
 * ### BLE packet framing (transport.c `push_to_gatt` / pusher, lines 551-589)
 * Every notification the firmware sends is:
 *
 * ```
 *   byte 0 : packet index  LSB   (id & 0xFF)
 *   byte 1 : packet index  MSB   ((id >> 8) & 0xFF)   → uint16 LE running index
 *   byte 2 : frame index          (0-based, resets per logical audio frame that
 *                                   is split across BLE MTU-sized chunks)
 *   byte 3.. : payload            (Opus frame bytes, or a chunk of one)
 * ```
 *
 * `NET_BUFFER_HEADER_SIZE = 3` (transport.c:492). A single 10 ms Opus frame
 * (~40-80 bytes at 32 kbps) fits inside one BLE notification on any modern MTU,
 * so in practice `frame index` is almost always 0 and each notification carries
 * exactly one complete Opus frame. We still handle the multi-chunk case: when
 * consecutive notifications share the SAME packet index with an incrementing
 * frame index, their payloads are concatenated into one Opus frame; a change in
 * packet index closes the previous frame.
 *
 * The uint16 packet index wraps at 65536; we track wraps to detect dropped
 * packets (BLE notifications are lossy) so we can log gaps without corrupting
 * the decoder (Opus tolerates whole-frame loss — a gap just drops audio).
 */

/** omi audio GATT service. Also the Web Bluetooth `filters`/`optionalServices` id. */
export const OMI_AUDIO_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
/** Audio data characteristic — subscribe for `notify`. */
export const OMI_AUDIO_DATA_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
/** Codec-type characteristic — `read` returns one byte (`CODEC_ID`). */
export const OMI_AUDIO_CODEC_CHAR_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

/**
 * Standard Bluetooth Battery Service (0x180F) + Battery Level (0x2A19).
 *
 * Web Bluetooth accepts the SIG short names; the Capacitor plugin
 * (`@capacitor-community/bluetooth-le`) requires FULL 128-bit UUIDs, so we keep
 * both forms. The 128-bit forms are the SIG base UUID with the 16-bit id in the
 * high word (`0000XXXX-0000-1000-8000-00805f9b34fb`).
 */
export const BATTERY_SERVICE_UUID = "battery_service"; // 0x180F short name
export const BATTERY_LEVEL_CHAR_UUID = "battery_level"; // 0x2A19 short name
/** Full 128-bit Battery Service UUID (0x180F) — for the native BLE plugin. */
export const BATTERY_SERVICE_UUID_128 = "0000180f-0000-1000-8000-00805f9b34fb";
/** Full 128-bit Battery Level char UUID (0x2A19) — for the native BLE plugin. */
export const BATTERY_LEVEL_CHAR_UUID_128 =
  "00002a19-0000-1000-8000-00805f9b34fb";

/** Codec ids the firmware may report from the codec characteristic. */
export const OMI_CODEC = {
  /** PCM 8 kHz 16-bit. */
  PCM_8K: 0,
  /** PCM 16 kHz 16-bit. */
  PCM_16K: 1,
  /** PCM 8 kHz 8-bit µ-law. */
  MU_LAW_8K: 10,
  /** Opus 16 kHz mono (the DK1 default — `CODEC_ID = 20`). */
  OPUS_16K: 20,
} as const;

export type OmiCodecId = (typeof OMI_CODEC)[keyof typeof OMI_CODEC];

/** Firmware Opus parameters (codec.c) — the decoder must match these. */
export const OMI_OPUS_SAMPLE_RATE_HZ = 16000 as const;
export const OMI_OPUS_CHANNELS = 1 as const;
/** 160 samples @ 16 kHz = 10 ms. Used only for latency accounting. */
export const OMI_OPUS_FRAME_SAMPLES = 160 as const;

/** `NET_BUFFER_HEADER_SIZE` — the 3-byte packet/frame index prefix. */
export const OMI_PACKET_HEADER_SIZE = 3 as const;

/** Device advertising name prefixes we accept (currently "Friend", soon "eliza"). */
export const OMI_NAME_PREFIXES = ["Friend", "Omi", "eliza"] as const;

export interface ReassembledFrame {
  /** The complete Opus (or raw PCM) frame payload, header stripped. */
  readonly data: Uint8Array;
  /** Firmware packet index this frame belonged to (post-unwrap, monotonic). */
  readonly packetIndex: number;
  /** Number of packet indices skipped since the previous frame (0 = none). */
  readonly droppedBefore: number;
}

/**
 * Stateful reassembler for the omi 3-byte-headed notification stream.
 *
 * Feed it each raw notification `Uint8Array`; it emits zero or more complete
 * frames. It concatenates multi-chunk frames (same packet index, rising frame
 * index) and reports packet-index gaps so the caller can account for BLE loss.
 */
export class OmiFrameReassembler {
  /** Last packet index seen, unwrapped to a monotonic 32-bit-ish counter. */
  private lastUnwrapped: number | null = null;
  /** Raw (wrapped) uint16 of the packet index currently being assembled. */
  private currentRawIndex: number | null = null;
  /** Expected next frame-index within the current packet. */
  private expectedFrameIndex = 0;
  /** Payload chunks buffered for the packet currently being assembled. */
  private chunks: Uint8Array[] = [];

  /** Reset all state (call on (re)connect). */
  reset(): void {
    this.lastUnwrapped = null;
    this.currentRawIndex = null;
    this.expectedFrameIndex = 0;
    this.chunks = [];
  }

  /**
   * Unwrap a wrapped uint16 packet index into a monotonic counter, tolerating
   * the 65536 rollover the firmware's `id & 0xFFFF` produces.
   */
  private unwrap(raw: number): number {
    if (this.lastUnwrapped === null) return raw;
    const prevRaw = this.lastUnwrapped & 0xffff;
    let delta = raw - prevRaw;
    if (delta < -0x8000)
      delta += 0x10000; // forward wrap
    else if (delta > 0x8000) delta -= 0x10000; // (defensive) backward wrap
    return this.lastUnwrapped + delta;
  }

  /**
   * Push one BLE notification. Returns any frames completed by this packet.
   *
   * A logical audio frame is delimited by the packet index: all notifications
   * that share a packet index (with a rising `frame index`) are chunks of the
   * SAME Opus/PCM frame. The frame is complete once the NEXT packet index
   * begins. Because the firmware sends one Opus frame per notification in the
   * overwhelming common case (a 10 ms / ~40-80 byte frame fits one MTU), the
   * new-packet path emits the just-closed frame immediately — so single-chunk
   * frames incur exactly one-frame latency while multi-chunk frames are still
   * correctly reassembled in order.
   */
  push(notification: Uint8Array): ReassembledFrame[] {
    if (notification.length <= OMI_PACKET_HEADER_SIZE) return [];
    const rawIndex = notification[0] | (notification[1] << 8);
    const frameIndex = notification[2];
    const payload = notification.subarray(OMI_PACKET_HEADER_SIZE);

    const out: ReassembledFrame[] = [];

    if (frameIndex === 0) {
      // Start of a NEW logical frame. Close and emit the previous frame (if any)
      // now that its packet index is known to be complete.
      if (this.chunks.length > 0 && this.currentRawIndex !== null) {
        out.push(this.emitBuffered(this.currentRawIndex));
      }
      // Begin buffering the new frame. It is NOT emitted yet — a continuation
      // (frameIndex 1+, same packet index) may still extend it. It flushes when
      // the next frameIndex-0 packet arrives (above), or on an explicit flush().
      this.currentRawIndex = rawIndex;
      this.expectedFrameIndex = 1;
      this.chunks = [payload];
      return out;
    }

    // frameIndex > 0: a continuation chunk of a multi-notification frame. Only
    // valid if it matches the packet we were assembling AND is the next expected
    // chunk; otherwise it's an orphan (loss) and we drop it.
    if (
      this.currentRawIndex === rawIndex &&
      frameIndex === this.expectedFrameIndex
    ) {
      this.chunks.push(payload);
      this.expectedFrameIndex += 1;
    }
    return out;
  }

  /**
   * Emit the currently-buffered frame, if any. Call on disconnect/stop so the
   * final in-flight frame (which has no following packet to close it) is not
   * silently dropped.
   */
  flush(): ReassembledFrame[] {
    if (this.chunks.length > 0 && this.currentRawIndex !== null) {
      const frame = this.emitBuffered(this.currentRawIndex);
      this.chunks = [];
      this.currentRawIndex = null;
      return [frame];
    }
    return [];
  }

  private emitBuffered(rawIndex: number): ReassembledFrame {
    const unwrapped = this.unwrap(rawIndex);
    let droppedBefore = 0;
    if (this.lastUnwrapped !== null) {
      droppedBefore = Math.max(0, unwrapped - this.lastUnwrapped - 1);
    }
    this.lastUnwrapped = unwrapped;

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      data.set(c, off);
      off += c.length;
    }
    return { data, packetIndex: unwrapped, droppedBefore };
  }
}
