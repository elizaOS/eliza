/**
 * Deterministic coverage for the pendant BLE frame reassembler. The harness
 * models both observed packet-id contracts without real Bluetooth or codecs.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_OMI_NOTIFICATION_BYTES,
  MAX_OMI_REASSEMBLED_FRAME_BYTES,
  OMI_CODEC,
  OMI_PACKET_HEADER_SIZE,
  OmiFrameReassembler,
  type OmiFrameReassemblerResult,
} from "./omi-protocol";

function notif(
  packetIndex: number,
  chunkIndex: number,
  payload: number[],
): Uint8Array {
  const buf = new Uint8Array(OMI_PACKET_HEADER_SIZE + payload.length);
  buf[0] = packetIndex & 0xff;
  buf[1] = (packetIndex >> 8) & 0xff;
  buf[2] = chunkIndex;
  buf.set(payload, OMI_PACKET_HEADER_SIZE);
  return buf;
}

function payload(length: number, seed: number): number[] {
  return Array.from({ length }, (_, i) => (seed + i * 17) & 0xff);
}

function chunks(data: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += size) {
    out.push(data.slice(i, i + size));
  }
  return out;
}

function pushAll(
  reassembler: OmiFrameReassembler,
  notifications: Uint8Array[],
): OmiFrameReassemblerResult[] {
  return notifications.map((notification, i) =>
    reassembler.pushDetailed(notification, 1000 + i * 10),
  );
}

function emittedPayloads(results: OmiFrameReassemblerResult[]): number[][] {
  return results.flatMap((result) =>
    result.frames.map((frame) => Array.from(frame.data)),
  );
}

function diagnostics(results: OmiFrameReassemblerResult[]): string[] {
  return results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );
}

function sequenceFrame(startPacket: number, parts: number[][]): Uint8Array[] {
  return parts.map((part, i) => notif((startPacket + i) & 0xffff, i, part));
}

function frameIdFrame(packetIndex: number, parts: number[][]): Uint8Array[] {
  return parts.map((part, i) => notif(packetIndex, i, part));
}

describe("OmiFrameReassembler", () => {
  it("defers and ignores a bumped-index retransmit in sequence mode", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1, 2, 3]),
      notif(10, 1, [1, 2, 3]),
      // Repeating chunk 1 while the raw notification index advances resolves
      // the prior same-id equal payload as a retransmit.
      notif(11, 1, [4, 5, 6]),
      notif(12, 0, [7, 8, 9]),
    ]);

    expect(diagnostics(results)).toContain("duplicate-notification");
    expect(diagnostics(results)).not.toContain("mode-conflict");
    expect(emittedPayloads(results)).toEqual([[1, 2, 3, 4, 5, 6]]);
    const metrics = r.getMetricsSnapshot();
    expect(metrics.detectedWireMode).toBe("notification-sequence");
    expect(metrics.duplicates).toBe(1);
  });

  it("drops an equal same-id tail when the next chunk-0 cannot resolve its mode", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1, 2, 3]),
      notif(10, 1, [1, 2, 3]),
      notif(11, 0, [4, 5, 6]),
    ]);

    expect(diagnostics(results)).toContain("dropped-buffered-frame");
    expect(emittedPayloads(results)).toEqual([]);
    expect(r.getMetricsSnapshot().detectedWireMode).toBe("unknown");
  });

  it("accounts for a packet gap after an unresolved equal same-id tail", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1, 2, 3]),
      notif(10, 1, [1, 2, 3]),
      notif(13, 0, [4, 5, 6]),
    ]);

    expect(diagnostics(results)).toContain("missing-notification");
    expect(r.getMetricsSnapshot().missingNotifications).toBe(2);
  });

  it("preserves identical adjacent chunks in legacy frame-id mode", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1, 2, 3]),
      // Equal payload bytes are valid when the chunk index advances. Treating
      // this as a retransmit would silently truncate the encoded audio frame.
      notif(10, 1, [1, 2, 3]),
      // A later non-equal same-id chunk resolves the ambiguity as legacy mode.
      notif(10, 2, [7, 8, 9]),
      notif(11, 0, [4, 5, 6]),
    ]);

    expect(diagnostics(results)).not.toContain("duplicate-notification");
    expect(emittedPayloads(results)).toEqual([[1, 2, 3, 1, 2, 3, 7, 8, 9]]);
    const metrics = r.getMetricsSnapshot();
    expect(metrics.detectedWireMode).toBe("frame-id");
    expect(metrics.duplicates).toBe(0);
  });

  it("emits a single-notification frame when the next frame starts", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(0, 0, [1, 2, 3]),
      notif(1, 0, [4, 5, 6]),
    ]);

    expect(emittedPayloads(results)).toEqual([[1, 2, 3]]);
    const tail = r.flushDetailed();
    expect(tail.frames).toEqual([]);
    expect(diagnostics([tail])).toContain("ambiguous-tail");
    expect(r.getMetricsSnapshot().detectedWireMode).toBe("unknown");
  });

  it("reassembles notification-sequence continuation chunks", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      ...sequenceFrame(5, [
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
      notif(8, 0, [9]),
    ]);

    expect(emittedPayloads(results)).toEqual([[1, 2, 3, 4, 5, 6]]);
    expect(r.getMetricsSnapshot().detectedWireMode).toBe(
      "notification-sequence",
    );
  });

  it("reassembles legacy frame-id continuation chunks", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      ...frameIdFrame(5, [
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
      notif(6, 0, [9]),
    ]);

    expect(emittedPayloads(results)).toEqual([[1, 2, 3, 4, 5, 6]]);
    expect(r.getMetricsSnapshot().detectedWireMode).toBe("frame-id");
  });

  it("handles consecutive frames under both wire semantics", () => {
    const sequence = new OmiFrameReassembler();
    const sequenceResults = pushAll(sequence, [
      ...sequenceFrame(10, [[1], [2]]),
      ...sequenceFrame(12, [[3], [4], [5]]),
      notif(15, 0, [6]),
    ]);
    expect(emittedPayloads(sequenceResults)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);

    const legacy = new OmiFrameReassembler();
    const legacyResults = pushAll(legacy, [
      ...frameIdFrame(10, [[1], [2]]),
      ...frameIdFrame(11, [[3], [4], [5]]),
      notif(12, 0, [6]),
    ]);
    expect(emittedPayloads(legacyResults)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("handles uint16 wraparound for notification-sequence ids", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      ...sequenceFrame(65534, [[1], [2], [3]]),
      notif(1, 0, [4]),
    ]);

    expect(emittedPayloads(results)).toEqual([[1, 2, 3]]);
    expect(r.getMetricsSnapshot().missingNotifications).toBe(0);
  });

  it("ignores an exact duplicate notification with a typed diagnostic", () => {
    const r = new OmiFrameReassembler();
    const first = notif(1, 0, [7]);
    const duplicate = notif(1, 0, [7]);
    const results = pushAll(r, [first, duplicate, notif(2, 0, [8])]);

    expect(diagnostics(results)).toContain("duplicate-notification");
    expect(r.getMetricsSnapshot().duplicates).toBe(1);
    expect(emittedPayloads(results)).toEqual([[7]]);
  });

  it("drops an unconfirmed split-frame tail when its final chunk is lost", () => {
    const r = new OmiFrameReassembler();
    pushAll(r, [notif(20, 0, [1]), notif(21, 1, [2])]);

    const result = r.flushDetailed();
    expect(result.frames).toEqual([]);
    expect(diagnostics([result])).toContain("ambiguous-tail");
    expect(result.metrics.droppedFrames).toBe(1);
    expect(result.metrics.detectedWireMode).toBe("notification-sequence");
  });

  it("drops an unexpected continuation after a missing first chunk", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(5, 1, [1]),
      notif(6, 0, [2]),
      notif(7, 0, [3]),
    ]);

    expect(diagnostics(results)).toContain("unexpected-continuation");
    expect(emittedPayloads(results)).toEqual([[2]]);
    expect(r.getMetricsSnapshot().missingChunks).toBe(1);
  });

  it("drops a frame when a middle chunk is missing", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1]),
      notif(12, 2, [3]),
      notif(13, 0, [9]),
      notif(14, 0, [10]),
    ]);

    expect(diagnostics(results)).toContain("missing-chunk");
    expect(emittedPayloads(results)).toEqual([[9]]);
    expect(r.getMetricsSnapshot().droppedFrames).toBe(1);
  });

  it("drops a pending frame when a sequence-id gap precedes the next chunk-0 frame", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(20, 0, [1]),
      notif(21, 1, [2]),
      notif(23, 0, [9]),
      notif(24, 0, [10]),
    ]);

    expect(diagnostics(results)).toContain("missing-notification");
    expect(emittedPayloads(results)).toEqual([[9]]);
    expect(r.getMetricsSnapshot().droppedFrames).toBe(1);
  });

  it("drops out-of-order notifications and recovers at the next chunk-0 frame", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(10, 0, [1]),
      notif(9, 1, [2]),
      notif(11, 0, [3]),
      notif(12, 0, [4]),
    ]);

    expect(diagnostics(results)).toContain("out-of-order");
    expect(emittedPayloads(results)).toEqual([[3]]);
    expect(r.getMetricsSnapshot().outOfOrder).toBe(1);
  });

  it("rejects empty, short, and header-only notifications", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      new Uint8Array(),
      new Uint8Array([1]),
      new Uint8Array([1, 0]),
      new Uint8Array([1, 0, 0]),
    ]);

    expect(diagnostics(results)).toEqual([
      "malformed-notification",
      "malformed-notification",
      "malformed-notification",
      "malformed-notification",
    ]);
    expect(r.getMetricsSnapshot().malformedNotifications).toBe(4);
  });

  it("drops a pending frame when a malformed notification interrupts it", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(1, 0, [1]),
      new Uint8Array([2, 0, 1]),
      notif(3, 0, [3]),
      notif(4, 0, [4]),
    ]);

    expect(diagnostics(results)).toContain("malformed-notification");
    expect(emittedPayloads(results)).toEqual([[3]]);
    expect(r.getMetricsSnapshot().droppedFrames).toBe(1);
  });

  it("drops invalid chunk progression without emitting partial audio", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(1, 0, [1]),
      notif(2, 2, [3]),
      notif(3, 0, [4]),
      notif(4, 0, [5]),
    ]);

    expect(diagnostics(results)).toContain("missing-chunk");
    expect(emittedPayloads(results)).toEqual([[4]]);
  });

  it("drops a buffered frame when continuation evidence conflicts with frame-id mode", () => {
    const r = new OmiFrameReassembler();
    const results = pushAll(r, [
      notif(5, 0, [1]),
      notif(5, 1, [2]),
      notif(6, 2, [3]),
      notif(7, 0, [4]),
      notif(8, 0, [5]),
    ]);

    expect(diagnostics(results)).toContain("mode-conflict");
    expect(emittedPayloads(results)).toEqual([[4]]);
    expect(r.getMetricsSnapshot().detectedWireMode).toBe("frame-id");
  });

  it("records cadence mean and p95 from injected receive times", () => {
    const r = new OmiFrameReassembler();
    r.pushDetailed(notif(1, 0, [1]), 100);
    r.pushDetailed(notif(2, 0, [2]), 110);
    r.pushDetailed(notif(3, 0, [3]), 150);
    r.pushDetailed(notif(4, 0, [4]), 160);

    const metrics = r.getMetricsSnapshot();
    expect(metrics.cadenceMeanMs).toBe(20);
    expect(metrics.cadenceP95Ms).toBe(40);
    expect(metrics.notificationCount).toBe(4);
    expect(metrics.notificationBytes).toBe(16);
  });

  it("covers generated payloads across modeled MTU chunk sizes", () => {
    for (const payloadLength of [1, 2, 3, 8, 31, 64, 95]) {
      for (const chunkSize of [1, 2, 5, 20, 64]) {
        const body = payload(payloadLength, chunkSize);
        const parts = chunks(body, chunkSize);

        const sequence = new OmiFrameReassembler();
        const sequenceResults = pushAll(sequence, [
          ...sequenceFrame(100, parts),
          notif((100 + parts.length) & 0xffff, 0, [255]),
        ]);
        expect(emittedPayloads(sequenceResults)).toEqual([body]);

        const legacy = new OmiFrameReassembler();
        const legacyResults = pushAll(legacy, [
          ...frameIdFrame(200, parts),
          notif(201, 0, [255]),
        ]);
        expect(emittedPayloads(legacyResults)).toEqual([body]);
      }
    }
  });

  it("preserves array-returning push and flush compatibility", () => {
    const r = new OmiFrameReassembler();
    expect(r.push(notif(1, 0, [1]))).toEqual([]);
    expect(r.push(notif(2, 0, [2])).map((frame) => [...frame.data])).toEqual([
      [1],
    ]);
    expect(r.flush()).toEqual([]);
  });

  it("emits a complete legacy frame-id buffer across a frame gap", () => {
    const r = new OmiFrameReassembler();
    r.pushDetailed(notif(5, 0, [1]));
    r.pushDetailed(notif(5, 1, [2]));

    const result = r.pushDetailed(notif(7, 0, [7]));
    expect(emittedPayloads([result])).toEqual([[1, 2]]);
    expect(result.metrics.missingNotifications).toBe(1);
    expect(result.metrics.droppedFrames).toBe(0);
  });

  it("exposes the DK1 Opus codec id as 20", () => {
    expect(OMI_CODEC.OPUS_16K).toBe(20);
  });

  it("rejects an oversized GATT notification instead of holding megabytes", () => {
    const r = new OmiFrameReassembler();
    const bomb = new Uint8Array(MAX_OMI_NOTIFICATION_BYTES + 1);
    bomb[2] = 0;
    const result = r.pushDetailed(bomb, 1000);
    expect(result.frames).toEqual([]);
    expect(diagnostics([result])).toEqual(["oversized-notification"]);
    expect(result.metrics.malformedNotifications).toBe(1);
    expect(result.metrics.emittedFrames).toBe(0);
    expect(r.push(notif(1, 0, [1, 2, 3]))).toEqual([]);
    expect(
      r.push(notif(2, 0, [4, 5, 6])).map((frame) => [...frame.data]),
    ).toEqual([[1, 2, 3]]);
  });

  it("drops a continuation that would emit an oversized reassembled frame", () => {
    const r = new OmiFrameReassembler();
    const chunk = 2_000;
    expect(chunk + OMI_PACKET_HEADER_SIZE).toBeLessThanOrEqual(
      MAX_OMI_NOTIFICATION_BYTES,
    );
    r.pushDetailed(notif(0, 0, payload(chunk, 1)), 1000);
    for (let i = 1; i < 8; i += 1) {
      r.pushDetailed(notif(i, i, payload(chunk, i + 1)), 1000 + i * 10);
    }
    const overflow = r.pushDetailed(notif(8, 8, payload(chunk, 9)), 1080);
    expect(overflow.frames).toEqual([]);
    expect(diagnostics([overflow])).toContain("dropped-buffered-frame");
    expect(overflow.metrics.droppedFrames).toBe(1);
    expect(overflow.metrics.emittedFrames).toBe(0);
    expect(8 * chunk).toBeLessThanOrEqual(MAX_OMI_REASSEMBLED_FRAME_BYTES);
    expect(9 * chunk).toBeGreaterThan(MAX_OMI_REASSEMBLED_FRAME_BYTES);
  });

  it("still reassembles an honest multi-chunk Opus-sized frame", () => {
    const r = new OmiFrameReassembler();
    const body = payload(80, 9);
    const results = pushAll(r, [
      ...sequenceFrame(10, chunks(body, 40)),
      notif(12, 0, [1]),
    ]);
    expect(emittedPayloads(results)).toEqual([body]);
  });
});
