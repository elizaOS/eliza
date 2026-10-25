/** Validates canonical deletion phase leases for dispatched-command recovery and terminal cancellation of unstarted purchaser intent. This server-only authority never grants a new purchase or provider mutation. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { accountDeletionPhaseReceipts } from "../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import type { BillingSubscriptionCommand } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface AppBillingDeletionRecoveryAuthority {
  kind: "account_deletion";
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  phaseGeneration: number;
}

export type AppBillingCommandActor =
  | { actorUserId: string; deletionAuthority?: never }
  | { actorUserId?: never; deletionAuthority: AppBillingDeletionRecoveryAuthority };

async function requireAppBillingDeletionCommand(
  tx: DbTransaction,
  authority: AppBillingDeletionRecoveryAuthority,
  command: BillingSubscriptionCommand,
  purpose: "recovery" | "supersession",
) {
  const [request] = await tx
    .select({
      userId: accountDeletionRequests.user_id,
      organizationId: accountDeletionRequests.organization_id,
      digest: accountDeletionRequests.request_digest,
      revision: accountDeletionRequests.lifecycle_revision,
      irreversibleAt: accountDeletionRequests.irreversible_at,
      status: accountDeletionRequests.status,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, authority.requestId))
    .for("share");
  const [phase] = await tx
    .select({
      phase: accountDeletionPhaseReceipts.phase,
      generation: accountDeletionPhaseReceipts.lease_generation,
      expiresAt: accountDeletionPhaseReceipts.lease_expires_at,
      status: accountDeletionPhaseReceipts.status,
    })
    .from(accountDeletionPhaseReceipts)
    .where(
      and(
        eq(accountDeletionPhaseReceipts.id, authority.phaseReceiptId),
        eq(accountDeletionPhaseReceipts.request_id, authority.requestId),
      ),
    )
    .for("share");
  const now = await readPostLockDatabaseNow(tx);
  if (
    authority.kind !== "account_deletion" ||
    !request ||
    !phase ||
    request.status !== "processing" ||
    request.irreversibleAt === null ||
    request.digest !== authority.requestDigest ||
    request.revision !== authority.lifecycleRevision ||
    phase.phase !== "stripe" ||
    phase.generation !== authority.phaseGeneration ||
    phase.expiresAt === null ||
    !Number.isFinite(phase.expiresAt.getTime()) ||
    phase.expiresAt <= now ||
    !["leased", "calling", "reconciling"].includes(phase.status) ||
    command.request_payload?.domain !== "buyer" ||
    (purpose === "recovery"
      ? (request.userId !== command.requested_by_user_id &&
          request.organizationId !== command.organization_id) ||
        command.provider_started_at === null ||
        !["OUTCOME_UNKNOWN", "SUCCEEDED", "APPLIED", "FAILED"].includes(command.status)
      : request.userId !== command.requested_by_user_id ||
        command.status !== "PREPARED" ||
        command.execution_generation !== 0 ||
        command.provider_started_at !== null ||
        command.provider_response_digest !== null ||
        command.provider_result !== null)
  )
    throw new ElizaError(
      purpose === "recovery"
        ? "Billing recovery requires the current irreversible deletion phase and an original dispatched command"
        : "Billing supersession requires the current irreversible deletion phase and an original unstarted purchaser command",
      {
        code: "APP_BILLING_DELETION_AUTHORITY_INVALID",
        context: {
          purpose,
          requestId: authority.requestId,
          commandId: command.id,
          requestStatus: request?.status,
          lifecycleMatches: request?.revision === authority.lifecycleRevision,
          phaseStatus: phase?.status,
          phaseGenerationMatches: phase?.generation === authority.phaseGeneration,
          leaseCurrent:
            phase?.expiresAt !== null && phase?.expiresAt !== undefined && phase.expiresAt > now,
          subjectMatches:
            request?.userId === command.requested_by_user_id ||
            (purpose === "recovery" && request?.organizationId === command.organization_id),
          commandStatus: command.status,
        },
      },
    );
  return request;
}

export async function requireAppBillingDeletionRecovery(
  tx: DbTransaction,
  authority: AppBillingDeletionRecoveryAuthority,
  command: BillingSubscriptionCommand,
): Promise<void> {
  await requireAppBillingDeletionCommand(tx, authority, command, "recovery");
}

/** Requires original purchaser ownership; developer ownership alone cannot cancel another buyer's prepared intent. Caller holds owner, scope, user and command locks before acquiring the request/phase locks here. */
export async function requireAppBillingPreparedDeletionSupersession(
  tx: DbTransaction,
  authority: AppBillingDeletionRecoveryAuthority,
  command: BillingSubscriptionCommand,
) {
  return requireAppBillingDeletionCommand(tx, authority, command, "supersession");
}
