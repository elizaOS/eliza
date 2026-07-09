/**
 * Configurable pendant soak harness for replayed notification stress.
 *
 * The model runs in Bun/Node without real BLE: it replays synthetic notifications
 * through decoder create/free, queue pressure, pause/resume, reconnect, visibility
 * changes, backpressure, duplicate/drop accounting, timer cleanup, and event-loop
 * stall counters, then writes a JSON report.
 */

import {
  OMI_CODEC,
  type OmiCodecId,
  OmiFrameReassembler,
} from "../omi-protocol";
import {
  createPendantAudioDecoder,
  type PendantAudioDecoder,
} from "../opus-frame-decoder";
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

interface CliOptions {
  durationMs: number;
  out?: string;
  ci: boolean;
}

const options = parseArgs(process.argv.slice(2));
const report = await runSoak(options);
writeJsonReport(options.out, report);
if (!report.pass) process.exitCode = 1;

async function runSoak(options: CliOptions) {
  const collector = new PendantJsonMetricCollector();
  const trace = createPendantLatencyTrace({ sink: collector });
  const startedAt = performance.now();
  const memoryStart = process.memoryUsage();
  const counters: Record<string, number> = {
    connects: 0,
    disconnects: 0,
    decoderCreates: 0,
    decoderFrees: 0,
    notifications: 0,
    duplicates: 0,
    dropped: 0,
    decodedFrames: 0,
    pendingUtterances: 0,
    maxPendingUtterances: 0,
    dispatchedSegments: 0,
    duplicateSegmentIds: 0,
    droppedSegmentIds: 0,
    backpressureEvents: 0,
    overloadBursts: 0,
    transportDuplicateInjections: 0,
    transportDropInjections: 0,
    listenersAdded: 0,
    listenersRemoved: 0,
    pauseResumeCycles: 0,
    visibilityChanges: 0,
    reconnects: 0,
    timersStarted: 0,
    timersCleared: 0,
    eventLoopStalls: 0,
  };
  const state = {
    connected: false,
    paused: false,
    visible: true,
    queue: [] as Uint8Array[],
    decoder: null as PendantAudioDecoder | null,
    codec: OMI_CODEC.OPUS_16K as OmiCodecId,
    reassembler: new OmiFrameReassembler(),
    packetIndex: 0,
    frameSeq: 0,
    utteranceSeq: 1,
    nextSegmentId: 1,
    expectedDispatchSegmentId: 1,
  };
  const opusFrames = rawOpusToneFrames();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const pendingSegments: Array<{ id: number; readyAtFrame: number }> = [];
  const dispatchedSegmentIds = new Set<number>();
  let maxQueueDepth = 0;
  let maxHeapUsed = memoryStart.heapUsed;
  let maxRss = memoryStart.rss;
  let lastTick = performance.now();
  let producerTicks = 0;

  async function connect(codec: OmiCodecId): Promise<void> {
    state.decoder = await createPendantAudioDecoder(codec);
    state.codec = codec;
    counters.decoderCreates += 1;
    counters.connects += 1;
    counters.listenersAdded += 2;
    state.connected = true;
    state.reassembler.reset();
  }

  function disconnect(): void {
    state.decoder?.free();
    counters.decoderFrees += state.decoder ? 1 : 0;
    counters.listenersRemoved += state.decoder ? 2 : 0;
    counters.disconnects += 1;
    state.decoder = null;
    state.connected = false;
    state.queue.length = 0;
    state.reassembler.reset();
  }

  function enqueue(payload: Uint8Array): void {
    if (!state.connected || state.paused) return;
    const packetIndex = state.packetIndex & 0xffff;
    const injectDrop =
      state.codec === OMI_CODEC.PCM_16K && state.packetIndex % 53 === 0;
    state.packetIndex += 1;
    if (injectDrop) {
      counters.transportDropInjections += 1;
      return;
    }

    pushBounded(omiNotification(packetIndex, payload));
    counters.notifications += 1;
    if (state.codec === OMI_CODEC.PCM_16K && packetIndex % 47 === 0) {
      pushBounded(omiNotification(packetIndex, payload));
      counters.transportDuplicateInjections += 1;
      counters.duplicates += 1;
      counters.notifications += 1;
    }
    maxQueueDepth = Math.max(maxQueueDepth, state.queue.length);
  }

  function pushBounded(notification: Uint8Array): void {
    if (state.queue.length >= 32) {
      state.queue.shift();
      counters.backpressureEvents += 1;
    }
    state.queue.push(notification);
  }

  function pump(): void {
    if (!state.connected || !state.decoder) return;
    const budget = state.visible ? 8 : 3;
    for (let index = 0; index < budget; index += 1) {
      const notification = state.queue.shift();
      if (!notification) return;
      trace.mark("ble.notification", {
        utteranceSeq: state.utteranceSeq,
        frameSeq: state.frameSeq,
        bytes: notification.byteLength,
      });
      for (const frame of state.reassembler.push(notification)) {
        const frameUtteranceSeq = state.utteranceSeq;
        counters.dropped += frame.droppedBefore;
        trace.mark("reassembly.frame", {
          utteranceSeq: state.utteranceSeq,
          frameSeq: state.frameSeq,
          packetIndex: frame.packetIndex,
          bytes: frame.data.byteLength,
          droppedBefore: frame.droppedBefore,
        });
        trace.mark("decode.start", {
          utteranceSeq: state.utteranceSeq,
          frameSeq: state.frameSeq,
          bytes: frame.data.byteLength,
        });
        const pcm = state.decoder.decodeFrame(frame.data);
        trace.mark("decode.end", {
          utteranceSeq: state.utteranceSeq,
          frameSeq: state.frameSeq,
          samples: pcm.length,
        });
        counters.decodedFrames += pcm.length > 0 ? 1 : 0;
        if (state.frameSeq % 40 === 0) {
          trace.mark("vad.speech", {
            utteranceSeq: state.utteranceSeq,
            frameSeq: state.frameSeq,
          });
          const segmentId = state.nextSegmentId;
          state.nextSegmentId += 1;
          pendingSegments.push({
            id: segmentId,
            readyAtFrame: state.frameSeq + 90,
          });
          counters.pendingUtterances += 1;
          counters.maxPendingUtterances = Math.max(
            counters.maxPendingUtterances,
            pendingSegments.length,
          );
          trace.mark("vad.pending", {
            utteranceSeq: state.utteranceSeq,
            pendingCount: pendingSegments.length,
          });
        }
        while (
          pendingSegments.length > 0 &&
          (pendingSegments[0]?.readyAtFrame ?? Number.POSITIVE_INFINITY) <=
            state.frameSeq
        ) {
          const segment = pendingSegments.shift();
          if (!segment) break;
          if (dispatchedSegmentIds.has(segment.id)) {
            counters.duplicateSegmentIds += 1;
          }
          dispatchedSegmentIds.add(segment.id);
          if (segment.id !== state.expectedDispatchSegmentId) {
            counters.droppedSegmentIds += Math.max(
              0,
              segment.id - state.expectedDispatchSegmentId,
            );
          }
          state.expectedDispatchSegmentId = segment.id + 1;
          counters.dispatchedSegments += 1;
          trace.mark("asr.resolve", { utteranceSeq: state.utteranceSeq });
          trace.mark("segment.dispatch", { utteranceSeq: state.utteranceSeq });
          trace.completeUtterance(state.utteranceSeq);
          state.utteranceSeq += 1;
        }
        trace.completeFrame(frameUtteranceSeq, state.frameSeq);
        state.frameSeq += 1;
      }
    }
  }

  await connect(OMI_CODEC.OPUS_16K);
  const producer = setInterval(
    () => {
      producerTicks += 1;
      // The sustained non-CI rate stays below consumer capacity. Add one
      // bounded overload burst every 30 seconds so a 30-60 minute soak also
      // proves drop-oldest backpressure behavior instead of relying only on CI.
      const overload =
        !options.ci && producerTicks % 3_000 === 0 && !state.paused ? 64 : 0;
      if (overload > 0) counters.overloadBursts += 1;
      const batch = (options.ci ? 8 : 4) + overload;
      for (let i = 0; i < batch; i += 1) {
        const frame =
          state.codec === OMI_CODEC.OPUS_16K
            ? opusFrames[(state.frameSeq + i) % opusFrames.length]
            : state.frameSeq % 11 === 0
              ? pcm16SilenceFrame()
              : pcm16ToneFrame(state.frameSeq + i);
        enqueue(frame ?? pcm16SilenceFrame());
      }
    },
    options.ci ? 1 : 10,
  );
  timers.add(producer);
  const consumer = setInterval(pump, options.ci ? 8 : 5);
  timers.add(consumer);
  let lifecycleBusy = false;
  const lifecycle = setInterval(
    () => {
      if (lifecycleBusy) return;
      lifecycleBusy = true;
      state.paused = true;
      counters.pauseResumeCycles += 1;
      state.visible = !state.visible;
      counters.visibilityChanges += 1;
      setTimeout(
        () => {
          const nextCodec =
            state.codec === OMI_CODEC.OPUS_16K
              ? OMI_CODEC.PCM_16K
              : OMI_CODEC.OPUS_16K;
          disconnect();
          counters.reconnects += 1;
          connect(nextCodec).finally(() => {
            state.paused = false;
            lifecycleBusy = false;
          });
        },
        options.ci ? 25 : 250,
      );
    },
    options.ci ? 3_000 : 60_000,
  );
  timers.add(lifecycle);
  const monitor = setInterval(() => {
    const now = performance.now();
    if (now - lastTick > 250) counters.eventLoopStalls += 1;
    lastTick = now;
    const memory = process.memoryUsage();
    maxHeapUsed = Math.max(maxHeapUsed, memory.heapUsed);
    maxRss = Math.max(maxRss, memory.rss);
  }, 100);
  timers.add(monitor);
  counters.timersStarted = timers.size;

  await new Promise((resolve) => setTimeout(resolve, options.durationMs));
  for (const timer of timers) {
    clearInterval(timer);
    counters.timersCleared += 1;
  }
  while (lifecycleBusy) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  disconnect();
  state.queue.length = 0;
  pendingSegments.length = 0;

  const endedAt = performance.now();
  const memoryEnd = process.memoryUsage();
  const stableChecks = {
    decoderLifecycleBalanced: counters.decoderCreates === counters.decoderFrees,
    timersCleared: counters.timersStarted === counters.timersCleared,
    listenerLifecycleBalanced:
      counters.listenersAdded === counters.listenersRemoved,
    decodedFrames: counters.decodedFrames > 0,
    queueBounded: maxQueueDepth <= 32,
    duplicateAccounting: counters.transportDuplicateInjections > 0,
    dropAccounting: counters.transportDropInjections > 0,
    noDuplicateSegmentIds: counters.duplicateSegmentIds === 0,
    noDroppedSegmentIds: counters.droppedSegmentIds === 0,
    backpressureCovered: counters.backpressureEvents > 0,
    overloadBurstCovered: options.ci || counters.overloadBursts > 0,
    concurrentPendingCovered: counters.maxPendingUtterances >= 2,
    reconnectCovered: counters.reconnects > 0,
    pauseResumeCovered: counters.pauseResumeCycles > 0,
    visibilityCovered: counters.visibilityChanges > 0,
  };
  const evidenceOnly = {
    heapDeltaBytes: memoryEnd.heapUsed - memoryStart.heapUsed,
    rssDeltaBytes: memoryEnd.rss - memoryStart.rss,
    maxHeapUsedBytes: maxHeapUsed,
    maxRssBytes: maxRss,
    eventLoopStalls: counters.eventLoopStalls,
  };
  return {
    issue: 15744,
    lane: "pendant-soak",
    mode: options.ci ? "ci-short" : "soak",
    host: hostInfo(),
    durationMs: Math.round(endedAt - startedAt),
    configuredDurationMs: options.durationMs,
    privacy:
      "synthetic/replayed notifications only; no speech, transcript, audio artifact, or device identifier",
    counters,
    maxQueueDepth,
    stableChecks,
    evidenceOnly,
    latencySummary: collector.summarize(),
    pass: Object.values(stableChecks).every(Boolean),
  };
}

function parseArgs(args: readonly string[]): CliOptions {
  let durationMs = 30 * 60 * 1000;
  let ci = false;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ci") {
      ci = true;
      durationMs = 15_000;
    }
    if (arg === "--minutes") durationMs = Number(args[index + 1]) * 60 * 1000;
    if (arg === "--seconds") durationMs = Number(args[index + 1]) * 1000;
    if (arg === "--out") out = args[index + 1];
  }
  if (!Number.isFinite(durationMs)) {
    throw new Error("soak duration must be a finite number");
  }
  if (!ci && (durationMs < 30 * 60 * 1000 || durationMs > 60 * 60 * 1000)) {
    throw new Error("soak duration must be 30-60 minutes unless --ci is set");
  }
  return { durationMs: Math.max(1_000, Math.trunc(durationMs)), out, ci };
}
