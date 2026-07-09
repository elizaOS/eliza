/** Omi packet reassembly coverage exercises ordering, loss, and codec metadata. */

import { describe, expect, it } from "vitest";

import {
  OMI_CODEC,
  OMI_PACKET_HEADER_SIZE,
  OmiFrameReassembler,
} from "./omi-protocol";

/** Build an omi notification: [idLSB, idMSB, frameIndex, ...payload]. */
function notif(
  packetIndex: number,
  frameIndex: number,
  payload: number[],
): Uint8Array {
  const buf = new Uint8Array(OMI_PACKET_HEADER_SIZE + payload.length);
  buf[0] = packetIndex & 0xff;
  buf[1] = (packetIndex >> 8) & 0xff;
  buf[2] = frameIndex;
  buf.set(payload, OMI_PACKET_HEADER_SIZE);
  return buf;
}

describe("OmiFrameReassembler", () => {
  it("emits each single-chunk frame one packet behind (deferred close)", () => {
    const r = new OmiFrameReassembler();
    // First packet buffers; nothing emitted until the next packet index closes it.
    expect(r.push(notif(0, 0, [1, 2, 3]))).toHaveLength(0);
    const b = r.push(notif(1, 0, [4, 5, 6]));
    expect(b).toHaveLength(1);
    expect(Array.from(b[0].data)).toEqual([1, 2, 3]);
    expect(b[0].packetIndex).toBe(0);
    expect(b[0].droppedBefore).toBe(0);
    // The last buffered frame flushes explicitly.
    const tail = r.flush();
    expect(tail).toHaveLength(1);
    expect(Array.from(tail[0].data)).toEqual([4, 5, 6]);
  });

  it("reassembles a multi-chunk frame in order (same packet, rising frame index)", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(5, 0, [1, 2]));
    r.push(notif(5, 1, [3, 4]));
    r.push(notif(5, 2, [5, 6]));
    // Closing packet 6 emits the fully-reassembled frame 5.
    const emitted = r.push(notif(6, 0, [9]));
    expect(emitted).toHaveLength(1);
    expect(Array.from(emitted[0].data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(emitted[0].packetIndex).toBe(5);
  });

  it("drops an orphan continuation chunk from a different packet", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(5, 0, [1, 2]));
    r.push(notif(9, 1, [7])); // wrong packet index for a frameIndex-1 chunk
    const emitted = r.push(notif(6, 0, [9]));
    // Only the original two bytes survive; the orphan was ignored.
    expect(Array.from(emitted[0].data)).toEqual([1, 2]);
  });

  it("strips the 3-byte header and returns only the payload", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(7, 0, [9, 8, 7, 6, 5]));
    const frames = r.flush();
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].data)).toEqual([9, 8, 7, 6, 5]);
  });

  it("reports dropped packets from an index gap", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(10, 0, [1]));
    r.push(notif(14, 0, [2])); // skipped 11,12,13 — this closes packet 10
    const frames = r.flush(); // flush closes packet 14
    expect(frames[0].droppedBefore).toBe(3);
    expect(frames[0].packetIndex).toBe(14);
  });

  it("handles the uint16 packet-index wrap at 65536 without a spurious gap", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(65535, 0, [1]));
    r.push(notif(0, 0, [2])); // wrapped, closes packet 65535
    const frames = r.flush(); // flush closes the wrapped packet 0
    expect(frames[0].droppedBefore).toBe(0);
  });

  it("ignores tiny header-only notifications", () => {
    const r = new OmiFrameReassembler();
    expect(r.push(new Uint8Array([0, 0, 0]))).toHaveLength(0);
    expect(r.push(new Uint8Array([0, 0]))).toHaveLength(0);
  });

  it("reset() clears drop accounting", () => {
    const r = new OmiFrameReassembler();
    r.push(notif(100, 0, [1]));
    r.reset();
    r.push(notif(200, 0, [2]));
    const frames = r.flush();
    // After reset the first packet establishes a new baseline — no phantom gap.
    expect(frames[0].droppedBefore).toBe(0);
    expect(frames[0].packetIndex).toBe(200);
  });

  it("exposes the DK1 Opus codec id as 20", () => {
    expect(OMI_CODEC.OPUS_16K).toBe(20);
  });
});
