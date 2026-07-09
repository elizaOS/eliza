/**
 * Pendant latency contract tests keep instrumentation privacy-safe and stable
 * for transcript, session-sync, and insights lanes that add their own marks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PendantJsonMetricCollector } from "./collector";
import {
  createPendantLatencyTrace,
  isPendantLatencyMarkName,
  PENDANT_LATENCY_CONTRACT_VERSION,
  type PendantLatencyMark,
  type PendantLatencyMetric,
} from "./pendant-latency";

describe("pendant latency contract", () => {
  it("emits sanitized marks and derived metrics without payload fields", () => {
    let now = 10;
    const marks: PendantLatencyMark[] = [];
    const metrics: PendantLatencyMetric[] = [];
    const trace = createPendantLatencyTrace({
      clock: () => {
        now += 5;
        return now;
      },
      sink: {
        mark: (mark) => marks.push(mark),
        metric: (metric) => metrics.push(metric),
      },
    });

    trace.mark("ble.notification", {
      utteranceSeq: 1,
      frameSeq: 2,
      bytes: 50,
    });
    trace.mark("reassembly.frame", {
      utteranceSeq: 1,
      frameSeq: 2,
      packetIndex: 7,
      bytes: 47,
    });
    trace.mark("decode.start", { utteranceSeq: 1, frameSeq: 2 });
    trace.mark("decode.end", { utteranceSeq: 1, frameSeq: 2, samples: 160 });
    trace.mark("vad.speech", { utteranceSeq: 1, frameSeq: 2 });
    trace.mark("vad.pending", { utteranceSeq: 1 });
    trace.mark("wav.encode.start", { utteranceSeq: 1 });
    trace.mark("wav.encode.end", { utteranceSeq: 1 });
    trace.mark("asr.request", { utteranceSeq: 1 });
    trace.mark("asr.resolve", { utteranceSeq: 1 });
    trace.mark("segment.dispatch", { utteranceSeq: 1 });
    trace.mark("ui.pending", { utteranceSeq: 1 });
    trace.mark("session.follower.propagated", { utteranceSeq: 1 });
    trace.mark("insight.update", { utteranceSeq: 1 });

    expect(marks[0]).toEqual({
      contractVersion: PENDANT_LATENCY_CONTRACT_VERSION,
      name: "ble.notification",
      atMs: 15,
      utteranceSeq: 1,
      frameSeq: 2,
      packetIndex: undefined,
      bytes: 50,
      samples: undefined,
      droppedBefore: undefined,
      pendingCount: undefined,
    });
    expect(Object.keys(marks[0] ?? {})).not.toContain("text");
    expect(Object.keys(marks[0] ?? {})).not.toContain("audio");
    expect(Object.keys(marks[0] ?? {})).not.toContain("deviceId");
    expect(metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        "ble_to_reassembly_ms",
        "decode_ms",
        "wav_encode_ms",
        "asr_ms",
        "vad_pending_to_asr_resolve_ms",
        "vad_pending_to_ui_pending_ms",
        "vad_pending_to_follower_propagated_ms",
        "vad_pending_to_insight_update_ms",
        "ble_to_dispatch_ms",
      ]),
    );
  });

  it("anchors dispatch to the first VAD-positive frame BLE arrival", () => {
    const metrics: PendantLatencyMetric[] = [];
    const trace = createPendantLatencyTrace({
      sink: { mark: () => undefined, metric: (metric) => metrics.push(metric) },
      clock: (() => {
        let now = 0;
        return () => (now += 1);
      })(),
    });

    trace.mark("ble.notification", { utteranceSeq: 1, frameSeq: 0 });
    trace.mark("reassembly.frame", { utteranceSeq: 1, frameSeq: 0 });
    trace.mark("decode.start", { utteranceSeq: 1, frameSeq: 0 });
    trace.mark("decode.end", { utteranceSeq: 1, frameSeq: 0 });
    trace.mark("vad.speech", { utteranceSeq: 1, frameSeq: 0 });
    trace.completeFrame(1, 0);
    trace.mark("ble.notification", { utteranceSeq: 1, frameSeq: 1 });
    trace.mark("vad.pending", { utteranceSeq: 1 });
    trace.mark("asr.request", { utteranceSeq: 1 });
    trace.mark("asr.resolve", { utteranceSeq: 1 });
    trace.mark("segment.dispatch", { utteranceSeq: 1 });

    expect(
      metrics.find((metric) => metric.name === "ble_to_dispatch_ms")?.valueMs,
    ).toBe(9);
  });

  it("keeps bounded current state and explicitly cleans completed utterances", () => {
    const trace = createPendantLatencyTrace({
      clock: (() => {
        let now = 0;
        return () => (now += 1);
      })(),
    });

    for (let utteranceSeq = 1; utteranceSeq <= 400; utteranceSeq += 1) {
      trace.mark("ble.notification", { utteranceSeq, frameSeq: utteranceSeq });
      trace.mark("reassembly.frame", {
        utteranceSeq,
        frameSeq: utteranceSeq,
      });
      trace.mark("decode.start", { utteranceSeq, frameSeq: utteranceSeq });
      trace.mark("decode.end", { utteranceSeq, frameSeq: utteranceSeq });
      trace.mark("vad.speech", { utteranceSeq });
      trace.completeUtterance(utteranceSeq);
    }

    expect(trace.snapshot()).toHaveLength(256);
    trace.reset();
    expect(trace.snapshot()).toHaveLength(0);
  });

  it("aggregates collector metrics online with bounded retained samples", () => {
    const collector = new PendantJsonMetricCollector();
    const trace = createPendantLatencyTrace({ sink: collector });

    for (let utteranceSeq = 1; utteranceSeq <= 2_000; utteranceSeq += 1) {
      trace.mark("asr.request", { utteranceSeq });
      trace.mark("asr.resolve", { utteranceSeq });
      trace.completeUtterance(utteranceSeq);
    }

    expect(collector.marks.length).toBeLessThanOrEqual(256);
    expect(collector.metrics.length).toBeLessThanOrEqual(256);
    expect(collector.summarize().asr_ms?.count).toBe(2_000);
  });

  it("isolates mark, metric, and count sink failures from the audio path", () => {
    const trace = createPendantLatencyTrace({
      sink: {
        mark: () => {
          throw new Error("mark collector failed");
        },
        metric: () => {
          throw new Error("metric collector failed");
        },
        count: () => {
          throw new Error("count collector failed");
        },
      },
      clock: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });

    expect(() => {
      trace.mark("ble.notification", { utteranceSeq: 1, frameSeq: 1 });
      trace.mark("reassembly.frame", { utteranceSeq: 1, frameSeq: 1 });
      trace.count("packet_drop", 1);
    }).not.toThrow();
    expect(trace.snapshot()).toHaveLength(2);
  });

  it("uses nearest-rank percentiles for small latency samples", () => {
    const collector = new PendantJsonMetricCollector();
    for (const valueMs of [1, 100]) {
      collector.metric({
        contractVersion: PENDANT_LATENCY_CONTRACT_VERSION,
        name: "asr_ms",
        valueMs,
        utteranceSeq: 1,
      });
    }

    expect(collector.summarize().asr_ms).toEqual({
      count: 2,
      p50: 1,
      p95: 100,
      max: 100,
    });
  });

  it("reserves forward-compatible cross-lane marks", () => {
    expect(isPendantLatencyMarkName("ui.pending")).toBe(true);
    expect(isPendantLatencyMarkName("session.follower.propagated")).toBe(true);
    expect(isPendantLatencyMarkName("insight.update")).toBe(true);
    expect(isPendantLatencyMarkName("transcript text")).toBe(false);
  });

  it("keeps opus and native BLE dependencies behind dynamic imports", () => {
    const pendantDir = join(import.meta.dirname, "..");
    const opusDecoderSource = readFileSync(
      join(pendantDir, "opus-frame-decoder.ts"),
      "utf8",
    );
    const nativeBleSource = readFileSync(
      join(pendantDir, "native-ble-transport.ts"),
      "utf8",
    );
    const selectorSource = readFileSync(
      join(pendantDir, "select-transport.ts"),
      "utf8",
    );
    const barrelSource = readFileSync(join(pendantDir, "index.ts"), "utf8");

    expect(opusDecoderSource).toContain('import("opus-decoder")');
    expect(opusDecoderSource).not.toMatch(
      /import\s+.*from\s+["']opus-decoder["']/,
    );
    expect(nativeBleSource).toContain(
      'import("@capacitor-community/bluetooth-le")',
    );
    expect(nativeBleSource).not.toMatch(
      /import\s+.*from\s+["']@capacitor-community\/bluetooth-le["']/,
    );
    expect(selectorSource).toContain('import("./native-ble-transport")');
    expect(selectorSource).not.toMatch(
      /import\s+\{[^}]*NativeBlePendantTransport[^}]*\}\s+from\s+["']\.\/native-ble-transport["']/,
    );
    expect(barrelSource).not.toContain("NativeBlePendantTransport");
  });
});
