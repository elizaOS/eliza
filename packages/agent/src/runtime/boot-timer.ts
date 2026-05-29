import { logger } from "@elizaos/core";

/**
 * Lap-based boot phase timer. Each `lap(name)` logs the elapsed time since the
 * previous lap (and the cumulative time since construction), so dropping a few
 * one-line `lap()` calls between existing startup statements yields a per-phase
 * breakdown without restructuring the boot code into closures. `summary()`
 * prints the laps sorted slowest-first, which is what you read to find the
 * boot bottleneck.
 */
export class BootTimer {
  private readonly start = Date.now();
  private last = this.start;
  private readonly laps: Array<{ name: string; ms: number }> = [];

  constructor(private readonly label = "[boot]") {}

  lap(name: string): void {
    const now = Date.now();
    const ms = now - this.last;
    this.last = now;
    this.laps.push({ name, ms });
    logger.info(`${this.label} ${name}: ${ms}ms (t+${now - this.start}ms)`);
  }

  summary(): void {
    const total = Date.now() - this.start;
    const slowest = [...this.laps].sort((a, b) => b.ms - a.ms);
    const lines = slowest.map(
      (p) => `    ${String(p.ms).padStart(7)}ms  ${p.name}`,
    );
    logger.info(
      `${this.label} boot phase summary (total ${total}ms, slowest first):\n${lines.join("\n")}`,
    );
  }
}
