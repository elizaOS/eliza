/**
 * Minimal, dependency-free boot profiler. OFF by default (zero overhead unless
 * `ELIZA_BOOT_PROFILE=1`), so it is safe to leave in the production boot path.
 *
 * Laps are measured relative to the process spawn time the launcher injects via
 * `ELIZA_API_PROCESS_SPAWNED_AT_MS` (the desktop launcher and the loadperf
 * boot-kpi both set it), falling back to this module's own evaluation time. It
 * writes to stderr because the structured logger isn't initialized yet during
 * the earliest boot milestones.
 *
 * Usage: `bootLap("startEliza:before-api")` at the points you want to time, then
 * boot with `ELIZA_BOOT_PROFILE=1` and read the `[boot-profile]` lines.
 */
const SPAWN_AT =
  Number(process.env.ELIZA_API_PROCESS_SPAWNED_AT_MS) ||
  Number(process.env.ELIZA_PROCESS_SPAWNED_AT_MS) ||
  Date.now();

const ENABLED = process.env.ELIZA_BOOT_PROFILE === "1";

let lastLapAt = SPAWN_AT;

export function bootLap(label: string): void {
  if (!ENABLED) return;
  const now = Date.now();
  const sinceSpawn = now - SPAWN_AT;
  const sinceLast = now - lastLapAt;
  lastLapAt = now;
  process.stderr.write(
    `[boot-profile] ${label.padEnd(40)} +${sinceSpawn}ms (Δ${sinceLast}ms)\n`,
  );
}

export function bootProfileEnabled(): boolean {
  return ENABLED;
}
