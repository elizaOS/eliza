/**
 * State machine over `shared_transfer_epochs` — the server-bound write fence
 * for Shared→Dedicated memory promotion (round 3, #21090 review).
 *
 * Transitions: (none|terminal) --open--> open --fence--> fenced
 *   fenced --promote--> promoted        (records the seal digest, terminal)
 *   open|fenced --abort--> aborted      (terminal)
 *
 * The single-active-epoch invariant is enforced by the partial unique index
 * `uq_shared_transfer_epochs_scope_active` (state IN open,fenced), so two
 * concurrent opens race at the database, not in this module. Every predicate
 * pins organization AND user, matching the tenant discipline of
 * `shared-agent-memories`.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type SharedTransferEpochRow,
  sharedTransferEpochs,
} from "../schemas/shared-transfer-epochs";
import type { SharedAgentMemoryScope } from "./shared-agent-memories";

export const SHARED_TRANSFER_EPOCH_CONFLICT = "SHARED_TRANSFER_EPOCH_CONFLICT";
export const SHARED_TRANSFER_EPOCH_NOT_FOUND = "SHARED_TRANSFER_EPOCH_NOT_FOUND";
export const SHARED_TRANSFER_EPOCH_INVALID_STATE = "SHARED_TRANSFER_EPOCH_INVALID_STATE";
/** Writes refused while the scope is fenced (memory-commit path). */
export const SHARED_TRANSFER_SCOPE_FENCED = "SHARED_TRANSFER_SCOPE_FENCED";

const ACTIVE_STATES = ["open", "fenced"] as const;

function scopePredicate(scope: SharedAgentMemoryScope) {
  return and(
    eq(sharedTransferEpochs.organization_id, scope.organizationId),
    eq(sharedTransferEpochs.user_id, scope.userId),
    eq(sharedTransferEpochs.agent_id, scope.agentId),
  );
}

/** The scope's single active (open|fenced) epoch row, if any. */
export async function getActiveEpoch(
  scope: SharedAgentMemoryScope,
): Promise<SharedTransferEpochRow | null> {
  const rows = await dbRead
    .select()
    .from(sharedTransferEpochs)
    .where(
      and(scopePredicate(scope), inArray(sharedTransferEpochs.state, [...ACTIVE_STATES])),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Open the next epoch for the scope. Epoch numbers are strictly increasing:
 * max(existing)+1. Fails with SHARED_TRANSFER_EPOCH_CONFLICT if an active
 * epoch already exists (unique-index race included).
 */
export async function openEpoch(
  scope: SharedAgentMemoryScope,
): Promise<SharedTransferEpochRow> {
  const existing = await dbRead
    .select({ epoch: sharedTransferEpochs.epoch })
    .from(sharedTransferEpochs)
    .where(scopePredicate(scope));
  const next = existing.reduce((m, r) => Math.max(m, r.epoch), 0) + 1;
  try {
    const inserted = await dbWrite
      .insert(sharedTransferEpochs)
      .values({
        organization_id: scope.organizationId,
        user_id: scope.userId,
        agent_id: scope.agentId,
        epoch: next,
        state: "open",
      })
      .returning();
    return inserted[0]!;
  } catch (error) {
    throw new ElizaError("An active transfer epoch already exists for this scope", {
      code: SHARED_TRANSFER_EPOCH_CONFLICT,
      cause: error,
    });
  }
}

async function transition(
  scope: SharedAgentMemoryScope,
  epoch: number,
  from: readonly string[],
  to: "fenced" | "promoted" | "aborted",
  patch: Partial<typeof sharedTransferEpochs.$inferInsert> = {},
): Promise<SharedTransferEpochRow> {
  const updated = await dbWrite
    .update(sharedTransferEpochs)
    .set({ state: to, ...patch })
    .where(
      and(
        scopePredicate(scope),
        eq(sharedTransferEpochs.epoch, epoch),
        inArray(sharedTransferEpochs.state, [...from]),
      ),
    )
    .returning();
  if (!updated[0]) {
    throw new ElizaError("Transfer epoch is not in a valid state for this transition", {
      code: SHARED_TRANSFER_EPOCH_INVALID_STATE,
      context: { epoch, expected: [...from], to },
    });
  }
  return updated[0];
}

/** open → fenced: from this moment scope writes are refused. */
export function fenceEpoch(scope: SharedAgentMemoryScope, epoch: number) {
  return transition(scope, epoch, ["open"], "fenced", { fenced_at: new Date() });
}

/** fenced → promoted: terminal; records the whole-export seal digest. */
export function promoteEpoch(
  scope: SharedAgentMemoryScope,
  epoch: number,
  sealDigest: string,
) {
  return transition(scope, epoch, ["fenced"], "promoted", {
    seal_digest: sealDigest,
    resolved_at: new Date(),
  });
}

/** open|fenced → aborted: terminal; lifts the fence without promotion. */
export function abortEpoch(scope: SharedAgentMemoryScope, epoch: number) {
  return transition(scope, epoch, [...ACTIVE_STATES], "aborted", {
    resolved_at: new Date(),
  });
}

/**
 * Write-fence check for the shared-runtime memory-commit path: throws
 * SHARED_TRANSFER_SCOPE_FENCED while the scope's active epoch is fenced.
 * One indexed point read on the scope-state index; open epochs do not block.
 */
export async function assertScopeWritable(
  scope: SharedAgentMemoryScope,
): Promise<void> {
  const active = await getActiveEpoch(scope);
  if (active?.state === "fenced") {
    throw new ElizaError("Memory writes are fenced during Shared→Dedicated promotion", {
      code: SHARED_TRANSFER_SCOPE_FENCED,
      context: { epoch: active.epoch },
    });
  }
}
