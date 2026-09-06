import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  agentWallets,
  approvalQueue,
  encryptedChainKeys,
  encryptedKeys,
  type getDb,
  intents,
  pendingProxyRequests,
  policies,
  providerActionBindings,
  secretRoutes,
  transactions,
  upstreamCredentialLeaseEvents,
  upstreamCredentialLeases,
} from "../../../db/src/index.ts";
import { type AuditEventInput, withTenantAuditedTransaction } from "./audit";

// The lease owner scrubs these states only after confirmed provider revocation
// (`revoked`/`failed`) or provider expiry (`expired`). Unknown/lost-ack outcomes
// remain `needs_attention` or `revoking`; deletion never scrubs lease material.
const TERMINAL_LEASE_STATUSES = new Set(["revoked", "expired", "failed"]);

export type AgentDeletionResult =
  | "deleted"
  | "missing"
  | "blocked_by_upstream_lease"
  | "blocked_by_executing_proxy"
  | "blocked_by_unresolved_execution";

interface DeleteAgentAuthorityInput {
  tenantId: string;
  agentId: string;
  completionAudit: AuditEventInput;
  beforeDelete?: () => Promise<void>;
}

function leaseIsTerminalAndScrubbed(row: {
  status: string;
  tokenHash: string | null;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenAuthTag: string | null;
  tokenSalt: string | null;
}): boolean {
  return (
    TERMINAL_LEASE_STATUSES.has(row.status) &&
    row.tokenHash === null &&
    row.tokenCiphertext === null &&
    row.tokenIv === null &&
    row.tokenAuthTag === null &&
    row.tokenSalt === null
  );
}

function resultRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: T[] } | null)?.rows ?? [])
  ) as T[];
}

/**
 * Retire every local authority owned by an agent in one required-audit
 * transaction. Upstream provider credentials are deliberately not revoked or
 * relabeled here: deletion is refused until their independent lifecycle has
 * reached a terminal, secret-free state.
 */
export async function deleteAgentAuthority(
  input: DeleteAgentAuthorityInput,
): Promise<AgentDeletionResult> {
  const { tenantId, agentId } = input;
  return withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as ReturnType<typeof getDb>;
      // Every authority writer takes this tenant-scoped advisory fence before it
      // takes a parent-agent key-share lock. Deletion must use the same order:
      // taking the agent row first can deadlock with a writer that already owns
      // the advisory lock and is waiting to validate the agent parent.
      await tx.execute(
        sql`SELECT public.steward_lock_tenant_deletion(${tenantId})`,
      );
      const [lockedAgent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .for("update");
      if (!lockedAgent) return "missing";

      const [executingProxyRequest] = await tx
        .select({ id: pendingProxyRequests.id })
        .from(pendingProxyRequests)
        .where(
          and(
            eq(pendingProxyRequests.tenantId, tenantId),
            eq(pendingProxyRequests.agentId, agentId),
            eq(pendingProxyRequests.status, "executing"),
          ),
        )
        .limit(1)
        .for("update");
      if (executingProxyRequest) return "blocked_by_executing_proxy";

      const [unresolvedTransaction] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.agentId, agentId),
            inArray(transactions.status, [
              "signed",
              "broadcast",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const [unresolvedProviderAction] = await tx
        .select({ intentId: providerActionBindings.intentId })
        .from(providerActionBindings)
        .where(
          and(
            eq(providerActionBindings.tenantId, tenantId),
            eq(providerActionBindings.actorAgentId, agentId),
            inArray(providerActionBindings.status, [
              "allowed_stub",
              "execution_ready",
              "executing",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const [unresolvedIntentOnlyProviderAction] = await tx
        .select({ id: intents.id })
        .from(intents)
        .where(
          and(
            eq(intents.tenantId, tenantId),
            eq(intents.agentId, agentId),
            eq(intents.intentType, "provider-action"),
            inArray(intents.status, ["pending", "authorized", "executing"]),
            sql`NOT EXISTS (
            SELECT 1 FROM public.provider_action_bindings AS binding
            WHERE binding.tenant_id = ${intents.tenantId}
              AND binding.intent_id = ${intents.id}
          )`,
          ),
        )
        .limit(1)
        .for("update");
      if (
        unresolvedTransaction ||
        unresolvedProviderAction ||
        unresolvedIntentOnlyProviderAction
      ) {
        return "blocked_by_unresolved_execution";
      }

      const leases = await tx
        .select({
          id: upstreamCredentialLeases.id,
          status: upstreamCredentialLeases.status,
          tokenHash: upstreamCredentialLeases.tokenHash,
          tokenCiphertext: upstreamCredentialLeases.tokenCiphertext,
          tokenIv: upstreamCredentialLeases.tokenIv,
          tokenAuthTag: upstreamCredentialLeases.tokenAuthTag,
          tokenSalt: upstreamCredentialLeases.tokenSalt,
        })
        .from(upstreamCredentialLeases)
        .where(
          and(
            eq(upstreamCredentialLeases.tenantId, tenantId),
            eq(upstreamCredentialLeases.agentId, agentId),
          ),
        )
        .for("update");
      if (leases.some((lease) => !leaseIsTerminalAndScrubbed(lease))) {
        return "blocked_by_upstream_lease";
      }

      if (leases.length > 0) {
        await tx.insert(upstreamCredentialLeaseEvents).values(
          leases.map((lease) => ({
            leaseId: lease.id,
            tenantId,
            action: "lease.agent_authority_deleted",
            decision: "deny",
            metadata: { terminalStatus: lease.status },
          })),
        );
      }

      // The capability plugin is optional, but its tables can remain after the
      // plugin is disabled. Revoke any surviving grant inside the same agent-row
      // lock used by plugin migration 0002's writer fence. This prevents an old
      // active grant from surviving deletion or becoming live again if an agent
      // identifier is later reused.
      const capabilityTable = resultRows<{ relation: string | null }>(
        await tx.execute(
          sql`SELECT to_regclass('public.capability_grants')::text AS relation`,
        ),
      )[0]?.relation;
      if (capabilityTable) {
        await tx.execute(sql`
        UPDATE public.capability_grants
        SET status = 'revoked'
        WHERE tenant_id = ${tenantId}
          AND agent_id = ${agentId}
          AND status = 'active'
      `);
      }

      await input.beforeDelete?.();

      // Provider bindings and legacy/recovery intent-only rows are durable
      // evidence. Live intent-only rows are rejected above; detach every
      // remaining provider intent before the agent FK cascade.
      await tx
        .update(intents)
        .set({ agentId: null })
        .where(
          and(
            eq(intents.tenantId, tenantId),
            eq(intents.agentId, agentId),
            eq(intents.intentType, "provider-action"),
          ),
        );

      await tx
        .update(secretRoutes)
        .set({ enabled: false })
        .where(
          and(
            eq(secretRoutes.tenantId, tenantId),
            eq(secretRoutes.agentId, agentId),
            eq(secretRoutes.enabled, true),
          ),
        );
      const terminalizedAt = new Date();
      await tx
        .update(pendingProxyRequests)
        .set({
          status: "denied",
          deniedAt: terminalizedAt,
          deniedBy: "system:agent-delete",
          denialReason: "agent authority deleted",
          updatedAt: terminalizedAt,
        })
        .where(
          and(
            eq(pendingProxyRequests.tenantId, tenantId),
            eq(pendingProxyRequests.agentId, agentId),
            inArray(pendingProxyRequests.status, ["pending", "approved"]),
          ),
        );
      await tx.delete(approvalQueue).where(eq(approvalQueue.agentId, agentId));
      await tx.delete(transactions).where(eq(transactions.agentId, agentId));
      await tx.delete(policies).where(eq(policies.agentId, agentId));
      await tx
        .delete(encryptedChainKeys)
        .where(eq(encryptedChainKeys.agentId, agentId));
      await tx.delete(encryptedKeys).where(eq(encryptedKeys.agentId, agentId));
      await tx.delete(agentWallets).where(eq(agentWallets.agentId, agentId));
      const removedAgents = await tx
        .delete(agents)
        .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
        .returning({ id: agents.id });
      if (removedAgents.length !== 1)
        throw new Error("Agent changed concurrently");
      await appendRequiredAudit(input.completionAudit);
      return "deleted";
    },
  );
}
