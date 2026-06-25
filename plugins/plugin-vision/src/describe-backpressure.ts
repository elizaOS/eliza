// DescribeBackpressureController — the owner of the "run the expensive VLM
// describe this tick?" decision for VisionService's continuous loops
// (#9105 milestone 8 / #9581). The DirtyTileDescriber / full-frame
// `IMAGE_DESCRIPTION` call is the dominant token + RAM cost of the loop; the
// cheap OCR/YOLO/dHash steps keep running while describing is paused. Two
// independent pause signals:
//
//   1. **Arbiter memory-pressure** — the external WS1 signal cascaded from
//      `@elizaos/plugin-local-inference`'s MemoryArbiter (`memory_pressure`
//      events). The WS1 bridge only delivers *pressure* events, never the
//      recovery (`nominal`) edge, so a pressure signal pauses describing for a
//      cooldown window and auto-resumes after that window of silence. A direct
//      arbiter that does report `nominal` clears the pause immediately.
//   2. **Local RSS GROWTH over a captured baseline** — a self-contained
//      low-RAM guard (`MAX_MEMORY_USAGE_MB`) so the loop throttles even when no
//      arbiter is registered (standalone / on-device), the common case for a
//      local agent on a memory-constrained machine. The cap measures
//      *vision-attributable growth* over the RSS baseline captured on the first
//      describe tick — NOT absolute process RSS. A local agent mmaps multi-GB
//      GGUF text + vision models, so its steady-state RSS routinely exceeds any
//      reasonable MB cap; comparing absolute RSS to the cap would pause
//      describing forever. Measuring growth over the loop's starting footprint
//      means a large-but-steady baseline never trips the guard, while a genuine
//      runaway still does. This signal is always-on and self-recovering:
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
  /** How long the describe has been continuously paused, in ms (0 if active). */
  continuousPauseMs: number;
}

export interface DescribeBackpressureDecision {
  /** Run the expensive describe this tick? */
  describe: boolean;
  /** `"paused"`/`"active"` when this call flipped the state, else `null`. */
  transitionedTo: "paused" | "active" | null;
  /** Why we are paused (only meaningful when `describe === false`). */
  reason: DescribePauseReason;
  /** How long the describe has been continuously paused, in ms (0 if active). */
  continuousPauseMs: number;
  /**
   * True on the tick the caller should emit an escalation `warn` — set once the
   * continuous pause first crosses `warnAfterMs` and again every `warnRepeatMs`
   * thereafter while it persists, so a stuck loop is observable (#9693).
   */
  escalate: boolean;
}

export interface DescribeBackpressureConfig {
  /**
   * Vision-attributable RSS GROWTH cap in bytes — the describe step pauses
   * while `sampledRss - baseline` exceeds it, where `baseline` is the RSS
   * captured on the first `evaluate()` tick (after the local model is already
   * mmapped). Comparing GROWTH (not absolute RSS) is what stops the loop from
   * pausing forever on a device whose steady-state RSS already exceeds any
   * reasonable MB cap — see #9693. `0` or negative disables the local check —
   * only the arbiter signal can pause describing.
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
  /**
   * Escalate from edge-only logging to a repeated warning once the describe has
   * been paused continuously for this long, so a permanently-stuck loop becomes
   * observable instead of silent (#9693). Default 60_000. `0`/negative disables.
   */
  warnAfterMs?: number;
  /**
   * Minimum gap between escalation warnings while a continuous pause persists,
   * in ms. Default 60_000.
   */
  warnRepeatMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_ARBITER_PAUSE_COOLDOWN_MS = 15_000;
const DEFAULT_WARN_AFTER_MS = 60_000;
const DEFAULT_WARN_REPEAT_MS = 60_000;

export class DescribeBackpressureController {
  private readonly memoryCapBytes: number;
  private readonly sampleRssBytes: () => number;
  private readonly arbiterPauseCooldownMs: number;
  private readonly warnAfterMs: number;
  private readonly warnRepeatMs: number;
  private readonly now: () => number;
  private pressureLevel: MemoryPressureLevel = "nominal";
  private pauseUntilMs = 0;
  private paused = false;
  private describesSkipped = 0;
  private pauseTransitions = 0;
  /** RSS captured on the first evaluate() tick; the growth cap is measured against it. */
  private rssBaseline = 0;
  private rssBaselineCaptured = false;
  /** `now()` when the current continuous pause began (0 while active). */
  private pausedSinceMs = 0;
  /** `now()` of the last escalation warn emitted for the current pause (0 if none). */
  private lastWarnMs = 0;

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
    this.warnAfterMs =
      typeof config.warnAfterMs === "number" && config.warnAfterMs > 0
        ? config.warnAfterMs
        : DEFAULT_WARN_AFTER_MS;
    this.warnRepeatMs =
      typeof config.warnRepeatMs === "number" && config.warnRepeatMs > 0
        ? config.warnRepeatMs
        : DEFAULT_WARN_REPEAT_MS;
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
    const nowMs = this.now();
    // Capture the RSS baseline on the first tick — by now the local model is
    // mmapped, so the cap measures only the vision loop's own growth on top of
    // a large-but-steady footprint instead of tripping on absolute RSS forever.
    if (!this.rssBaselineCaptured) {
      this.rssBaseline = this.sampleRssBytes();
      this.rssBaselineCaptured = true;
    }

    const arbiterPaused = nowMs < this.pauseUntilMs;
    const overCap =
      this.memoryCapBytes > 0 &&
      this.sampleRssBytes() - this.rssBaseline > this.memoryCapBytes;
    const paused = arbiterPaused || overCap;

    let transitionedTo: "paused" | "active" | null = null;
    if (paused !== this.paused) {
      transitionedTo = paused ? "paused" : "active";
      this.paused = paused;
      this.pauseTransitions += 1;
      this.pausedSinceMs = paused ? nowMs : 0;
      this.lastWarnMs = 0;
    }
    if (paused) this.describesSkipped += 1;

    const continuousPauseMs = paused ? nowMs - this.pausedSinceMs : 0;
    // Escalate to a repeated warn once a pause persists past warnAfterMs, so a
    // permanently-stuck describe loop is observable rather than silent (#9693).
    let escalate = false;
    if (
      paused &&
      this.warnAfterMs > 0 &&
      continuousPauseMs >= this.warnAfterMs &&
      nowMs - this.lastWarnMs >= this.warnRepeatMs
    ) {
      escalate = true;
      this.lastWarnMs = nowMs;
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
      continuousPauseMs,
      escalate,
    };
  }

  stats(): DescribeBackpressureStats {
    return {
      paused: this.paused,
      pressureLevel: this.pressureLevel,
      describesSkipped: this.describesSkipped,
      pauseTransitions: this.pauseTransitions,
      continuousPauseMs: this.paused ? this.now() - this.pausedSinceMs : 0,
    };
  }
}
