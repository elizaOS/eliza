/**
 * Supervised child fixture for the crash/restart e2e (issue #10203). Run under
 * `bun`. It exercises the REAL `crash-injection` module so the e2e proves the
 * actual exit-code contract the supervisor (`run-node.mjs`) keys on:
 *   - `restart` mode  -> exit RESTART_EXIT_CODE (75)  -> supervisor respawns
 *   - `exit` mode     -> exit 1                       -> supervisor propagates
 *   - `throw` mode    -> uncaught -> non-zero exit    -> supervisor propagates
 *   - no fault armed  -> exit 0                        -> supervisor stops
 *
 * `CRASH_CHILD_RESTART_LIMIT` + `CRASH_CHILD_COUNTER` give a deterministic
 * "request restart N times, then succeed" child for the respawn-loop test
 * without relying on injection.
 */
import fs from "node:fs";
import process from "node:process";
import { maybeInjectFault } from "../../src/runtime/crash-injection.ts";

const counterFile = process.env.CRASH_CHILD_COUNTER;
const restartLimit = process.env.CRASH_CHILD_RESTART_LIMIT
  ? Number(process.env.CRASH_CHILD_RESTART_LIMIT)
  : undefined;

if (counterFile && restartLimit !== undefined) {
  let n = 0;
  try {
    n = Number(fs.readFileSync(counterFile, "utf8")) || 0;
  } catch {
    n = 0;
  }
  if (n < restartLimit) {
    fs.writeFileSync(counterFile, String(n + 1));
    process.exit(75); // RESTART_EXIT_CODE — ask the supervisor to respawn
  }
  process.exit(0); // done restarting — clean exit
}

const point = (process.env.CRASH_CHILD_POINT ?? "boot") as never;
const maybe = maybeInjectFault(point);
if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
  // hang mode: block forever (the e2e kills us by timeout)
  await maybe;
}
// Survived (no fault armed for this point) — clean exit.
process.exit(0);
