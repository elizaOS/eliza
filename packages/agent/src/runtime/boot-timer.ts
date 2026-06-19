import { logger } from "@elizaos/core";

/** A single recorded boot phase with its elapsed and cumulative durations. */
export interface BootLap {
  /** Phase label passed to `lap()`. */
  name: string;
  /** Milliseconds elapsed since the previous lap. */
  ms: number;
  /** Milliseconds elapsed since the timer was constructed. */
  cumulativeMs: number;
}

/** Structured snapshot of a boot run, suitable for serialization. */
export interface BootSummary {
  /** Timer label, e.g. `[eliza-boot]`. */
  label: string;
  /** Total boot duration in milliseconds at the time of the snapshot. */
  totalMs: number;
  /** Epoch milliseconds when the timer was constructed. */
  startedAt: number;
  /** Laps in the order they were recorded. */
  laps: BootLap[];
}

/**
 * Lap-based boot phase timer. Each `lap(name)` logs the elapsed time since the
 * previous lap (and the cumulative time since construction), so dropping a few
 * one-line `lap()` calls between existing startup statements yields a per-phase
 * breakdown without restructuring the boot code into closures. `summary()`
 * prints the laps sorted slowest-first, which is what you read to find the
 * boot bottleneck. `getSummary()` returns the same data as a structured object
 * for persistence (see `recordBootTelemetry`).
 */
export class BootTimer {
  private readonly start = Date.now();
  private last = this.start;
  private readonly laps: BootLap[] = [];

  constructor(private readonly label = "[boot]") {}

  lap(name: string): void {
    const now = Date.now();
    const ms = now - this.last;
    this.last = now;
    const cumulativeMs = now - this.start;
    this.laps.push({ name, ms, cumulativeMs });
    logger.info(`${this.label} ${name}: ${ms}ms (t+${cumulativeMs}ms)`);
  }

  /** Structured snapshot of the boot run for telemetry/persistence. */
  getSummary(): BootSummary {
    return {
      label: this.label,
      totalMs: Date.now() - this.start,
      startedAt: this.start,
      laps: this.laps.map((lap) => ({ ...lap })),
    };
  }

  summary(): void {
    const { totalMs, laps } = this.getSummary();
    const slowest = [...laps].sort((a, b) => b.ms - a.ms);
    const lines = slowest.map(
      (p) => `    ${String(p.ms).padStart(7)}ms  ${p.name}`,
    );
    logger.info(
      `${this.label} boot phase summary (total ${totalMs}ms, slowest first):\n${lines.join("\n")}`,
    );
  }
}
