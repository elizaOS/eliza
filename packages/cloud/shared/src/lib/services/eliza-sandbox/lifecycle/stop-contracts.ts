/** Defines bounded provider teardown outcomes and the deadline required for absence verification. */
import { type SandboxDeletionStopOutcome } from "../../sandbox-provider-types";

/**
 * Outcome of the bounded container teardown attempted during `deleteAgent`:
 * `null` = stop succeeded; `{ error }` = stop failed within the cap (classified
 * downstream as ignorable vs real); `{ error, timedOut }` = the teardown hit the
 * hard cap and was abandoned (see `runBoundedSandboxStop`).
 */
export type BoundedSandboxStopResult =
  | null
  | { error: unknown }
  | { error: unknown; timedOut: true };

export type BoundedDeletionSandboxStopResult =
  | SandboxDeletionStopOutcome
  | { kind: "stop-failed"; error: unknown }
  | { kind: "stop-timed-out"; error: unknown };

// Hard cap on the container+VPN teardown during agent delete. The ordinary
// path remains much shorter, but opted-in daemon recovery can consume the
// bounded absence probe, stop, force-remove, daemon restart, exact removal,
// and Headscale cleanup in sequence. Each fresh isolated SSH session also owns
// a bounded 10-second handshake before its command timer begins, so the full
// worst-case chain is about 177 seconds before scheduling/DB overhead. The
// former 120- and 180-second races expired before that chain could settle,
// persisted a false unresolved tombstone, and left the recovery promise
// running without an owner. 240 seconds leaves bounded settlement headroom
// while remaining below the provisioning worker's 300-second watchdog.
export const SANDBOX_DELETE_STOP_TIMEOUT_MS = 240_000;
