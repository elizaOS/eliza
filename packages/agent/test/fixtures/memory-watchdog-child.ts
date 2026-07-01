/**
 * Supervised child fixture for the memory-watchdog crash/restart e2e (#10197).
 * Run under `bun`. It wires the REAL memory watchdog to the REAL
 * `requestRestart` seam through the same restart handler production registers
 * (`app-core/src/cli/run-main.ts` → exit `RESTART_EXIT_CODE`), then drives real
 * RSS pressure so the e2e proves the whole chain end to end:
 *
 *   startMemoryWatchdog() → real `process.memoryUsage().rss` sample ≥ threshold
 *   for the sustained window → `requestRestart()` → registered handler →
 *   `process.exit(RESTART_EXIT_CODE=75)` → supervisor respawns.
 *
 * Env knobs (set by the e2e):
 *   - `ELIZA_MEMORY_WATCHDOG*`        the real watchdog config (opt-in + thresholds)
 *   - `CRASH_CHILD_ALLOC_MB`          MB of touched heap to hold (default 0 = no forced pressure)
 *   - `CRASH_CHILD_WATCHDOG_TIMEOUT_MS` safety timeout; exit non-75 if the watchdog
 *                                      never fires so the e2e fails loud instead of hanging
 */
import process from "node:process";

import { RESTART_EXIT_CODE, setRestartHandler } from "@elizaos/shared";
import { startMemoryWatchdog } from "../../src/runtime/memory-watchdog.ts";

// Mirror the production restart handler (app-core/src/cli/run-main.ts): a
// restart request exits with RESTART_EXIT_CODE so the supervisor relaunches.
// This is the seam the watchdog depends on — the e2e proves it fires for real.
setRestartHandler((reason) => {
  console.error(
    `memory-watchdog-child: restart requested: ${reason ?? "unspecified"} — exiting ${RESTART_EXIT_CODE}`,
  );
  process.exit(RESTART_EXIT_CODE);
});

// Hold real, page-touched memory so `process.memoryUsage().rss` actually climbs
// (untouched Buffer.alloc pages may not be resident). A strong global ref keeps
// it off the GC's reach until the process exits.
const allocMb = Number(process.env.CRASH_CHILD_ALLOC_MB ?? "0");
if (allocMb > 0) {
  const blocks: Buffer[] = [];
  for (let i = 0; i < allocMb; i++) {
    const block = Buffer.alloc(1024 * 1024);
    block.fill((i % 255) + 1); // touch every page so it becomes resident
    blocks.push(block);
  }
  (globalThis as Record<string, unknown>).__eliza_watchdog_hold = blocks;
}

const started = startMemoryWatchdog();
if (!started) {
  // Watchdog disabled (no ELIZA_MEMORY_WATCHDOG): prove it does NOT restart even
  // under memory pressure by exiting cleanly.
  process.exit(0);
}

// The watchdog interval is unref()'d, so keep the event loop alive with a ref'd
// guard timer. The watchdog should call requestRestart → exit(75) before it
// fires; if it doesn't, exit non-75 so the e2e fails instead of hanging.
const timeoutMs = Number(process.env.CRASH_CHILD_WATCHDOG_TIMEOUT_MS ?? "8000");
const guard = setTimeout(() => {
  console.error(
    "memory-watchdog-child: watchdog did not request restart within the window",
  );
  process.exit(2);
}, timeoutMs);
guard.ref?.();
