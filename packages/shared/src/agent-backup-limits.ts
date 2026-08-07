/**
 * Defines the common wire-size ceiling for v1 agent snapshots.
 * Retain, push, reconstruction, and restore consumers share this contract so
 * no stored backup can exceed the smallest restore boundary (#17172).
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

/**
 * A restore payload larger than what the restore path accepts, refused locally
 * instead of being sent to be rejected (#17172).
 *
 * It lives beside the limits themselves because BOTH sides that enforce them
 * throw it — the service before pushing state, and backup-chain reconstruction
 * while walking the chain — and a service-owned class would make the repository
 * import its own consumer.
 *
 * Typed because the classification matters in both directions: retrying is
 * pointless (the same bytes exceed the same limit every time), but the stored
 * chain is intact and still decryptable, so this must never read as permanently
 * lost and must never prune the chain.
 */
export class SnapshotPayloadTooLargeError extends Error {
  readonly name = "SnapshotPayloadTooLargeError";
  constructor(
    readonly payloadBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `State restore refused: reconstructed payload of ${payloadBytes} bytes exceeds the v1 restorable limit of ${limitBytes} bytes`,
    );
  }
}
