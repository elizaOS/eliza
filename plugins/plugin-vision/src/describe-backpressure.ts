/**
 * Backpressure controller for deciding whether VisionService should run the
 * expensive IMAGE_DESCRIPTION step on a continuous-loop tick.
 *
 * DirtyTileDescriber and full-frame VLM calls dominate token and RAM cost, while
 * OCR, YOLO, and dHash steps can keep running during a describe pause. Pauses
 * come from either external memory-pressure events or local RSS growth measured
 * over the loop's first-describe baseline, so large-but-steady model RSS does
 * not permanently suppress describing.
 *
 * External WS1 pressure events pause for a cooldown because that bridge may not
 * deliver the nominal recovery edge; direct arbiters that report nominal clear
 * the pause immediately.
 */
//      describing resumes the moment RSS drops back within `baseline + cap`.
//
// While paused the describe step is skipped (backpressure) and the skip is
// counted so the token telemetry can prove the saving. Pause/resume edges are
// returned as transitions so the caller emits a single structured log line per
// edge instead of once per tick.
//
// The controller is intentionally pure (no logger, no timers; injectable RSS
// sampler + clock) so it is unit-testable in isolation — VisionService owns the
// wiring and the logging.

export type MemoryPressureLevel = "nominal" | "low" | "critical";

export type DescribePauseReason = "arbiter-pressure" | "memory-cap" | null;

export interface DescribeBackpressureStats {
  /** True while the describe step is currently being skipped. */
  paused: boolean;
  /** Last arbiter pressure level applied via `setPressure`. */
  pressureLevel: MemoryPressureLevel;
  /** Describe ticks skipped because of backpressure since construction. */
  describesSkipped: number;
  /** Count of paused<->active edges (telemetry / test signal). */
  pauseTransitions: number;
  /** RSS captured on the first describe tick, used as the local cap baseline. */
  memoryBaselineBytes: number | null;
  /** Latest sampled RSS growth over the captured baseline. */
  memoryGrowthBytes: number | null;
}

export interface DescribeBackpressureDecision {
  /** Run the expensive describe this tick? */
  describe: boolean;
  /** `"paused"`/`"active"` when this call flipped the state, else `null`. */
  transitionedTo: "paused" | "active" | null;
  /** Why we are paused (only meaningful when `describe === false`). */
  reason: DescribePauseReason;
  /** How long the current continuous pause has lasted, in ms. */
  pausedForMs: number;
  /** True when the caller should emit a throttled long-pause warning. */
  warnPaused: boolean;
}

export interface DescribeBackpressureConfig {
  /**
   * RSS growth cap in bytes. The first describe tick captures the process RSS
   * baseline; while sampled RSS exceeds `baseline + memoryCapBytes`, the
   * describe step pauses. `0` or negative disables the local check — only the
   * arbiter signal can pause describing.
   */
  memoryCapBytes?: number;
  /**
   * RSS sampler; defaults to `process.memoryUsage().rss`. Injected by tests so
   * the cap can be exercised deterministically without allocating memory.
   */
  sampleRssBytes?: () => number;
  /**
   * How long a single arbiter pressure signal keeps the loop paused, in ms.
   * Because the WS1 bridge delivers pressure but not recovery, the pause
   * auto-clears after this window of silence. Default 15_000.
   */
  arbiterPauseCooldownMs?: number;
  /** Continuous pause duration before a warning is requested. Default 60s. */
  pauseWarningThresholdMs?: number;
  /** Minimum interval between repeated long-pause warnings. Default 60s. */
  pauseWarningIntervalMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_ARBITER_PAUSE_COOLDOWN_MS = 15_000;
const DEFAULT_PAUSE_WARNING_THRESHOLD_MS = 60_000;
const DEFAULT_PAUSE_WARNING_INTERVAL_MS = 60_000;

export class DescribeBackpressureController {
  private readonly memoryCapBytes: number;
  private readonly sampleRssBytes: () => number;
  private readonly arbiterPauseCooldownMs: number;
  private readonly pauseWarningThresholdMs: number;
  private readonly pauseWarningIntervalMs: number;
  private readonly now: () => number;
  private pressureLevel: MemoryPressureLevel = "nominal";
  private pauseUntilMs = 0;
  private paused = false;
  private describesSkipped = 0;
  private pauseTransitions = 0;
  private memoryBaselineBytes: number | null = null;
  private latestMemoryGrowthBytes: number | null = null;
  private pauseStartedAtMs: number | null = null;
  private lastPauseWarningAtMs = 0;

  constructor(config: DescribeBackpressureConfig = {}) {
    this.memoryCapBytes =
      typeof config.memoryCapBytes === "number" && config.memoryCapBytes > 0
        ? config.memoryCapBytes
        : 0;
    this.sampleRssBytes =
      config.sampleRssBytes ?? (() => process.memoryUsage().rss);
    this.arbiterPauseCooldownMs =
      typeof config.arbiterPauseCooldownMs === "number" &&
      config.arbiterPauseCooldownMs > 0
        ? config.arbiterPauseCooldownMs
        : DEFAULT_ARBITER_PAUSE_COOLDOWN_MS;
    this.pauseWarningThresholdMs =
      typeof config.pauseWarningThresholdMs === "number" &&
      config.pauseWarningThresholdMs > 0
        ? config.pauseWarningThresholdMs
        : DEFAULT_PAUSE_WARNING_THRESHOLD_MS;
    this.pauseWarningIntervalMs =
      typeof config.pauseWarningIntervalMs === "number" &&
      config.pauseWarningIntervalMs > 0
        ? config.pauseWarningIntervalMs
        : DEFAULT_PAUSE_WARNING_INTERVAL_MS;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Apply an arbiter memory-pressure level. A non-nominal level opens (or
   * extends) the cooldown pause window; `nominal` clears it immediately (only
   * arbiters that actually report recovery do this — the WS1 bridge relies on
   * the cooldown instead).
   */
  setPressure(level: MemoryPressureLevel): void {
    this.pressureLevel = level;
    if (level === "nominal") {
      this.pauseUntilMs = 0;
    } else {
      this.pauseUntilMs = this.now() + this.arbiterPauseCooldownMs;
    }
  }

  /**
   * Decide whether the expensive describe step may run this tick. Call ONLY
   * when a describe would otherwise happen (the change/time gate already
   * passed), so the skip counter reflects real avoided work. Has side effects:
   * updates the skip counter and the pause/resume transition state. The
   * arbiter signal takes precedence over the local cap when both are active so
   * the reported `reason` is the more authoritative one.
   */
  evaluate(): DescribeBackpressureDecision {
    const now = this.now();
    const arbiterPaused = now < this.pauseUntilMs;
    const sampledRssBytes =
      this.memoryCapBytes > 0 ? this.sampleRssBytes() : null;
    if (sampledRssBytes !== null && this.memoryBaselineBytes === null) {
      this.memoryBaselineBytes = sampledRssBytes;
    }
    this.latestMemoryGrowthBytes =
      sampledRssBytes !== null && this.memoryBaselineBytes !== null
        ? Math.max(0, sampledRssBytes - this.memoryBaselineBytes)
        : null;
    const overCap =
      this.memoryCapBytes > 0 &&
      sampledRssBytes !== null &&
      this.memoryBaselineBytes !== null &&
      sampledRssBytes > this.memoryBaselineBytes + this.memoryCapBytes;
    const paused = arbiterPaused || overCap;

    let transitionedTo: "paused" | "active" | null = null;
    if (paused !== this.paused) {
      transitionedTo = paused ? "paused" : "active";
      this.paused = paused;
      this.pauseTransitions += 1;
      this.pauseStartedAtMs = paused ? now : null;
      this.lastPauseWarningAtMs = 0;
    }
    let pausedForMs = 0;
    let warnPaused = false;
    if (paused) {
      this.describesSkipped += 1;
      if (this.pauseStartedAtMs !== null) {
        pausedForMs = Math.max(0, now - this.pauseStartedAtMs);
        if (
          pausedForMs >= this.pauseWarningThresholdMs &&
          (this.lastPauseWarningAtMs === 0 ||
            now - this.lastPauseWarningAtMs >= this.pauseWarningIntervalMs)
        ) {
          warnPaused = true;
          this.lastPauseWarningAtMs = now;
        }
      }
    }

    const reason: DescribePauseReason = !paused
      ? null
      : arbiterPaused
        ? "arbiter-pressure"
        : "memory-cap";

    return {
      describe: !paused,
      transitionedTo,
      reason,
      pausedForMs,
      warnPaused,
    };
  }

  stats(): DescribeBackpressureStats {
    return {
      paused: this.paused,
      pressureLevel: this.pressureLevel,
      describesSkipped: this.describesSkipped,
      pauseTransitions: this.pauseTransitions,
      memoryBaselineBytes: this.memoryBaselineBytes,
      memoryGrowthBytes: this.latestMemoryGrowthBytes,
    };
  }
}
