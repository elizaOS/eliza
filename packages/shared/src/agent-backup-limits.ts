/**
 * Agent-backup size limits shared by everything that RETAINS or CONSUMES a v1
 * agent snapshot.
 *
 * A v1 snapshot is one JSON document on the wire. Retaining one that is larger
 * than what restore accepts produces a backup that authorizes a cutover and can
 * never be restored — the exact production-canary failure in #17172: Cloud
 * retained up to 256 MiB while `/api/restore`
 * (`packages/agent/src/api/server.ts`) and backup-chain reconstruction
 * (`packages/cloud/shared/src/db/repositories/agent-sandboxes.ts`) both cap at
 * 128 MiB, so a 128-256 MiB snapshot was a silent dead end.
 *
 * Every side imports THIS module so the numbers cannot drift apart again.
 */

/**
 * Canonical maximum RESTORABLE v1 wire size. A retained v1 backup above this is
 * unrestorable by construction, so it must never be retained in the first
 * place. Raising this alone is meaningless: it is bounded by what the smallest
 * consumer on the restore path accepts (`/api/restore`'s request-body cap and
 * the backup-chain reconstruction cap), so all of them move together or not at
 * all.
 */
export const MAX_RESTORABLE_AGENT_BACKUP_BYTES = 128 * 1024 * 1024;

/**
 * Resolve the snapshot RETAIN budget from an operator override, clamped so it
 * can never exceed {@link MAX_RESTORABLE_AGENT_BACKUP_BYTES}.
 *
 * The override exists to LOWER the budget (staging soak, a memory-constrained
 * worker). Allowing it to raise the budget past what restore accepts would
 * silently re-open the retain-vs-restore divergence through configuration
 * alone, which is why the clamp lives here next to the limit rather than at the
 * call site.
 *
 * A missing, non-numeric, or non-positive value yields the canonical limit.
 */
export function resolveRetainableAgentBackupBytes(
  rawOverride: string | undefined,
): number {
  const parsed = Number.parseInt(rawOverride ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return MAX_RESTORABLE_AGENT_BACKUP_BYTES;
  return Math.min(parsed, MAX_RESTORABLE_AGENT_BACKUP_BYTES);
}
