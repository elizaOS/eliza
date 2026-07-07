/**
 * Process-wide registry of deferred boot phases, so readiness consumers can
 * distinguish "the runtime is ready" from "every deferred capability has
 * registered". Feature routes, connectors, and non-essential plugins load
 * AFTER `/api/health` flips `ready:true` (the agent deferred wave, and — with
 * app routes deferred by default — app-core's post-ready boot tail), so a
 * feature route can 404 for a short window right after ready. Producers mark
 * their phase `pending` synchronously before the readiness gate flips and
 * `complete`/`failed` when their wave settles; `GET /api/health` exposes the
 * aggregate as `deferredBoot`, which is what tests and scripts should poll
 * instead of sleeping.
 *
 * Producers: `runDeferredBoot` in `./eliza.ts` (phase `agent-deferred-boot`)
 * and app-core's `repairRuntimeAfterBoot` (phase `app-route-tail`, imported
 * via the `@elizaos/agent/runtime/*` subpath export). A restart re-marks its
 * phases `pending` before the new readiness gate flips, so a stale `complete`
 * from the previous boot never reads as the new boot being settled.
 */

export type DeferredBootPhaseStatus = "pending" | "complete" | "failed";

export interface DeferredBootStatus {
  /** Per-phase status keyed by phase name. */
  readonly phases: Readonly<Record<string, DeferredBootPhaseStatus>>;
  /**
   * True when no phase is `pending` — every deferred wave that announced
   * itself has settled (successfully or not). Consumers waiting for feature
   * routes should poll this, then treat any `failed` phase as an error state
   * rather than waiting longer.
   */
  readonly settled: boolean;
}

const phases = new Map<string, DeferredBootPhaseStatus>();

export function markDeferredBootPhase(
  phase: string,
  status: DeferredBootPhaseStatus,
): void {
  phases.set(phase, status);
}

export function getDeferredBootStatus(): DeferredBootStatus {
  const snapshot: Record<string, DeferredBootPhaseStatus> = {};
  let settled = true;
  for (const [name, status] of phases) {
    snapshot[name] = status;
    if (status === "pending") settled = false;
  }
  return { phases: snapshot, settled };
}

/** Test-only: clear all recorded phases. */
export function _resetDeferredBootStatusForTest(): void {
  phases.clear();
}
