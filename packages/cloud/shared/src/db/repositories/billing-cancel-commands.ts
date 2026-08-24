/** Transaction-scoped access to durable billable-resource cancellation receipts. */

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  type AgentComputeStopIntent,
  agentComputeStopIntents,
} from "../schemas/agent-compute-stop-intents";
import {
  type BillingCancelCommand,
  type BillingCancelCommandKey,
  type BillingCancelResourceType,
  billingCancelCommandKeys,
  billingCancelCommands,
} from "../schemas/billing-cancel-commands";
import {
  type ContainerComputeStopIntent,
  containerComputeStopIntents,
} from "../schemas/compute-stop-intents";
import { type Job, jobs } from "../schemas/jobs";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export interface BillingCancelCommandBundle {
  command: BillingCancelCommand;
  job: Job;
  containerIntent: ContainerComputeStopIntent | null;
  agentIntent: AgentComputeStopIntent | null;
}

export interface BillingCancelCommandKeyBundle extends BillingCancelCommandBundle {
  key: BillingCancelCommandKey;
}

export interface BillingCancelLogicalIdentity {
  organizationId: string;
  resourceType: BillingCancelResourceType;
  resourceId: string;
  expectedLifecycleRevision: number;
  action: "stop";
}

async function loadBundleByCommandId(
  tx: DbTransaction,
  organizationId: string,
  commandId: string,
): Promise<BillingCancelCommandBundle | null> {
  const [row] = await tx
    .select({
      command: billingCancelCommands,
      job: jobs,
      containerIntent: containerComputeStopIntents,
      agentIntent: agentComputeStopIntents,
    })
    .from(billingCancelCommands)
    .innerJoin(
      jobs,
      and(
        eq(jobs.id, billingCancelCommands.job_id),
        eq(jobs.organization_id, billingCancelCommands.organization_id),
      ),
    )
    .leftJoin(
      containerComputeStopIntents,
      and(
        eq(billingCancelCommands.resource_type, "container"),
        eq(containerComputeStopIntents.organization_id, billingCancelCommands.organization_id),
        eq(containerComputeStopIntents.container_id, billingCancelCommands.resource_id),
        eq(
          containerComputeStopIntents.lifecycle_revision,
          billingCancelCommands.expected_lifecycle_revision,
        ),
        eq(containerComputeStopIntents.job_id, billingCancelCommands.job_id),
        eq(containerComputeStopIntents.authorization, "user_request"),
      ),
    )
    .leftJoin(
      agentComputeStopIntents,
      and(
        eq(billingCancelCommands.resource_type, "agent_sandbox"),
        eq(agentComputeStopIntents.organization_id, billingCancelCommands.organization_id),
        eq(agentComputeStopIntents.agent_id, billingCancelCommands.resource_id),
        eq(
          agentComputeStopIntents.lifecycle_revision,
          billingCancelCommands.expected_lifecycle_revision,
        ),
        eq(agentComputeStopIntents.job_id, billingCancelCommands.job_id),
        eq(agentComputeStopIntents.authorization, "user_request"),
      ),
    )
    .where(
      and(
        eq(billingCancelCommands.id, commandId),
        eq(billingCancelCommands.organization_id, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const billingCancelCommandsRepository = {
  /**
   * Acquire the primary authority rows in one deterministic order before a
   * cancellation transaction creates any durable effect. PostgreSQL
   * re-evaluates a FOR SHARE predicate after a conflicting UPDATE commits, so
   * a concurrent deactivation, role revocation, or steward identity rebinding
   * cannot slip through a stale session snapshot. The retained row locks then
   * fence later authority changes until this transaction commits or rolls back.
   */
  async lockBillingManagerAuthority(
    tx: DbTransaction,
    organizationId: string,
    userId: string,
    expectedStewardUserId: string,
  ): Promise<boolean> {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), eq(organizations.is_active, true)))
      .for("share")
      .limit(1);
    if (!organization) return false;

    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.organization_id, organizationId),
          eq(users.steward_user_id, expectedStewardUserId),
          inArray(users.role, ["owner", "admin"]),
          eq(users.is_active, true),
          eq(users.is_anonymous, false),
          isNull(users.deleted_at),
          or(isNull(users.expires_at), gt(users.expires_at, sql`CURRENT_TIMESTAMP`)),
        ),
      )
      .for("share")
      .limit(1);
    return Boolean(user);
  },

  async findByKeyHash(
    tx: DbTransaction,
    organizationId: string,
    keyHash: string,
  ): Promise<BillingCancelCommandKeyBundle | null> {
    const [row] = await tx
      .select({
        key: billingCancelCommandKeys,
        command: billingCancelCommands,
        job: jobs,
        containerIntent: containerComputeStopIntents,
        agentIntent: agentComputeStopIntents,
      })
      .from(billingCancelCommandKeys)
      .innerJoin(
        billingCancelCommands,
        and(
          eq(billingCancelCommands.id, billingCancelCommandKeys.command_id),
          eq(billingCancelCommands.organization_id, billingCancelCommandKeys.organization_id),
        ),
      )
      .innerJoin(
        jobs,
        and(
          eq(jobs.id, billingCancelCommands.job_id),
          eq(jobs.organization_id, billingCancelCommands.organization_id),
        ),
      )
      .leftJoin(
        containerComputeStopIntents,
        and(
          eq(billingCancelCommands.resource_type, "container"),
          eq(containerComputeStopIntents.organization_id, billingCancelCommands.organization_id),
          eq(containerComputeStopIntents.container_id, billingCancelCommands.resource_id),
          eq(
            containerComputeStopIntents.lifecycle_revision,
            billingCancelCommands.expected_lifecycle_revision,
          ),
          eq(containerComputeStopIntents.job_id, billingCancelCommands.job_id),
          eq(containerComputeStopIntents.authorization, "user_request"),
        ),
      )
      .leftJoin(
        agentComputeStopIntents,
        and(
          eq(billingCancelCommands.resource_type, "agent_sandbox"),
          eq(agentComputeStopIntents.organization_id, billingCancelCommands.organization_id),
          eq(agentComputeStopIntents.agent_id, billingCancelCommands.resource_id),
          eq(
            agentComputeStopIntents.lifecycle_revision,
            billingCancelCommands.expected_lifecycle_revision,
          ),
          eq(agentComputeStopIntents.job_id, billingCancelCommands.job_id),
          eq(agentComputeStopIntents.authorization, "user_request"),
        ),
      )
      .where(
        and(
          eq(billingCancelCommandKeys.organization_id, organizationId),
          eq(billingCancelCommandKeys.idempotency_key_hash, keyHash),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findLogical(
    tx: DbTransaction,
    identity: BillingCancelLogicalIdentity,
  ): Promise<BillingCancelCommandBundle | null> {
    const [row] = await tx
      .select({
        command: billingCancelCommands,
        job: jobs,
        containerIntent: containerComputeStopIntents,
        agentIntent: agentComputeStopIntents,
      })
      .from(billingCancelCommands)
      .innerJoin(
        jobs,
        and(
          eq(jobs.id, billingCancelCommands.job_id),
          eq(jobs.organization_id, billingCancelCommands.organization_id),
        ),
      )
      .leftJoin(
        containerComputeStopIntents,
        and(
          eq(billingCancelCommands.resource_type, "container"),
          eq(containerComputeStopIntents.organization_id, billingCancelCommands.organization_id),
          eq(containerComputeStopIntents.container_id, billingCancelCommands.resource_id),
          eq(
            containerComputeStopIntents.lifecycle_revision,
            billingCancelCommands.expected_lifecycle_revision,
          ),
          eq(containerComputeStopIntents.job_id, billingCancelCommands.job_id),
          eq(containerComputeStopIntents.authorization, "user_request"),
        ),
      )
      .leftJoin(
        agentComputeStopIntents,
        and(
          eq(billingCancelCommands.resource_type, "agent_sandbox"),
          eq(agentComputeStopIntents.organization_id, billingCancelCommands.organization_id),
          eq(agentComputeStopIntents.agent_id, billingCancelCommands.resource_id),
          eq(
            agentComputeStopIntents.lifecycle_revision,
            billingCancelCommands.expected_lifecycle_revision,
          ),
          eq(agentComputeStopIntents.job_id, billingCancelCommands.job_id),
          eq(agentComputeStopIntents.authorization, "user_request"),
        ),
      )
      .where(
        and(
          eq(billingCancelCommands.organization_id, identity.organizationId),
          eq(billingCancelCommands.resource_type, identity.resourceType),
          eq(billingCancelCommands.resource_id, identity.resourceId),
          eq(billingCancelCommands.expected_lifecycle_revision, identity.expectedLifecycleRevision),
          eq(billingCancelCommands.action, identity.action),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async createCommand(
    tx: DbTransaction,
    input: BillingCancelLogicalIdentity & { requestedByUserId: string; jobId: string },
  ): Promise<{ bundle: BillingCancelCommandBundle; inserted: boolean }> {
    const [inserted] = await tx
      .insert(billingCancelCommands)
      .values({
        organization_id: input.organizationId,
        requested_by_user_id: input.requestedByUserId,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        expected_lifecycle_revision: input.expectedLifecycleRevision,
        action: input.action,
        job_id: input.jobId,
      })
      .onConflictDoNothing()
      .returning();
    const bundle = inserted
      ? await loadBundleByCommandId(tx, input.organizationId, inserted.id)
      : await this.findLogical(tx, input);
    if (!bundle) {
      throw new Error("Billing cancellation command conflict winner could not be loaded");
    }
    return { bundle, inserted: Boolean(inserted) };
  },

  async bindKey(
    tx: DbTransaction,
    input: {
      organizationId: string;
      keyHash: string;
      requestDigest: string;
      commandId: string;
      requestedByUserId: string;
    },
  ): Promise<{ key: BillingCancelCommandKey; inserted: boolean }> {
    const [inserted] = await tx
      .insert(billingCancelCommandKeys)
      .values({
        organization_id: input.organizationId,
        idempotency_key_hash: input.keyHash,
        request_digest: input.requestDigest,
        command_id: input.commandId,
        requested_by_user_id: input.requestedByUserId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { key: inserted, inserted: true };
    const replay = await this.findByKeyHash(tx, input.organizationId, input.keyHash);
    if (!replay) {
      throw new Error("Billing cancellation idempotency winner could not be loaded");
    }
    return { key: replay.key, inserted: false };
  },
};
