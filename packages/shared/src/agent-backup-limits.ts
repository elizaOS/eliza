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
 * Only an ABSENT override defaults. A present-but-invalid value throws rather
 * than silently falling back: an operator who set the variable meant to change
 * the budget, so quietly running on the canonical limit would hide a
 * misconfiguration behind behavior that looks deliberate. `Number.parseInt` is
 * deliberately not used — it accepts malformed numeric prefixes (`"128MiB"` and
 * `"128abc"` both yield 128), which is exactly the silent-misread this guards.
 */
export function resolveRetainableAgentBackupBytes(
  rawOverride: string | undefined,
): number {
  if (rawOverride === undefined) return MAX_RESTORABLE_AGENT_BACKUP_BYTES;
  const trimmed = rawOverride.trim();
  if (trimmed === "") return MAX_RESTORABLE_AGENT_BACKUP_BYTES;

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid snapshot retain budget ${JSON.stringify(rawOverride)}: expected a positive integer count of bytes`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid snapshot retain budget ${JSON.stringify(rawOverride)}: expected a positive integer count of bytes`,
    );
  }
  return Math.min(parsed, MAX_RESTORABLE_AGENT_BACKUP_BYTES);
}
