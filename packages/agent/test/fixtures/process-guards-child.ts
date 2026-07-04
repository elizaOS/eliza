/**
 * Supervised child fixture for the process-crash-guards e2e (#10203). Run under
 * `bun`. It installs the REAL `installProcessCrashGuards` from `@elizaos/shared`
 * on a real process and then triggers a REAL fault, so the e2e proves the actual
 * `process.on("uncaughtException" | "unhandledRejection")` wiring — not a mocked
 * listener called by hand (which is all the `packages/shared` unit test can do,
 * since attaching real guards would crash the test runner).
 *
 * Env knobs (set by the e2e):
 *   - `PG_POLICY`  restart | exit | keep-alive   (onUncaughtException policy)
 *   - `PG_FAULT`   uncaught | rejection          (which real fault to trigger)
 *
 * Expected exit codes:
 *   uncaught + restart    → RESTART_EXIT_CODE (75)  (supervisor would respawn)
 *   uncaught + exit       → 1                        (supervisor would propagate)
 *   uncaught + keep-alive → 0                        (agent survives, degraded)
 *   rejection (any policy)→ 0                        (background rejection non-fatal)
 */
import process from "node:process";

import { installProcessCrashGuards } from "@elizaos/shared";

const policy = (process.env.PG_POLICY ?? "restart") as
  | "restart"
  | "exit"
  | "keep-alive";
const fault = process.env.PG_FAULT ?? "uncaught";

installProcessCrashGuards({
  onUncaughtException: policy,
  // Silence the guard's own logging so the child's stdio stays quiet.
  log: () => {},
  warn: () => {},
});

// A ref'd survival timer: for keep-alive / rejection the guards do NOT exit, so
// the child proves it stayed alive by exiting 0 here. For restart/exit the
// installed handler exits (75 / 1) before this fires.
const survive = setTimeout(() => process.exit(0), 600);
survive.ref?.();

if (fault === "rejection") {
  // A real unhandled promise rejection must be caught by the guard and left
  // non-fatal — the process must NOT die from it.
  Promise.reject(
    new Error("process-guards-child: injected background rejection"),
  );
} else {
  // Throw asynchronously so it escapes as a genuine `uncaughtException` the
  // installed handler processes. A synchronous throw at module top level would
  // instead fail the module load before the guard could act.
  setTimeout(() => {
    throw new Error("process-guards-child: injected uncaught exception");
  }, 10);
}
