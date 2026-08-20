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
 *   byte 0 : notification sequence LSB
 *   byte 1 : notification sequence MSB  → uint16 LE running index
 *   byte 2 : chunk index                (0-based, resets per logical audio
 *                                         frame split across BLE MTU chunks)
 *   byte 3.. : payload            (Opus frame bytes, or a chunk of one)
 * ```
 *
 * `NET_BUFFER_HEADER_SIZE = 3` (transport.c:492). A single 10 ms Opus frame
 * (~40-80 bytes at 32 kbps) fits inside one BLE notification on any modern MTU,
 * so in practice `frame index` is almost always 0 and each notification carries
 * exactly one complete Opus frame. Multi-chunk frames normally use consecutive
 * notification sequence ids with rising chunk indices. The reassembler also
 * accepts the older app interpretation where continuation chunks reuse one
 * frame id, and only locks onto a mode after a continuation chunk proves it.
 *
 * The uint16 notification sequence wraps at 65536; we track wraps to detect dropped
 * packets (BLE notifications are lossy) so we can log gaps without corrupting
 * the decoder (Opus tolerates whole-frame loss — a gap just drops audio).
 *
 * Notifications and reassembled frames are untrusted device bytes. GATT MTU is
 * typically 185–517 bytes; a 10 ms Opus frame is ~40–80 bytes. Caps below fail
 * closed so a hostile notify cannot hold tens of megabytes in the reassembler
 * (the cloud voice session already rejects uplink audio frames above 64 KiB).
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

/**
 * Defensive ceiling on one GATT notification, header included. It leaves
 * compatibility room above the 517-byte ATT MTU used by current Android while
 * containing malformed native-bridge or test-transport payloads.
 */
export const MAX_OMI_NOTIFICATION_BYTES = 4096 as const;

/**
 * Hard ceiling on one reassembled audio frame (header stripped). 16 KiB is
 * ~256 ms of 16 kHz PCM16 or hundreds of 10 ms Opus frames; honest firmware
 * emits one ~40–80 byte Opus packet per notify.
 */
export const MAX_OMI_REASSEMBLED_FRAME_BYTES = 16_384 as const;

/** Device advertising name prefixes we accept (currently "Friend", soon "eliza"). */
export const OMI_NAME_PREFIXES = ["Friend", "Omi", "eliza"] as const;

export interface ReassembledFrame {
  /** The complete Opus (or raw PCM) frame payload, header stripped. */
  readonly data: Uint8Array;
  /** Monotonic packet or frame id associated with the first chunk. */
  readonly packetIndex: number;
  /** Number of missing packet ids observed before this frame. */
  readonly droppedBefore: number;
}

export type OmiWireMode = "unknown" | "notification-sequence" | "frame-id";

export type OmiFrameDiagnosticCode =
  | "duplicate-notification"
  | "malformed-notification"
  | "oversized-notification"
  | "missing-notification"
  | "missing-chunk"
  | "out-of-order"
  | "unexpected-continuation"
  | "mode-conflict"
  | "ambiguous-tail"
  | "dropped-buffered-frame";

export interface OmiFrameDiagnostic {
  readonly code: OmiFrameDiagnosticCode;
  readonly packetIndex: number | null;
  readonly chunkIndex: number | null;
  readonly detail: string;
  readonly count?: number;
}

export interface OmiFrameMetricsSnapshot {
  readonly notificationCount: number;
  readonly notificationBytes: number;
  readonly emittedFrames: number;
  readonly droppedFrames: number;
  readonly malformedNotifications: number;
  readonly duplicates: number;
  readonly missingNotifications: number;
  readonly missingChunks: number;
  readonly outOfOrder: number;
  readonly detectedWireMode: OmiWireMode;
  readonly cadenceMeanMs: number | null;
  readonly cadenceP95Ms: number | null;
}

export interface OmiFrameReassemblerResult {
  readonly frames: ReassembledFrame[];
  readonly diagnostics: OmiFrameDiagnostic[];
  readonly metrics: OmiFrameMetricsSnapshot;
}

interface BufferedFrame {
  readonly startRawIndex: number;
  readonly startUnwrappedIndex: number;
  readonly droppedBefore: number;
  readonly chunks: Uint8Array[];
  byteLength: number;
  expectedChunkIndex: number;
  lastRawIndex: number;
  lastUnwrappedIndex: number;
}

interface MutableOmiFrameMetrics {
  notificationCount: number;
  notificationBytes: number;
  emittedFrames: number;
  droppedFrames: number;
  malformedNotifications: number;
  duplicates: number;
  missingNotifications: number;
  missingChunks: number;
  outOfOrder: number;
}

function payloadsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const UINT16_MODULUS = 0x10000;
const UINT16_HALF_RANGE = 0x8000;
const MAX_CADENCE_SAMPLES = 512;

/**
 * Stateful reassembler for the omi 3-byte-headed notification stream.
 *
 * Feed it raw notifications in arrival order. It emits complete frames only
 * when the buffered chunk sequence is still valid under the detected wire mode.
 */
export class OmiFrameReassembler {
  private mode: OmiWireMode = "unknown";
  private buffer: BufferedFrame | null = null;
  private lastRawIndex: number | null = null;
  private lastUnwrappedIndex: number | null = null;
  private lastNotification: Uint8Array | null = null;
  private lastReceivedAtMs: number | null = null;
  private readonly cadenceIntervalsMs: number[] = [];
  private readonly metrics: MutableOmiFrameMetrics = {
    notificationCount: 0,
    notificationBytes: 0,
    emittedFrames: 0,
    droppedFrames: 0,
    malformedNotifications: 0,
    duplicates: 0,
    missingNotifications: 0,
    missingChunks: 0,
    outOfOrder: 0,
  };

  /** Reset all state (call on (re)connect). */
  reset(): void {
    this.mode = "unknown";
    this.buffer = null;
    this.lastRawIndex = null;
    this.lastUnwrappedIndex = null;
    this.lastNotification = null;
    this.lastReceivedAtMs = null;
    this.cadenceIntervalsMs.length = 0;
    this.metrics.notificationCount = 0;
    this.metrics.notificationBytes = 0;
    this.metrics.emittedFrames = 0;
    this.metrics.droppedFrames = 0;
    this.metrics.malformedNotifications = 0;
    this.metrics.duplicates = 0;
    this.metrics.missingNotifications = 0;
    this.metrics.missingChunks = 0;
    this.metrics.outOfOrder = 0;
  }

  getMetricsSnapshot(): OmiFrameMetricsSnapshot {
    return this.snapshot();
  }

  private unwrap(raw: number, previous: number | null): number {
    if (previous === null) return raw;
    const prevRaw = previous & 0xffff;
    let delta = raw - prevRaw;
    if (delta < -UINT16_HALF_RANGE) delta += UINT16_MODULUS;
    else if (delta > UINT16_HALF_RANGE) delta -= UINT16_MODULUS;
    return previous + delta;
  }

  /** Preserve the original public API: push one notification and return frames. */
  push(
    notification: Uint8Array,
    receivedAtMs = this.defaultReceivedAtMs(),
  ): ReassembledFrame[] {
    return this.pushDetailed(notification, receivedAtMs).frames;
  }

  /** Push one BLE notification and return frames plus typed diagnostics/metrics. */
  pushDetailed(
    notification: Uint8Array,
    receivedAtMs = this.defaultReceivedAtMs(),
  ): OmiFrameReassemblerResult {
    const diagnostics: OmiFrameDiagnostic[] = [];
    const frames: ReassembledFrame[] = [];
    this.recordNotification(notification, receivedAtMs);

    if (notification.length > MAX_OMI_NOTIFICATION_BYTES) {
      const packetIndex =
        notification.length >= 2
          ? notification[0] | (notification[1] << 8)
          : null;
      const chunkIndex = notification.length >= 3 ? notification[2] : null;
      this.metrics.malformedNotifications += 1;
      if (this.buffer) {
        this.dropBuffered(
          diagnostics,
          packetIndex,
          chunkIndex,
          "dropped-buffered-frame",
          "Buffered frame dropped because an oversized notification interrupted it.",
        );
      }
      diagnostics.push({
        code: "oversized-notification",
        packetIndex,
        chunkIndex,
        detail: `Notification of ${notification.length} bytes exceeds the ${MAX_OMI_NOTIFICATION_BYTES}-byte BLE payload budget.`,
      });
      this.lastNotification = notification.slice(
        0,
        Math.min(notification.length, OMI_PACKET_HEADER_SIZE),
      );
      return this.result(frames, diagnostics);
    }

    if (this.isExactDuplicate(notification)) {
      this.metrics.duplicates += 1;
      diagnostics.push({
        code: "duplicate-notification",
        packetIndex: this.lastRawIndex,
        chunkIndex: notification.length > 2 ? notification[2] : null,
        detail: "Exact duplicate notification ignored.",
      });
      return this.result(frames, diagnostics);
    }

    if (notification.length <= OMI_PACKET_HEADER_SIZE) {
      const packetIndex =
        notification.length >= 2
          ? notification[0] | (notification[1] << 8)
          : null;
      const chunkIndex = notification.length >= 3 ? notification[2] : null;
      this.metrics.malformedNotifications += 1;
      if (this.buffer) {
        this.dropBuffered(
          diagnostics,
          packetIndex,
          chunkIndex,
          "dropped-buffered-frame",
          "Buffered frame dropped because a malformed notification interrupted it.",
        );
      }
      diagnostics.push({
        code: "malformed-notification",
        packetIndex,
        chunkIndex,
        detail: "Notification is missing an audio payload.",
      });
      this.lastNotification = new Uint8Array(notification);
      return this.result(frames, diagnostics);
    }

    const rawIndex = notification[0] | (notification[1] << 8);
    const chunkIndex = notification[2];
    const payload = notification.subarray(OMI_PACKET_HEADER_SIZE);
    const unwrappedIndex = this.unwrap(rawIndex, this.lastUnwrappedIndex);

    if (
      this.lastUnwrappedIndex !== null &&
      unwrappedIndex < this.lastUnwrappedIndex
    ) {
      this.dropBuffered(diagnostics, rawIndex, chunkIndex, "out-of-order");
      this.metrics.outOfOrder += 1;
      diagnostics.push({
        code: "out-of-order",
        packetIndex: rawIndex,
        chunkIndex,
        detail: "Packet id moved backwards in arrival order.",
      });
      this.lastNotification = new Uint8Array(notification);
      return this.result(frames, diagnostics);
    }

    if (chunkIndex === 0) {
      frames.push(
        ...this.handleFrameStart(
          rawIndex,
          unwrappedIndex,
          payload,
          diagnostics,
        ),
      );
      this.acceptNotification(rawIndex, unwrappedIndex, notification);
      this.metrics.emittedFrames += frames.length;
      return this.result(frames, diagnostics);
    }

    this.handleContinuation(
      rawIndex,
      unwrappedIndex,
      chunkIndex,
      payload,
      diagnostics,
    );
    this.acceptNotification(rawIndex, unwrappedIndex, notification);
    return this.result(frames, diagnostics);
  }

  /**
   * End the stream without emitting an unconfirmed tail frame.
   *
   * The wire header has no payload length or end marker. Only the next chunk-0
   * notification proves that the buffered frame was complete, so disconnecting
   * before that boundary is ambiguous and must drop the tail.
   */
  /** Preserve the original public API while intentionally dropping ambiguous tails. */
  flush(): ReassembledFrame[] {
    return this.flushDetailed().frames;
  }

  /** End the stream and return typed diagnostics for any ambiguous tail. */
  flushDetailed(): OmiFrameReassemblerResult {
    const diagnostics: OmiFrameDiagnostic[] = [];
    if (this.buffer) {
      this.dropBuffered(
        diagnostics,
        this.buffer.startRawIndex,
        this.buffer.expectedChunkIndex - 1,
        "ambiguous-tail",
        "Unconfirmed tail frame dropped because the stream ended before its next frame boundary.",
      );
    }
    return this.result([], diagnostics);
  }

  private handleFrameStart(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
    diagnostics: OmiFrameDiagnostic[],
  ): ReassembledFrame[] {
    const frames: ReassembledFrame[] = [];
    if (!this.buffer) {
      const droppedBefore = this.recordStartGap(
        unwrappedIndex,
        rawIndex,
        diagnostics,
      );
      this.startBuffer(rawIndex, unwrappedIndex, payload, droppedBefore);
      return frames;
    }

    const deltaFromLastChunk = unwrappedIndex - this.buffer.lastUnwrappedIndex;
    const deltaFromFrameStart =
      unwrappedIndex - this.buffer.startUnwrappedIndex;
    // A chunk-0 boundary cannot resolve equal same-id chunks: they may be a
    // two-chunk legacy frame or a bumped-index retransmit of a one-notification
    // sequence frame. Do not guess and emit corrupted audio. A later non-equal
    // continuation would have locked frame-id mode before reaching this path.
    if (this.mode === "unknown" && this.buffer.chunks.length > 1) {
      const gap = Math.max(0, deltaFromLastChunk - 1);
      if (gap > 0) {
        this.recordMissingNotifications(gap, rawIndex, 0, diagnostics);
      }
      this.dropBuffered(
        diagnostics,
        rawIndex,
        0,
        "dropped-buffered-frame",
        "Ambiguous equal same-id tail dropped at the next frame boundary.",
      );
      this.startBuffer(rawIndex, unwrappedIndex, payload, gap);
      return frames;
    }
    const canCloseSequence =
      this.mode !== "frame-id" && deltaFromLastChunk === 1;
    const canCloseFrameId =
      this.mode === "frame-id" && deltaFromFrameStart === 1;

    if (canCloseSequence || canCloseFrameId) {
      frames.push(this.emitBuffered());
      this.startBuffer(rawIndex, unwrappedIndex, payload);
      return frames;
    }

    const gap =
      this.mode === "frame-id"
        ? Math.max(0, deltaFromFrameStart - 1)
        : Math.max(0, deltaFromLastChunk - 1);
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, 0, diagnostics);
      if (this.mode === "frame-id") {
        // A continuation in the legacy contract would reuse the buffered frame id,
        // so an advancing id proves the buffered frame is complete even across a gap.
        frames.push(this.emitBuffered());
      } else {
        this.dropBuffered(
          diagnostics,
          rawIndex,
          0,
          "dropped-buffered-frame",
          "Buffered frame dropped because a missing notification may have been its continuation.",
        );
      }
      this.startBuffer(rawIndex, unwrappedIndex, payload, gap);
      return frames;
    }

    this.dropBuffered(diagnostics, rawIndex, 0, "out-of-order");
    this.metrics.outOfOrder += 1;
    diagnostics.push({
      code: "out-of-order",
      packetIndex: rawIndex,
      chunkIndex: 0,
      detail: "Chunk 0 arrived without advancing the packet or frame id.",
    });
    return frames;
  }

  private handleContinuation(
    rawIndex: number,
    unwrappedIndex: number,
    chunkIndex: number,
    payload: Uint8Array,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    if (!this.buffer) {
      this.metrics.missingChunks += chunkIndex;
      diagnostics.push({
        code: "unexpected-continuation",
        packetIndex: rawIndex,
        chunkIndex,
        detail: "Continuation arrived without an open chunk-0 frame.",
      });
      return;
    }

    // Equal adjacent payloads with a repeated raw index are ambiguous until
    // the following notification arrives. If that notification advances the
    // raw sequence while repeating the expected chunk index, the ambiguous
    // chunk was a link-layer retransmit, not a legacy frame-id continuation.
    if (
      this.mode === "unknown" &&
      chunkIndex === this.buffer.expectedChunkIndex - 1 &&
      unwrappedIndex - this.buffer.lastUnwrappedIndex === 1 &&
      this.buffer.chunks.length >= 2
    ) {
      const last = this.buffer.chunks[this.buffer.chunks.length - 1];
      const previous = this.buffer.chunks[this.buffer.chunks.length - 2];
      if (last && previous && payloadsEqual(last, previous)) {
        this.buffer.chunks.pop();
        this.buffer.byteLength -= last.length;
        this.buffer.expectedChunkIndex -= 1;
        this.metrics.duplicates += 1;
        diagnostics.push({
          code: "duplicate-notification",
          packetIndex: this.buffer.startRawIndex,
          chunkIndex,
          detail:
            "Deferred same-frame-id payload resolved as a retransmit by the following sequence notification.",
        });
      }
    }

    if (chunkIndex !== this.buffer.expectedChunkIndex) {
      if (chunkIndex > this.buffer.expectedChunkIndex) {
        const missing = chunkIndex - this.buffer.expectedChunkIndex;
        this.metrics.missingChunks += missing;
        diagnostics.push({
          code: "missing-chunk",
          packetIndex: rawIndex,
          chunkIndex,
          count: missing,
          detail: "Chunk index skipped within the buffered frame.",
        });
      } else {
        this.metrics.outOfOrder += 1;
        diagnostics.push({
          code: "out-of-order",
          packetIndex: rawIndex,
          chunkIndex,
          detail: "Chunk index moved backwards within the buffered frame.",
        });
      }
      this.dropBuffered(
        diagnostics,
        rawIndex,
        chunkIndex,
        "dropped-buffered-frame",
      );
      return;
    }

    const sameFrameId = rawIndex === this.buffer.startRawIndex;
    const nextNotification =
      unwrappedIndex - this.buffer.lastUnwrappedIndex === 1;

    if (sameFrameId && this.mode === "notification-sequence") {
      this.modeConflict(rawIndex, chunkIndex, diagnostics);
      return;
    }

    if (nextNotification && this.mode === "frame-id") {
      this.modeConflict(rawIndex, chunkIndex, diagnostics);
      return;
    }

    if (sameFrameId) {
      if (this.mode === "unknown") {
        const previousChunk = this.buffer.chunks[this.buffer.chunks.length - 1];
        // A same-id chunk with different bytes proves the legacy contract.
        // Equal bytes stay ambiguous until the next notification, because they
        // can be either valid encoded audio or a bumped-index retransmit.
        if (!previousChunk || !payloadsEqual(previousChunk, payload)) {
          this.mode = "frame-id";
        }
      }
      this.appendChunk(rawIndex, unwrappedIndex, payload, diagnostics);
      return;
    }

    if (nextNotification) {
      if (this.mode === "unknown") this.mode = "notification-sequence";
      this.appendChunk(rawIndex, unwrappedIndex, payload, diagnostics);
      return;
    }

    const gap = Math.max(
      0,
      unwrappedIndex - this.buffer.lastUnwrappedIndex - 1,
    );
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, chunkIndex, diagnostics);
    }
    this.dropBuffered(
      diagnostics,
      rawIndex,
      chunkIndex,
      "dropped-buffered-frame",
    );
  }

  private startBuffer(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
    droppedBefore = 0,
  ): void {
    this.buffer = {
      startRawIndex: rawIndex,
      startUnwrappedIndex: unwrappedIndex,
      droppedBefore,
      chunks: [payload],
      byteLength: payload.length,
      expectedChunkIndex: 1,
      lastRawIndex: rawIndex,
      lastUnwrappedIndex: unwrappedIndex,
    };
  }

  private appendChunk(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    if (!this.buffer) return;
    if (
      this.buffer.byteLength + payload.length >
      MAX_OMI_REASSEMBLED_FRAME_BYTES
    ) {
      this.dropBuffered(
        diagnostics,
        rawIndex,
        this.buffer.expectedChunkIndex,
        "dropped-buffered-frame",
        `Reassembled frame would exceed the ${MAX_OMI_REASSEMBLED_FRAME_BYTES}-byte audio budget.`,
      );
      return;
    }
    this.buffer.chunks.push(payload);
    this.buffer.byteLength += payload.length;
    this.buffer.expectedChunkIndex += 1;
    this.buffer.lastRawIndex = rawIndex;
    this.buffer.lastUnwrappedIndex = unwrappedIndex;
  }

  private emitBuffered(): ReassembledFrame {
    if (!this.buffer) {
      throw new Error("Cannot emit without a buffered frame.");
    }
    const total = this.buffer.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this.buffer.chunks) {
      data.set(c, off);
      off += c.length;
    }
    return {
      data,
      packetIndex: this.buffer.startUnwrappedIndex,
      droppedBefore: this.buffer.droppedBefore,
    };
  }

  private recordNotification(
    notification: Uint8Array,
    receivedAtMs: number,
  ): void {
    this.metrics.notificationCount += 1;
    this.metrics.notificationBytes += notification.length;
    if (
      this.lastReceivedAtMs !== null &&
      receivedAtMs >= this.lastReceivedAtMs
    ) {
      this.cadenceIntervalsMs.push(receivedAtMs - this.lastReceivedAtMs);
      if (this.cadenceIntervalsMs.length > MAX_CADENCE_SAMPLES) {
        this.cadenceIntervalsMs.shift();
      }
    }
    this.lastReceivedAtMs = receivedAtMs;
  }

  private acceptNotification(
    rawIndex: number,
    unwrappedIndex: number,
    notification: Uint8Array,
  ): void {
    this.lastRawIndex = rawIndex;
    this.lastUnwrappedIndex = unwrappedIndex;
    this.lastNotification = new Uint8Array(notification);
  }

  private isExactDuplicate(notification: Uint8Array): boolean {
    if (!this.lastNotification) return false;
    if (notification.length !== this.lastNotification.length) return false;
    for (let i = 0; i < notification.length; i += 1) {
      if (notification[i] !== this.lastNotification[i]) return false;
    }
    return true;
  }

  private recordStartGap(
    unwrappedIndex: number,
    rawIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): number {
    if (this.lastUnwrappedIndex === null) return 0;
    const gap = unwrappedIndex - this.lastUnwrappedIndex - 1;
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, 0, diagnostics);
      return gap;
    }
    return 0;
  }

  private recordMissingNotifications(
    count: number,
    rawIndex: number,
    chunkIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    this.metrics.missingNotifications += count;
    diagnostics.push({
      code: "missing-notification",
      packetIndex: rawIndex,
      chunkIndex,
      count,
      detail: "Packet id gap observed in the notification stream.",
    });
  }

  private modeConflict(
    rawIndex: number,
    chunkIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    diagnostics.push({
      code: "mode-conflict",
      packetIndex: rawIndex,
      chunkIndex,
      detail: "Continuation contradicts the detected pendant wire mode.",
    });
    this.dropBuffered(
      diagnostics,
      rawIndex,
      chunkIndex,
      "dropped-buffered-frame",
    );
  }

  private dropBuffered(
    diagnostics: OmiFrameDiagnostic[],
    rawIndex: number | null,
    chunkIndex: number | null,
    code: OmiFrameDiagnosticCode,
    detail = "Buffered frame dropped to avoid emitting ambiguous audio.",
  ): void {
    if (!this.buffer) return;
    this.buffer = null;
    this.metrics.droppedFrames += 1;
    diagnostics.push({
      code,
      packetIndex: rawIndex,
      chunkIndex,
      detail,
    });
  }

  private result(
    frames: ReassembledFrame[],
    diagnostics: OmiFrameDiagnostic[],
  ): OmiFrameReassemblerResult {
    return { frames, diagnostics, metrics: this.snapshot() };
  }

  private snapshot(): OmiFrameMetricsSnapshot {
    return {
      ...this.metrics,
      detectedWireMode: this.mode,
      cadenceMeanMs: this.meanCadence(),
      cadenceP95Ms: this.p95Cadence(),
    };
  }

  private meanCadence(): number | null {
    if (this.cadenceIntervalsMs.length === 0) return null;
    const total = this.cadenceIntervalsMs.reduce(
      (sum, value) => sum + value,
      0,
    );
    return total / this.cadenceIntervalsMs.length;
  }

  private p95Cadence(): number | null {
    if (this.cadenceIntervalsMs.length === 0) return null;
    const sorted = [...this.cadenceIntervalsMs].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, index)];
  }

  private defaultReceivedAtMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}
