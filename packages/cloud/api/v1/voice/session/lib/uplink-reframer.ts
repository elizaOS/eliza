/**
 * Uplink re-framer: turn arbitrary client PCM16 chunking into the exact
 * 100 ms / 3200-byte pcm_s16le mono 16kHz frames Cartesia Ink expects.
 *
 * The client may send audio in any chunk size (browser AudioWorklet buffers,
 * BLE frame boundaries, jitter). This accumulates a byte buffer and emits only
 * complete 3200-byte frames, holding the trailing partial for the next chunk.
 * A `flush()` on session end drops any sub-frame remainder rather than padding
 * with silence (padding would inject phantom audio into a paid STT stream).
 */

import { CARTESIA_INK_CHUNK_BYTES } from "../../stt/providers/cartesia-ink";

export const UPLINK_FRAME_BYTES = CARTESIA_INK_CHUNK_BYTES;

export class UplinkReframer {
  private buffer = new Uint8Array(0);

  /**
   * Push a client audio chunk. Returns zero or more exact 3200-byte frames,
   * each a fresh ArrayBuffer safe to hand straight to the Ink adapter.
   */
  push(chunk: Uint8Array): ArrayBuffer[] {
    if (chunk.byteLength === 0) return [];

    const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.byteLength);

    const frames: ArrayBuffer[] = [];
    let offset = 0;
    while (combined.byteLength - offset >= UPLINK_FRAME_BYTES) {
      // Copy into a standalone ArrayBuffer so downstream retains no view into
      // our rolling buffer.
      const frame = combined.slice(offset, offset + UPLINK_FRAME_BYTES);
      frames.push(
        frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength,
        ),
      );
      offset += UPLINK_FRAME_BYTES;
    }
    this.buffer = combined.slice(offset);
    return frames;
  }

  /** Bytes currently held (0..3199). Test/observability aid. */
  pending(): number {
    return this.buffer.byteLength;
  }

  /** Drop the sub-frame remainder. Never pads to a full frame. */
  flush(): void {
    this.buffer = new Uint8Array(0);
  }
}
