/**
 * Reversible, entitlement-driven fallback from a personal Dedicated agent to
 * Personal Shared (#25146), with the most conservative withdrawal policy.
 *
 * Dedicated access is withdrawn ONLY when all of these hold on the primary:
 * - the Dedicated runtime is `stopped` by a provider-confirmed
 *   `billing_request` stop that is still its latest lifecycle decision
 *   (a later user stop, deletion or newer job keeps Dedicated authority);
 * - the organization is not funded now (the canonical credit gate denies).
 * Low credit on a running agent, provisioning, sleeping by choice, errors,
 * provider outages and unknown billing state never withdraw access: callers
 * keep the existing honest Dedicated unavailability.
 *
 * While withdrawn, Shared answers in a new, separately scoped journal
 * (`journal_room_id`) keyed by a monotonic generation. The canonical
 * Dedicated/pre-upgrade room is never reopened, so Shared has no access to
 * Dedicated conversation history. When Dedicated is running again the active
 * interval is closed before routing returns to Dedicated.
 */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { findConfirmedBillingSuspension } from "../../db/repositories/agent-billing-resume";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import {
  type PersonalDedicatedFallback,
  personalDedicatedFallbacks,
} from "../../db/schemas/personal-dedicated-fallbacks";
import { logger } from "../utils/logger";
import { checkAgentCreditGate } from "./agent-billing-gate";

/** Typed, minimal account state for the Shared fallback turn. No payment details. */
export interface PersonalSharedFallbackAccountState {
  access: "shared_fallback";
  reason: "billing_suspended";
  /** Dedicated memory stays unavailable until billing is restored. */
  dedicatedMemory: "unavailable";
  generation: number;
  /** Signed-in billing surface; checkout alone never restores access. */
  recoveryAction: { kind: "billing"; path: "/cloud/billing" };
}

export interface PersonalSharedFallbackDelivery {
  fallback: PersonalDedicatedFallback;
  /** Separately scoped Shared journal for this interval only. */
  journalRoomId: string;
  accountState: PersonalSharedFallbackAccountState;
}

/** A target already resolved for this exact account by the personal route authority. */
type DedicatedTarget = Pick<AgentSandbox, "id" | "status">;

export type PersonalDedicatedAccessDecision =
  | { access: "dedicated" }
  | { access: "withdrawn"; reason: "billing_suspended"; stopIntentId: string };

/** Decide Dedicated access with the conservative policy described above. */
export async function resolvePersonalDedicatedAccess(
  dedicated: DedicatedTarget,
  organizationId: string,
): Promise<PersonalDedicatedAccessDecision> {
  if (dedicated.status !== "stopped") return { access: "dedicated" };
  // Tenant-scoped: the suspension must belong to this organization's agent.
  const suspension = await findConfirmedBillingSuspension({
    agentId: dedicated.id,
    organizationId,
  });
  if (!suspension) return { access: "dedicated" };
  // Funding already returned: automatic resume restores Dedicated, so the
  // caller keeps honest Dedicated unavailability instead of splitting history.
  const funding = await checkAgentCreditGate(organizationId);
  if (funding.allowed) return { access: "dedicated" };
  return { access: "withdrawn", reason: "billing_suspended", stopIntentId: suspension.intentId };
}

function accountState(fallback: PersonalDedicatedFallback): PersonalSharedFallbackAccountState {
  return {
    access: "shared_fallback",
    reason: "billing_suspended",
    dedicatedMemory: "unavailable",
    generation: fallback.generation,
    recoveryAction: { kind: "billing", path: "/cloud/billing" },
  };
}

function lockAccount(organizationId: string, userId: string, sourceAgentId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`personal-dedicated-fallback:${organizationId}:${userId}:${sourceAgentId}`}, 0))`;
}

/**
 * Idempotently activates (or returns) the account's Shared fallback interval.
 * One active interval per account; a repeated withdrawal after recovery gets
 * a new generation and a new journal, never an earlier suspended interval.
 */
export async function activatePersonalSharedFallback(input: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  dedicatedAgentId: string;
  stopIntentId: string;
}): Promise<PersonalDedicatedFallback> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(lockAccount(input.organizationId, input.userId, input.sourceAgentId));
    const scope = and(
      eq(personalDedicatedFallbacks.organization_id, input.organizationId),
      eq(personalDedicatedFallbacks.user_id, input.userId),
      eq(personalDedicatedFallbacks.source_agent_id, input.sourceAgentId),
    );
    const [active] = await tx
      .select()
      .from(personalDedicatedFallbacks)
      .where(and(scope, eq(personalDedicatedFallbacks.state, "shared_active")))
      .for("update")
      .limit(1);
    if (active) {
      if (active.dedicated_agent_id !== input.dedicatedAgentId) {
        throw new ElizaError("Personal fallback belongs to a different Dedicated agent", {
          code: "PERSONAL_DEDICATED_FALLBACK_CONFLICT",
          context: { organizationId: input.organizationId, fallbackId: active.id },
        });
      }
      return active;
    }
    const [latest] = await tx
      .select({ generation: personalDedicatedFallbacks.generation })
      .from(personalDedicatedFallbacks)
      .where(scope)
      .orderBy(desc(personalDedicatedFallbacks.generation))
      .limit(1);
    const [created] = await tx
      .insert(personalDedicatedFallbacks)
      .values({
        organization_id: input.organizationId,
        user_id: input.userId,
        source_agent_id: input.sourceAgentId,
        dedicated_agent_id: input.dedicatedAgentId,
        generation: (latest?.generation ?? 0) + 1,
        state: "shared_active",
        reason: "billing_suspended",
        stop_intent_id: input.stopIntentId,
        journal_room_id: `fallback:${randomUUID()}`,
      })
      .returning();
    logger.warn(
      "[personal-dedicated-fallback] Dedicated access withdrawn; Shared fallback active",
      {
        organizationId: input.organizationId,
        dedicatedAgentId: input.dedicatedAgentId,
        generation: created.generation,
      },
    );
    return created;
  });
}

/**
 * Closes the active interval once Dedicated is running again, fenced by the
 * exact generation. Returns the recovered interval, or null when none was open.
 * The Shared interval stays addressable by its journal for reconciliation.
 */
export async function recoverPersonalSharedFallback(input: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  dedicatedAgentId: string;
}): Promise<PersonalDedicatedFallback | null> {
  // Hot path: most Dedicated turns have no open interval. The locked update
  // below remains the only writer and re-checks the exact active row.
  const [open] = await dbWrite
    .select({ id: personalDedicatedFallbacks.id })
    .from(personalDedicatedFallbacks)
    .where(
      and(
        eq(personalDedicatedFallbacks.organization_id, input.organizationId),
        eq(personalDedicatedFallbacks.user_id, input.userId),
        eq(personalDedicatedFallbacks.source_agent_id, input.sourceAgentId),
        eq(personalDedicatedFallbacks.state, "shared_active"),
      ),
    )
    .limit(1);
  if (!open) return null;
  return dbWrite.transaction(async (tx) => {
    await tx.execute(lockAccount(input.organizationId, input.userId, input.sourceAgentId));
    const now = new Date();
    const [recovered] = await tx
      .update(personalDedicatedFallbacks)
      .set({ state: "recovered", recovered_at: now, updated_at: now })
      .where(
        and(
          eq(personalDedicatedFallbacks.organization_id, input.organizationId),
          eq(personalDedicatedFallbacks.user_id, input.userId),
          eq(personalDedicatedFallbacks.source_agent_id, input.sourceAgentId),
          eq(personalDedicatedFallbacks.dedicated_agent_id, input.dedicatedAgentId),
          eq(personalDedicatedFallbacks.state, "shared_active"),
        ),
      )
      .returning();
    if (recovered) {
      logger.info("[personal-dedicated-fallback] Dedicated access restored; fallback closed", {
        organizationId: input.organizationId,
        dedicatedAgentId: input.dedicatedAgentId,
        generation: recovered.generation,
      });
    }
    return recovered ?? null;
  });
}

/**
 * The single authority decision both personal consumers use when a Dedicated
 * target is not ready: returns the Shared fallback delivery when (and only
 * when) access is withdrawn, otherwise null so the caller keeps its existing
 * Dedicated unavailability response.
 */
export async function preparePersonalSharedFallback(input: {
  dedicated: DedicatedTarget;
  organizationId: string;
  userId: string;
  sourceAgentId: string;
}): Promise<PersonalSharedFallbackDelivery | null> {
  const decision = await resolvePersonalDedicatedAccess(input.dedicated, input.organizationId);
  if (decision.access !== "withdrawn") return null;
  const fallback = await activatePersonalSharedFallback({
    organizationId: input.organizationId,
    userId: input.userId,
    sourceAgentId: input.sourceAgentId,
    dedicatedAgentId: input.dedicated.id,
    stopIntentId: decision.stopIntentId,
  });
  return {
    fallback,
    journalRoomId: fallback.journal_room_id,
    accountState: accountState(fallback),
  };
}
