/** Reserves Dedicated runtime funds under lifecycle authority before provider work, and binds them to one exact container. */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { billingFundingReservations } from "../../db/schemas/billing-funding-reservations";
import { organizations } from "../../db/schemas/organizations";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { subscriptionFundingService } from "./subscription-funding";

const FUNDING_WINDOW_MS = 60 * 60 * 1_000;
export const AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED = "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED";
export const AGENT_COMPUTE_FUNDING_EXPIRED = "AGENT_COMPUTE_FUNDING_EXPIRED";

interface FundingAgentIdentity {
  agentId: string;
  organizationId: string;
  lifecycleRevision: number;
}

function reject(code: string, message: string, identity: FundingAgentIdentity): never {
  throw new ElizaError(message, { code, context: { ...identity }, severity: "fatal" });
}

async function lockProvisioningAgent(tx: DbTransaction, identity: FundingAgentIdentity) {
  const [agent] = await tx
    .select({
      id: agentSandboxes.id,
      lifecycle_revision: agentSandboxes.lifecycle_revision,
      status: agentSandboxes.status,
      execution_tier: agentSandboxes.execution_tier,
      pool_status: agentSandboxes.pool_status,
      deleted_at: agentSandboxes.deleted_at,
      deletion_attempt_id: agentSandboxes.deletion_attempt_id,
    })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.id, identity.agentId),
        eq(agentSandboxes.organization_id, identity.organizationId),
      ),
    )
    .for("update");
  if (
    !agent ||
    !Number.isSafeInteger(identity.lifecycleRevision) ||
    identity.lifecycleRevision < 0 ||
    agent.lifecycle_revision !== identity.lifecycleRevision ||
    agent.status !== "provisioning" ||
    agent.pool_status !== null ||
    agent.deleted_at !== null ||
    agent.deletion_attempt_id !== null ||
    !(CONTAINER_BACKED_EXECUTION_TIERS as readonly string[]).includes(agent.execution_tier)
  ) {
    reject(
      AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
      "Dedicated provisioning authority changed before funding",
      identity,
    );
  }
  const [organization] = await tx
    .select({
      is_active: organizations.is_active,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      paid_work_fenced_at: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, identity.organizationId))
    .for("update");
  if (
    !organization ||
    !organization.is_active ||
    organization.account_lifecycle_state !== "active" ||
    organization.account_deletion_request_id !== null ||
    organization.paid_work_fenced_at !== null
  ) {
    reject(
      AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
      "Organization cannot admit Dedicated compute",
      identity,
    );
  }
  return agent;
}

export class AgentComputeFundingService {
  /** The caller commits this reservation with provisioning admission, then invalidates credit caches if a cash debit occurred. */
  async reserveInTransaction(tx: DbTransaction, identity: FundingAgentIdentity) {
    await lockProvisioningAgent(tx, identity);
    const now = await readPostLockDatabaseNow(tx);
    const [existing] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.agent_id, identity.agentId),
          eq(agentComputeFunding.organization_id, identity.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    if (existing) {
      const [reservation] = await tx
        .select()
        .from(billingFundingReservations)
        .where(
          and(
            eq(billingFundingReservations.id, existing.funding_reservation_id),
            eq(billingFundingReservations.organization_id, identity.organizationId),
          ),
        );
      if (existing.period_end <= now || !reservation || reservation.status !== "reserved") {
        reject(
          AGENT_COMPUTE_FUNDING_EXPIRED,
          "Previous Dedicated funding must be reconciled before another provision",
          identity,
        );
      }
      return { window: existing, replayed: true, purchasedCreditDebited: false };
    }
    const id = crypto.randomUUID();
    const reserved = await subscriptionFundingService.reserveInTransaction(tx, {
      organizationId: identity.organizationId,
      logicalOperationId: `compute.${identity.agentId}.${id}`,
      operation: "managed_agent_compute",
      amount: AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6),
      description: "Dedicated runtime funding reservation",
      reservationTtlMs: FUNDING_WINDOW_MS,
      metadata: { agent_id: identity.agentId, compute_funding_id: id },
    });
    const fundedAt = await readPostLockDatabaseNow(tx);
    const periodEnd = new Date(
      Math.min(fundedAt.getTime() + FUNDING_WINDOW_MS, reserved.reservation.expires_at.getTime()),
    );
    if (periodEnd <= fundedAt) {
      reject(AGENT_COMPUTE_FUNDING_EXPIRED, "Dedicated funding expired before admission", identity);
    }
    const [window] = await tx
      .insert(agentComputeFunding)
      .values({
        id,
        organization_id: identity.organizationId,
        agent_id: identity.agentId,
        funding_reservation_id: reserved.reservation.id,
        period_start: fundedAt,
        period_end: periodEnd,
        hourly_rate: AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6),
      })
      .returning();
    if (!window)
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated funding reservation was not persisted",
        identity,
      );
    return { window, replayed: false, purchasedCreditDebited: reserved.purchasedCreditDebited };
  }

  /** Pins the paid interval to the immutable Docker id, never a reusable container name. */
  async bindProviderInTransaction(
    tx: DbTransaction,
    input: FundingAgentIdentity & {
      fundingId: string;
      nodeId: string;
      containerId: string;
    },
  ) {
    if (
      !/^[0-9a-f]{64}$/.test(input.containerId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.nodeId)
    ) {
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Invalid Dedicated provider identity", input);
    }
    await lockProvisioningAgent(tx, input);
    const [window] = await tx
      .select()
      .from(agentComputeFunding)
      .where(
        and(
          eq(agentComputeFunding.id, input.fundingId),
          eq(agentComputeFunding.agent_id, input.agentId),
          eq(agentComputeFunding.organization_id, input.organizationId),
          isNull(agentComputeFunding.settled_at),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (!window || window.period_end <= now) {
      reject(AGENT_COMPUTE_FUNDING_EXPIRED, "Dedicated provider has no current funding", input);
    }
    const [reservation] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.id, window.funding_reservation_id),
          eq(billingFundingReservations.organization_id, input.organizationId),
        ),
      );
    if (!reservation || reservation.status !== "reserved") {
      reject(
        AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
        "Dedicated funds are no longer reserved",
        input,
      );
    }
    if (window.provider_container_id !== null) {
      if (
        window.provider_container_id !== input.containerId ||
        window.provider_node_id !== input.nodeId
      ) {
        reject(
          AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
          "Dedicated funds belong to another provider instance",
          input,
        );
      }
      return window;
    }
    const [bound] = await tx
      .update(agentComputeFunding)
      .set({
        provider_node_id: input.nodeId,
        provider_container_id: input.containerId,
        provider_bound_at: now,
      })
      .where(eq(agentComputeFunding.id, window.id))
      .returning();
    if (!bound)
      reject(AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED, "Dedicated provider binding failed", input);
    return bound;
  }
}

export const agentComputeFundingService = new AgentComputeFundingService();
