/**
 * Deterministic pendant replay benchmark for the audio latency lane.
 *
 * It replays committed non-speech fixtures through packet reassembly, the real
 * wasm Opus decoder, VAD, WAV encoding, local ASR-client serialization/fetch
 * overhead against a no-content sink, and segment dispatch accounting.
 */

import { createServer } from "node:http";

import {
  createLocalAsrAutoStopDetector,
  encodeMonoPcm16Wav,
} from "../../voice/local-asr-capture";
import {
  OMI_CODEC,
  OMI_OPUS_SAMPLE_RATE_HZ,
  OmiFrameReassembler,
} from "../omi-protocol";
import { createPendantAudioDecoder } from "../opus-frame-decoder";
import {
  hostInfo,
  PendantJsonMetricCollector,
  writeJsonReport,
} from "./collector";
import {
  omiNotification,
  pcm16SilenceFrame,
  pcm16ToneFrame,
  rawOpusToneFrames,
} from "./fixtures";
import { createPendantLatencyTrace } from "./pendant-latency";

const BUDGETS = {
  reassembly_p95_ms: 0.3,
  opus_decode_p95_ms: archBudget({ arm64: 3.5, x64: 3.0, defaultValue: 6 }),
  vad_wav_asr_dispatch_p95_ms: archBudget({
    arm64: 35,
    x64: 25,
    defaultValue: 50,
  }),
  dropped_packets_max: 0,
} as const;

interface CliOptions {
  iterations: number;
  out?: string;
}

const options = parseArgs(process.argv.slice(2));
const collector = new PendantJsonMetricCollector();
const trace = createPendantLatencyTrace({ sink: collector });
const server = await createNoContentAsrSink();

try {
  const result = await runBenchmark(options.iterations, server.url);
  writeJsonReport(options.out, result);
  if (!result.pass) process.exitCode = 1;
} finally {
  await server.close();
}

async function runBenchmark(iterations: number, asrUrl: string) {
  const opusFrames = rawOpusToneFrames();
  const decoder = await createPendantAudioDecoder(OMI_CODEC.OPUS_16K);
  const pcmDecoder = await createPendantAudioDecoder(OMI_CODEC.PCM_16K);
  const reassembler = new OmiFrameReassembler();
  const opusDecodeTimes: number[] = [];
  const pcmDecodeTimes: number[] = [];
  const reassemblyTimes: number[] = [];
  const pipelineTimes: number[] = [];
  let droppedPackets = 0;
  let dispatches = 0;
  let corruptedOpusFrames = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const utteranceSeq = iteration + 1;
    const vad = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, minSpeechMs: 20, silenceMs: 30 },
      0,
    );
    if (!vad) throw new Error("VAD detector was not created");
    const chunks: Float32Array[] = [];
    let totalSamples = 0;
    let frameSeq = 0;
    const pipelineStart = performance.now();

    const payloads =
      iteration % 2 === 0
        ? opusFrames
        : Array.from({ length: 32 }, (_, index) =>
            index < 24 ? pcm16ToneFrame(index) : pcm16SilenceFrame(),
          );
    const isOpusCase = iteration % 2 === 0;
    const activeDecoder = isOpusCase ? decoder : pcmDecoder;

    for (const payload of payloads) {
      const notification = omiNotification(frameSeq, payload);
      trace.mark("ble.notification", {
        utteranceSeq,
        frameSeq,
        bytes: notification.byteLength,
      });
      const reassemblyStart = performance.now();
      const frames = reassembler.push(notification);
      reassemblyTimes.push(performance.now() - reassemblyStart);

      for (const frame of frames) {
        droppedPackets += frame.droppedBefore;
        trace.mark("reassembly.frame", {
          utteranceSeq,
          frameSeq,
          packetIndex: frame.packetIndex,
          bytes: frame.data.byteLength,
          droppedBefore: frame.droppedBefore,
        });
        trace.mark("decode.start", {
          utteranceSeq,
          frameSeq,
          bytes: frame.data.byteLength,
        });
        const decodeStart = performance.now();
        const pcm = activeDecoder.decodeFrame(frame.data);
        const decodeMs = performance.now() - decodeStart;
        if (isOpusCase) opusDecodeTimes.push(decodeMs);
        else pcmDecodeTimes.push(decodeMs);
        trace.mark("decode.end", {
          utteranceSeq,
          frameSeq,
          samples: pcm.length,
        });
        if (isOpusCase && pcm.length === 0) corruptedOpusFrames += 1;
        if (pcm.length > 0) {
          const update = vad(pcm, frameSeq * 10);
          if (update.shouldBuffer) {
            if (chunks.length === 0) {
              trace.mark("vad.speech", { utteranceSeq, frameSeq });
            }
            chunks.push(pcm);
            totalSamples += pcm.length;
          }
          if (update.shouldStop) trace.mark("vad.pending", { utteranceSeq });
        }
        trace.completeFrame(utteranceSeq, frameSeq);
        frameSeq += 1;
      }
    }
    for (const frame of reassembler.flush()) {
      const pcm = activeDecoder.decodeFrame(frame.data);
      if (isOpusCase && pcm.length === 0) corruptedOpusFrames += 1;
      if (pcm.length > 0) {
        chunks.push(pcm);
        totalSamples += pcm.length;
      }
    }
    const pcm = concat(chunks, totalSamples);
    trace.mark("wav.encode.start", { utteranceSeq, samples: pcm.length });
    const wav = encodeMonoPcm16Wav(pcm, OMI_OPUS_SAMPLE_RATE_HZ);
    trace.mark("wav.encode.end", { utteranceSeq, bytes: wav.byteLength });
    trace.mark("asr.request", { utteranceSeq, bytes: wav.byteLength });
    await postNoContentAsr(asrUrl, wav);
    trace.mark("asr.resolve", { utteranceSeq });
    trace.mark("segment.dispatch", { utteranceSeq });
    dispatches += 1;
    pipelineTimes.push(performance.now() - pipelineStart);
    trace.completeUtterance(utteranceSeq);
    trace.reset();
    reassembler.reset();
  }

  decoder.free();
  pcmDecoder.free();
  const summary = collector.summarize();
  const checks = {
    reassembly_p95_ms: p95(reassemblyTimes) <= BUDGETS.reassembly_p95_ms,
    opus_decode_p95_ms: p95(opusDecodeTimes) <= BUDGETS.opus_decode_p95_ms,
    opus_fixture_clean: corruptedOpusFrames === 0,
    vad_wav_asr_dispatch_p95_ms:
      p95(pipelineTimes) <= BUDGETS.vad_wav_asr_dispatch_p95_ms,
    dropped_packets_max: droppedPackets <= BUDGETS.dropped_packets_max,
  };

  return {
    issue: 15744,
    lane: "pendant-performance-replay",
    host: hostInfo(),
    fixture: {
      kind: "synthetic-tone-silence",
      privacy: "no speech, audio text, device identifier, or transcript data",
      framingDependentCases: [
        "multi-chunk framing is covered by reassembler tests, not this decode benchmark",
      ],
    },
    iterations,
    dispatches,
    droppedPackets,
    budgets: BUDGETS,
    checks,
    pass: Object.values(checks).every(Boolean),
    raw: {
      reassemblyP95Ms: p95(reassemblyTimes),
      opusDecodeP95Ms: p95(opusDecodeTimes),
      pcmDecodeP95Ms: p95(pcmDecodeTimes),
      pipelineP95Ms: p95(pipelineTimes),
      corruptedOpusFrames,
    },
    latencySummary: summary,
    counters: collector.counters,
  };
}

async function createNoContentAsrSink(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ASR sink failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/asr/local-inference`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function postNoContentAsr(url: string, wav: Uint8Array): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ audioBase64: Buffer.from(wav).toString("base64") }),
  });
  if (response.status !== 204) {
    throw new Error(`ASR sink returned ${response.status}`);
  }
}

function concat(chunks: readonly Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function archBudget(values: {
  arm64: number;
  x64: number;
  defaultValue: number;
}): number {
  if (process.arch === "arm64") return values.arm64;
  if (process.arch === "x64") return values.x64;
  return values.defaultValue;
}

function parseArgs(args: readonly string[]): CliOptions {
  let iterations = 30;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--iterations") iterations = Number(args[index + 1]);
    if (arg === "--out") out = args[index + 1];
  }
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error("iterations must be a positive finite number");
  }
  return { iterations: Math.trunc(iterations), out };
}
