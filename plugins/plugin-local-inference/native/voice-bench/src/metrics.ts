/**
 * Metrics collector for the voice-loop benchmark harness.
 *
 * Subscribes to the `VoiceBenchProbe` callback the pipeline / VAD /
 * chunker / scheduler invoke. Captures timestamps for the canonical
 * lifecycle events (see `BenchEventName` in `types.ts`) and derives the
 * latency numbers an optimization PR has to clear gates on.
 *
 * No fallbacks. Missing required events fail the run with a clear error
 * — per AGENTS.md commandment 8, silent defaults hide broken pipelines.
 */

import type {
  BenchDriverResult,
  BenchEvent,
  BenchEventName,
  BenchMetrics,
  BenchResourceUsage,
} from "./types.ts";

const REQUIRED_FOR_TTFA: BenchEventName[] = [
  "speech-start",
  "speech-end",
  "audio-out-first-frame",
];

export interface MetricsCollectorOpts {
  fixtureId: string;
  /** When provided, samples RSS / CPU at this cadence (ms). */
  resourceSampleMs?: number;
}

/**
 * Holds raw timestamps for every `BenchEventName` recorded during a run.
 * Each event captures *first* and *last* observations (some events fire
 * many times — e.g. `asr-partial`); for latency math we use first
 * observations only.
 */
export class MetricsCollector {
  private readonly fixtureId: string;
  private readonly events: BenchEvent[] = [];
  private readonly firstByName = new Map<BenchEventName, number>();
  private readonly lastByName = new Map<BenchEventName, number>();
  private readonly counts = new Map<BenchEventName, number>();
  private readonly startedAt: number;
  private resourceTimer: ReturnType<typeof setInterval> | null = null;
  private peakRssMb = 0;
  private peakCpuPct = 0;
  private peakGpuPct: number | undefined;
  private lastCpu: { user: number; system: number } | null = null;
  private lastCpuAt = 0;

  constructor(opts: MetricsCollectorOpts) {
    this.fixtureId = opts.fixtureId;
    this.startedAt = performance.now();
    if (opts.resourceSampleMs && opts.resourceSampleMs > 0) {
      this.resourceTimer = setInterval(
        () => this.sampleResources(),
        opts.resourceSampleMs,
      );
    }
  }

  /** Probe entrypoint passed to the pipeline driver. */
  record = (
    name: BenchEventName,
    data?: Record<string, number | string | boolean>,
  ): void => {
    const atMs = performance.now() - this.startedAt;
    const entry: BenchEvent = data ? { name, atMs, data } : { name, atMs };
    this.events.push(entry);
    if (!this.firstByName.has(name)) this.firstByName.set(name, atMs);
    this.lastByName.set(name, atMs);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  };

  /** All raw events captured, in arrival order. */
  rawEvents(): readonly BenchEvent[] {
    return this.events;
  }

  firstAt(name: BenchEventName): number | undefined {
    return this.firstByName.get(name);
  }

  lastAt(name: BenchEventName): number | undefined {
    return this.lastByName.get(name);
  }

  countOf(name: BenchEventName): number {
    return this.counts.get(name) ?? 0;
  }

  private sampleResources(): void {
    const mem = process.memoryUsage();
    const rssMb = mem.rss / (1024 * 1024);
    if (rssMb > this.peakRssMb) this.peakRssMb = rssMb;
    // Best-effort CPU. process.cpuUsage() is microseconds since process
    // start (or since the previous call's returned object when passed).
    const cpu = process.cpuUsage();
    const now = performance.now();
    if (this.lastCpu) {
      const userDelta = cpu.user - this.lastCpu.user;
      const sysDelta = cpu.system - this.lastCpu.system;
      const wallDelta = (now - this.lastCpuAt) * 1000; // µs
      if (wallDelta > 0) {
        const pct = ((userDelta + sysDelta) / wallDelta) * 100;
        if (pct > this.peakCpuPct) this.peakCpuPct = pct;
      }
    }
    this.lastCpu = { user: cpu.user, system: cpu.system };
    this.lastCpuAt = now;
  }

  /** Stop the resource sampler. Call at the end of a run. */
  stopSampling(): void {
    if (this.resourceTimer) {
      clearInterval(this.resourceTimer);
      this.resourceTimer = null;
    }
    // Always take one final sample so a fast run still has a peak.
    this.sampleResources();
  }

  /** Currently-collected resource usage. */
  resourceUsage(): BenchResourceUsage {
    const out: BenchResourceUsage = {
      peakRssMb: round1(this.peakRssMb),
      peakCpuPct: round1(this.peakCpuPct),
    };
    if (this.peakGpuPct !== undefined) out.peakGpuPct = round1(this.peakGpuPct);
    return out;
  }

  /** Set GPU peak from an external probe (e.g. Metal/Vulkan counters). */
  recordPeakGpuPct(pct: number): void {
    if (this.peakGpuPct === undefined || pct > this.peakGpuPct) {
      this.peakGpuPct = pct;
    }
  }

  /**
   * Compute the canonical metrics. Throws when required events are
   * missing — we'd rather fail loudly than report a phantom TTFA.
   */
  finalize(driverResult: BenchDriverResult): BenchMetrics {
    this.stopSampling();
    for (const name of REQUIRED_FOR_TTFA) {
      if (!this.firstByName.has(name)) {
        throw new Error(
          `[voice-bench] metrics: missing required event "${name}" for fixture "${this.fixtureId}" — pipeline driver did not emit it`,
        );
      }
    }
    const tSpeechStart = this.firstByName.get("speech-start") ?? 0;
    const tSpeechEnd = this.firstByName.get("speech-end") ?? 0;
    const tFirstAudio = this.firstByName.get("audio-out-first-frame") ?? 0;
    // Required events must arrive in canonical order:
    // speech-start ≤ speech-end ≤ audio-out-first-frame.
    if (tSpeechEnd < tSpeechStart) {
      throw new Error(
        `[voice-bench] metrics: out of order — speech-end (${round1(tSpeechEnd)}ms) arrived before speech-start (${round1(tSpeechStart)}ms) for fixture "${this.fixtureId}"`,
      );
    }
    if (tFirstAudio < tSpeechEnd) {
      throw new Error(
        `[voice-bench] metrics: out of order — audio-out-first-frame (${round1(tFirstAudio)}ms) preceded speech-end (${round1(tSpeechEnd)}ms) for fixture "${this.fixtureId}"`,
      );
    }
    const ttfaMs = round1(tFirstAudio - tSpeechStart);
    const speechEndToFirstAudioMs = round1(tFirstAudio - tSpeechEnd);

    // End-to-end: speech-start → tts-complete (last `audio-out` frame is
    // approximated by the latest observation, but the canonical signal
    // is `verifier-complete` followed by the final `tts-first-pcm` —
    // for now we use the latest audio-out timestamp.
    const lastAudio = this.lastByName.get("audio-out-first-frame") ?? tFirstAudio;
    const e2eLatencyMs = round1(lastAudio - tSpeechStart);

    // Sum any `tokens` payload on rollback-drop probes to estimate the
    // wasted-token count. Drivers that emit a single rollback-drop without
    // a payload contribute one rollback event but zero tokens; the
    // driver-supplied `rollbackWasteTokens` override is preferred when set.
    let rollbackTokensFromEvents = 0;
    for (const evt of this.events) {
      if (evt.name !== "rollback-drop") continue;
      const tokens = evt.data?.tokens;
      if (typeof tokens === "number" && Number.isFinite(tokens)) {
        rollbackTokensFromEvents += tokens;
      }
    }
    const rollbackWasteTokens = driverResult.rollbackWasteTokens ??
      rollbackTokensFromEvents;

    const result: BenchMetrics = {
      fixtureId: this.fixtureId,
      ttfaMs,
      e2eLatencyMs,
      speechEndToFirstAudioMs,
      falseBargeInCount: this.countOf("barge-in-trigger") -
        this.countOf("barge-in-hard-stop"),
      draftTokensTotal: driverResult.draftTokensTotal,
      draftTokensWasted: driverResult.draftTokensWasted,
      rollbackCount: this.countOf("rollback-drop"),
      rollbackWasteTokens,
      peakRssMb: this.resourceUsage().peakRssMb,
      peakCpuPct: this.resourceUsage().peakCpuPct,
    };
    const bargeInTrigger = this.firstByName.get("barge-in-trigger");
    const bargeInStop = this.firstByName.get("barge-in-hard-stop");
    if (bargeInTrigger !== undefined && bargeInStop !== undefined) {
      result.bargeInResponseMs = round1(bargeInStop - bargeInTrigger);
    }
    if (driverResult.dflashAccepted !== undefined) {
      result.dflashAccepted = driverResult.dflashAccepted;
    }
    if (driverResult.dflashDrafted !== undefined) {
      result.dflashDrafted = driverResult.dflashDrafted;
    }
    const peakGpu = this.resourceUsage().peakGpuPct;
    if (peakGpu !== undefined) result.peakGpuPct = peakGpu;
    // Negative numbers happen when the driver emits required events out
    // of order — that is a real bug, not something to silently clamp.
    if (ttfaMs < 0 || speechEndToFirstAudioMs < 0) {
      throw new Error(
        `[voice-bench] metrics: negative latency for fixture "${this.fixtureId}" (ttfa=${ttfaMs}, sE→a=${speechEndToFirstAudioMs}) — events arrived out of order`,
      );
    }
    return result;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Aggregate per-fixture metrics into the BenchRun summary. Standard p50 /
 * p95 computed via inclusive percentile (closest-rank).
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}
