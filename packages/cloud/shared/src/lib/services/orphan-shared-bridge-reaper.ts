/**
 * Orphan-shared bridge reaper (#9939).
 *
 * The seamless cloud handoff gives a user instant **shared** chat while their
 * **dedicated** container provisions in the background, then silently swaps them
 * onto the dedicated agent and deletes the shared bridge. On a successful switch
 * the bridge delete cascades its `agent_sandboxes` row + `shared_runtime_history`
 * rows. But a timed-out/failed handoff (or a browser closed mid-swap, or a
 * fire-and-forget delete that itself failed) leaks the shared bridge row.
 *
 * The existing `orphan-container-reconciler` reaps stray *containers*; a shared
 * bridge has no container (it runs in-Worker), so those rows are invisible to
 * it. This reaper closes that gap: it finds shared-tier rows that have clearly
 * been superseded by a live dedicated twin and deletes them through the SAME
 * `deleteAgent` cascade the success path uses (one delete codepath).
 *
 * Safety: a deliberately long-lived shared agent has NO dedicated twin, so it is
 * never reaped. The decision requires (1) the bridge is well past the ~90s
 * handoff window, (2) a *running* dedicated sandbox with the SAME
 * (org, user, agent_name), (3) that twin was created at/after the bridge (the
 * handoff mints the bridge first, then `forceCreate`s the dedicated twin). The
 * orphan rule is a pure, exhaustively-tested function; the SQL reader is thin
 * production wiring around the same shape.
 */

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { logger } from "../utils/logger";
import { elizaSandboxService } from "./eliza-sandbox";

/** Floor age before a shared bridge is even a candidate — ~20× the ~90s handoff. */
const DEFAULT_MIN_AGE_MS = 30 * 60 * 1000;
/** Per-tick cap so a backlog drains gradually instead of a thundering herd. */
const DEFAULT_MAX = 50;

export interface SharedBridgeCandidate {
  id: string;
  organization_id: string;
  user_id: string;
  agent_name: string | null;
  created_at: Date;
}

export interface DedicatedTwin {
  organization_id: string;
  user_id: string;
  agent_name: string | null;
  created_at: Date;
}

/**
 * Pure orphan rule. Returns the ids of shared bridges that are safe to reap:
 * older than `minAgeMs` AND superseded by a live dedicated twin sharing their
 * (org, user, agent_name) that was created at/after the bridge. An unnamed
 * bridge (`agent_name === null`) cannot be correlated and is NEVER reaped.
 */
export function selectOrphanedSharedBridges(
  candidates: SharedBridgeCandidate[],
  twins: DedicatedTwin[],
  nowMs: number,
  minAgeMs: number,
): string[] {
  const orphans: string[] = [];
  for (const c of candidates) {
    // Still inside the handoff window — the user may be actively served by it.
    if (nowMs - c.created_at.getTime() < minAgeMs) continue;
    // No name to correlate a twin against — never reap (could be a real agent).
    if (!c.agent_name) continue;
    const supersededByLiveTwin = twins.some(
      (t) =>
        t.organization_id === c.organization_id &&
        t.user_id === c.user_id &&
        t.agent_name === c.agent_name &&
        // Twin minted AFTER the bridge (handoff order). `>=` tolerates a same-ms
        // create; a twin older than the bridge is a different, pre-existing agent.
        t.created_at.getTime() >= c.created_at.getTime(),
    );
    if (supersededByLiveTwin) orphans.push(c.id);
  }
  return orphans;
}

export interface ReapOrphanedSharedBridgesDeps {
  listCandidates: (cutoff: Date, limit: number) => Promise<SharedBridgeCandidate[]>;
  listTwins: (organizationIds: string[]) => Promise<DedicatedTwin[]>;
  deleteAgent: (agentId: string, orgId: string) => Promise<unknown>;
  now: () => number;
}

const defaultDeps: ReapOrphanedSharedBridgesDeps = {
  listCandidates: (cutoff, limit) =>
    agentSandboxesRepository.listSharedBridgeReapCandidates(cutoff, limit),
  listTwins: (organizationIds) => agentSandboxesRepository.listLiveDedicatedTwins(organizationIds),
  deleteAgent: (agentId, orgId) => elizaSandboxService.deleteAgent(agentId, orgId),
  now: () => Date.now(),
};

export interface ReapOrphanedSharedBridgesResult {
  scanned: number;
  reaped: number;
  reapFailed: number;
}

/**
 * Reap orphaned shared bridges via the same `deleteAgent` cascade the success
 * path uses. Best-effort per row: a failed delete is logged and counted, never
 * aborts the batch. Returns counts for the cron to log.
 */
export async function reapOrphanedSharedBridges(
  opts: { minAgeMs?: number; max?: number } = {},
  deps: ReapOrphanedSharedBridgesDeps = defaultDeps,
): Promise<ReapOrphanedSharedBridgesResult> {
  const minAgeMs = opts.minAgeMs && opts.minAgeMs > 0 ? opts.minAgeMs : DEFAULT_MIN_AGE_MS;
  const max = opts.max && opts.max > 0 ? Math.min(opts.max, DEFAULT_MAX) : DEFAULT_MAX;
  const nowMs = deps.now();
  const cutoff = new Date(nowMs - minAgeMs);

  const candidates = await deps.listCandidates(cutoff, max);
  if (candidates.length === 0) {
    return { scanned: 0, reaped: 0, reapFailed: 0 };
  }

  const orgIds = [...new Set(candidates.map((c) => c.organization_id))];
  const twins = await deps.listTwins(orgIds);
  const orphanIds = new Set(selectOrphanedSharedBridges(candidates, twins, nowMs, minAgeMs));

  let reaped = 0;
  let reapFailed = 0;
  for (const candidate of candidates) {
    if (!orphanIds.has(candidate.id)) continue;
    try {
      await deps.deleteAgent(candidate.id, candidate.organization_id);
      reaped += 1;
      logger.info("[orphan-shared-reaper] reaped orphaned shared bridge", {
        agentId: candidate.id,
        organizationId: candidate.organization_id,
      });
    } catch (error) {
      reapFailed += 1;
      logger.warn("[orphan-shared-reaper] failed to reap shared bridge", {
        agentId: candidate.id,
        organizationId: candidate.organization_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { scanned: candidates.length, reaped, reapFailed };
}
