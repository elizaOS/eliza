/**
 * Selects organization-scoped billable compute resources and coordinates
 * their ledger and cancellation operations. Snapshot callers may supply an
 * open read transaction so resource identity and canonical rate segments share
 * one primary-database observation boundary.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { type Database, dbRead, dbWrite } from "../../db/client";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import { containerComputeStopIntents } from "../../db/schemas/compute-stop-intents";
import { containers, TERMINAL_CONTAINER_STATUS } from "../../db/schemas/containers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { jobs } from "../../db/schemas/jobs";
import type { AppEnv } from "../../types/cloud-worker-env";
import { ApiError } from "../api/cloud-worker-errors";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { calculateDailyContainerCost } from "../constants/pricing";
import { logger } from "../utils/logger";
import {
  parseActiveBillingNonNegativeNumber,
  parseActiveBillingNumber,
} from "./active-billing-numeric";
import {
  billingResourceCancellationsService,
  type RequestBillingCancellationOptions,
} from "./billing-resource-cancellations";
import { retireContainerWithDeleteJob } from "./container-retirement";
import { enqueueContainerUserStopOnce } from "./container-stop-job-service";
import { provisioningJobService } from "./provisioning-jobs";

export type BillableResourceType = "container" | "agent_sandbox";
export type BillableInterval = "day" | "hour";

export interface ActiveBillableResource {
  resourceType: BillableResourceType;
  resourceId: string;
  name: string;
  status: string;
  billingStatus: string;
  /** Compare-and-set generation required by the version-2 durable stop contract. */
  lifecycleRevision: number;
  unitPrice: number;
  billingInterval: BillableInterval;
  lastBilledAt: string | null;
  nextBillingAt: string | null;
  estimatedNextBillingAt: string | null;
  totalBilled: number;
  cancelEndpoint: string;
  cancelAction: "stop" | "stop_compute";
  metadata: Record<string, unknown>;
}

export interface InfrastructureCancellationAction {
  attempted: boolean;
  status: "not_needed" | "queued" | "stopped" | "deleted" | "failed";
  message: string;
  error?: string;
}

export interface BillingLedgerEntry {
  id: string;
  amount: number;
  type: string;
  description: string | null;
  createdAt: string;
  source: string;
  resourceType: BillableResourceType | "credits" | "usage" | "unknown";
  resourceId: string | null;
  metadata: Record<string, unknown>;
}

export interface CancelBillableResourceOptions {
  organizationId: string;
  resourceId: string;
  resourceType?: BillableResourceType;
  mode?: "stop" | "delete";
  triggerEnv?: AppEnv["Bindings"];
  authorizeInfrastructureMutation: () => Promise<void>;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function cancelEndpoint(resource: BillableResourceType, id: string): string {
  return `/api/v1/billing/resources/${id}/cancel?resourceType=${resource}`;
}

function compatibilityCancellationRevision(
  status: string,
  currentLifecycleRevision: number,
  latestProviderConfirmedRevision: number | null,
): number {
  if (
    status === "stopped" &&
    latestProviderConfirmedRevision !== null &&
    (latestProviderConfirmedRevision === currentLifecycleRevision ||
      latestProviderConfirmedRevision === currentLifecycleRevision - 1)
  ) {
    return latestProviderConfirmedRevision;
  }
  return currentLifecycleRevision;
}

/** Canonical authority for user-owned compute that this billing surface may mutate. */
function activeBillingAgentAuthorityPredicate() {
  return and(
    inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
    isNull(agentSandboxes.deletion_attempt_id),
  );
}

/** Selects compute that can still exist at the provider, including deletion attempts. */
function billableAgentAuthorityPredicate() {
  return and(
    inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
    isNull(agentSandboxes.pool_status),
    isNull(agentSandboxes.deleted_at),
  );
}

function detectLedgerResource(metadata: Record<string, unknown>): {
  resourceType: BillingLedgerEntry["resourceType"];
  resourceId: string | null;
  source: string;
} {
  if (typeof metadata.container_id === "string") {
    return {
      resourceType: "container",
      resourceId: metadata.container_id,
      source: typeof metadata.billing_type === "string" ? metadata.billing_type : "container",
    };
  }
  if (typeof metadata.sandbox_id === "string") {
    return {
      resourceType: "agent_sandbox",
      resourceId: metadata.sandbox_id,
      source: typeof metadata.billing_type === "string" ? metadata.billing_type : "agent_sandbox",
    };
  }
  if (typeof metadata.billing_type === "string") {
    return { resourceType: "usage", resourceId: null, source: metadata.billing_type };
  }
  if (typeof metadata.payment_method === "string") {
    return { resourceType: "credits", resourceId: null, source: metadata.payment_method };
  }
  return { resourceType: "unknown", resourceId: null, source: "unknown" };
}

class ActiveBillingService {
  async listActiveResources(
    organizationId: string,
    /**
     * Optional coherent read handle. The billing snapshot passes its open
     * REPEATABLE READ transaction so this canonical selector is consumed
     * without re-querying the primary outside the snapshot boundary.
     */
    database: Pick<Database, "select"> = dbRead,
  ): Promise<ActiveBillableResource[]> {
    const [containerRows, agentRows] = await Promise.all([
      database
        .select()
        .from(containers)
        .where(
          and(
            eq(containers.organization_id, organizationId),
            inArray(containers.status, ["running", "deleting"]),
            inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
          ),
        ),
      database
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, organizationId),
            billableAgentAuthorityPredicate(),
            inArray(agentSandboxes.billing_status, ["active", "warning", "shutdown_pending"]),
            or(
              eq(agentSandboxes.status, "running"),
              and(
                inArray(agentSandboxes.status, ["deletion_pending", "deletion_failed"]),
                or(
                  isNull(agentSandboxes.deletion_previous_status),
                  ne(agentSandboxes.deletion_previous_status, "stopped"),
                  isNotNull(agentSandboxes.last_backup_at),
                ),
              ),
              and(eq(agentSandboxes.status, "stopped"), isNotNull(agentSandboxes.last_backup_at)),
            ),
          ),
        ),
    ]);

    const containerResources = containerRows.map((container): ActiveBillableResource => {
      const unitPrice = calculateDailyContainerCost({
        desiredCount: container.desired_count,
        cpu: container.cpu,
        memory: container.memory,
      });
      const estimatedNext =
        container.next_billing_at ??
        (container.last_billed_at ? addMs(container.last_billed_at, 24 * 60 * 60 * 1000) : null);

      return {
        resourceType: "container",
        resourceId: container.id,
        name: container.name,
        status: container.status,
        billingStatus: container.billing_status,
        lifecycleRevision: container.lifecycle_revision,
        unitPrice,
        billingInterval: "day",
        lastBilledAt: iso(container.last_billed_at),
        nextBillingAt: iso(container.next_billing_at),
        estimatedNextBillingAt: iso(estimatedNext),
        totalBilled: parseActiveBillingNonNegativeNumber(
          container.total_billed,
          "container.total_billed",
        ),
        cancelEndpoint: cancelEndpoint("container", container.id),
        cancelAction: "stop",
        metadata: {
          projectName: container.project_name,
          desiredCount: container.desired_count,
          cpu: container.cpu,
          memory: container.memory,
          publicHostname: container.public_hostname,
          url: container.load_balancer_url,
          scheduledShutdownAt: iso(container.scheduled_shutdown_at),
        },
      };
    });

    const agentResources = agentRows.map((agent): ActiveBillableResource => {
      const isRunning =
        agent.status === "running" ||
        (["deletion_pending", "deletion_failed"].includes(agent.status) &&
          agent.deletion_previous_status !== "stopped");
      const unitPrice = isRunning
        ? AGENT_PRICING.RUNNING_HOURLY_RATE
        : AGENT_PRICING.IDLE_HOURLY_RATE;
      const estimatedNext = agent.last_billed_at
        ? addMs(agent.last_billed_at, 60 * 60 * 1000)
        : null;

      return {
        resourceType: "agent_sandbox",
        resourceId: agent.id,
        name: agent.agent_name ?? agent.id,
        status: agent.status,
        billingStatus: agent.billing_status,
        lifecycleRevision: agent.lifecycle_revision,
        unitPrice,
        billingInterval: "hour",
        lastBilledAt: iso(agent.last_billed_at),
        nextBillingAt: null,
        estimatedNextBillingAt: iso(estimatedNext),
        totalBilled: parseActiveBillingNonNegativeNumber(
          agent.total_billed,
          "agent_sandbox.total_billed",
        ),
        cancelEndpoint: cancelEndpoint("agent_sandbox", agent.id),
        cancelAction: "stop_compute",
        metadata: {
          characterId: agent.character_id,
          sandboxId: agent.sandbox_id,
          bridgeUrl: agent.bridge_url,
          hourlyRate:
            agent.hourly_rate === null || agent.hourly_rate === undefined
              ? unitPrice
              : parseActiveBillingNonNegativeNumber(agent.hourly_rate, "agent_sandbox.hourly_rate"),
          lastBackupAt: iso(agent.last_backup_at),
          scheduledShutdownAt: iso(agent.scheduled_shutdown_at),
          billableReason: isRunning ? "running_agent" : "idle_snapshot_storage",
        },
      };
    });

    return [...containerResources, ...agentResources].sort(
      (a, b) => a.resourceType.localeCompare(b.resourceType) || a.name.localeCompare(b.name),
    );
  }

  async listLedger(organizationId: string, limit = 50): Promise<BillingLedgerEntry[]> {
    const rows = await dbRead
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.organization_id, organizationId))
      .orderBy(desc(creditTransactions.created_at))
      .limit(Math.min(Math.max(limit, 1), 200));

    return rows.map((row) => {
      const metadata = row.metadata ?? {};
      const detected = detectLedgerResource(metadata);
      return {
        id: row.id,
        amount: parseActiveBillingNumber(row.amount, "credit_transaction.amount"),
        type: row.type,
        description: row.description,
        createdAt: row.created_at.toISOString(),
        source: detected.source,
        resourceType: detected.resourceType,
        resourceId: detected.resourceId,
        metadata,
      };
    });
  }

  /** Version-2 durable, replay-safe cancellation admission. */
  async requestCancellation(options: RequestBillingCancellationOptions) {
    return await billingResourceCancellationsService.request(options);
  }

  /**
   * Compatibility-only lookup for clients published before the durable
   * cancellation contract exposed resource type and lifecycle revision.
   *
   * The durable request still repeats target locking and revision validation
   * in its write transaction. A lifecycle change after this primary read is
   * therefore a normal 409, never authority for a stale provider effect.
   * Stopped/suspended rows intentionally remain resolvable so a client that
   * lost the accepted response can replay the original durable command. A
   * provider-confirmed user stop may have advanced the row by one revision;
   * only that exact proof can reconcile the compatibility request back to the
   * admitted revision. Running rows always use their current generation.
   */
  async resolveCancellationTarget(
    organizationId: string,
    resourceId: string,
    resourceType?: BillableResourceType,
    database: Pick<Database, "select"> = dbWrite,
  ): Promise<{
    resourceType: BillableResourceType;
    lifecycleRevision: number;
  }> {
    const findContainer = async () => {
      const [row] = await database
        .select({
          lifecycleRevision: containers.lifecycle_revision,
          status: containers.status,
        })
        .from(containers)
        .where(
          and(
            eq(containers.id, resourceId),
            eq(containers.organization_id, organizationId),
            ne(containers.status, TERMINAL_CONTAINER_STATUS),
          ),
        )
        .limit(1);
      const [latestProviderConfirmedIntent] =
        row?.status === "stopped"
          ? await database
              .select({
                lifecycleRevision: containerComputeStopIntents.lifecycle_revision,
              })
              .from(containerComputeStopIntents)
              .where(
                and(
                  eq(containerComputeStopIntents.organization_id, organizationId),
                  eq(containerComputeStopIntents.container_id, resourceId),
                  eq(containerComputeStopIntents.authorization, "user_request"),
                  isNotNull(containerComputeStopIntents.provider_confirmed_at),
                ),
              )
              .orderBy(
                desc(containerComputeStopIntents.lifecycle_revision),
                desc(containerComputeStopIntents.created_at),
              )
              .limit(1)
          : [];
      return row
        ? ({
            resourceType: "container",
            lifecycleRevision: compatibilityCancellationRevision(
              row.status,
              row.lifecycleRevision,
              latestProviderConfirmedIntent?.lifecycleRevision ?? null,
            ),
          } as const)
        : null;
    };
    const findAgent = async () => {
      const [row] = await database
        .select({
          lifecycleRevision: agentSandboxes.lifecycle_revision,
          status: agentSandboxes.status,
        })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, resourceId),
            eq(agentSandboxes.organization_id, organizationId),
            activeBillingAgentAuthorityPredicate(),
          ),
        )
        .limit(1);
      const [latestProviderConfirmedIntent] =
        row?.status === "stopped"
          ? await database
              .select({
                lifecycleRevision: agentComputeStopIntents.lifecycle_revision,
              })
              .from(agentComputeStopIntents)
              .where(
                and(
                  eq(agentComputeStopIntents.organization_id, organizationId),
                  eq(agentComputeStopIntents.agent_id, resourceId),
                  eq(agentComputeStopIntents.authorization, "user_request"),
                  isNotNull(agentComputeStopIntents.provider_confirmed_at),
                ),
              )
              .orderBy(
                desc(agentComputeStopIntents.lifecycle_revision),
                desc(agentComputeStopIntents.created_at),
              )
              .limit(1)
          : [];
      return row
        ? ({
            resourceType: "agent_sandbox",
            lifecycleRevision: compatibilityCancellationRevision(
              row.status,
              row.lifecycleRevision,
              latestProviderConfirmedIntent?.lifecycleRevision ?? null,
            ),
          } as const)
        : null;
    };

    const matches = resourceType
      ? [resourceType === "container" ? await findContainer() : await findAgent()]
      : await Promise.all([findContainer(), findAgent()]);
    const present = matches.filter(
      (
        match,
      ): match is {
        resourceType: BillableResourceType;
        lifecycleRevision: number;
      } => match !== null,
    );
    if (present.length === 0) {
      throw new ApiError(404, "resource_not_found", "Billable resource not found");
    }
    if (present.length > 1) {
      throw new ApiError(
        409,
        "billing_state_conflict",
        "Resource id is ambiguous; retry with resourceType",
        { resourceId },
      );
    }
    return present[0]!;
  }

  async cancelResource(options: CancelBillableResourceOptions): Promise<{
    resource: ActiveBillableResource;
    stoppedBilling: boolean;
    message: string;
    infrastructureAction: InfrastructureCancellationAction;
  }> {
    const { organizationId, resourceId, resourceType, mode = "stop", triggerEnv } = options;
    const now = new Date();

    if (!resourceType || resourceType === "container") {
      const [container] = await dbWrite
        .select()
        .from(containers)
        .where(and(eq(containers.id, resourceId), eq(containers.organization_id, organizationId)))
        .limit(1);

      if (container) {
        const unitPrice = calculateDailyContainerCost({
          desiredCount: container.desired_count,
          cpu: container.cpu,
          memory: container.memory,
        });
        const totalBilled = parseActiveBillingNonNegativeNumber(
          container.total_billed,
          "container.total_billed",
        );
        await options.authorizeInfrastructureMutation();
        let cancellationId: string | null = null;
        if (mode === "delete") {
          const cancellation = await retireContainerWithDeleteJob(container.id, organizationId);
          if (!cancellation.jobId) {
            throw new ElizaError("Container deletion did not acquire durable teardown ownership", {
              code: "BILLING_CANCEL_CONTAINER_DELETE_NOT_OWNED",
              context: {
                containerId: container.id,
                organizationId,
                outcome: cancellation.outcome,
              },
            });
          }
          cancellationId = cancellation.jobId;
        } else if (container.status !== "stopped" || container.billing_status !== "suspended") {
          const target = await this.resolveCancellationTarget(
            organizationId,
            container.id,
            "container",
          );
          const cancellation = await enqueueContainerUserStopOnce({
            containerId: container.id,
            organizationId,
            userId: container.user_id,
            expectedLifecycleRevision: target.lifecycleRevision,
          });
          if (!cancellation.requested) {
            throw new ElizaError("Explicit container cancellation was superseded unexpectedly", {
              code: "BILLING_CANCEL_CONTAINER_STOP_SUPERSEDED",
              context: { containerId: container.id, organizationId, reason: cancellation.reason },
            });
          }
          cancellationId = cancellation.jobId;
        }
        const [current] = await dbWrite
          .select()
          .from(containers)
          .where(
            and(eq(containers.id, container.id), eq(containers.organization_id, organizationId)),
          )
          .limit(1);
        if (!current) {
          throw new ApiError(409, "session_not_ready", "Container changed during cancellation");
        }
        const providerStopped =
          mode === "stop" && current.status === "stopped" && current.billing_status === "suspended";
        const infrastructureAction: InfrastructureCancellationAction = {
          attempted: false,
          status: providerStopped ? "stopped" : "queued",
          message: providerStopped
            ? "Container is stopped and billing is suspended."
            : "Container cancellation is durably queued for daemon execution.",
        };

        return {
          stoppedBilling: providerStopped,
          message: providerStopped
            ? infrastructureAction.message
            : "Container cancellation is pending provider confirmation; billing remains unsettled.",
          infrastructureAction,
          resource: {
            resourceType: "container",
            resourceId: container.id,
            lifecycleRevision: current.lifecycle_revision,
            name: container.name,
            status: current.status,
            billingStatus: current.billing_status,
            unitPrice,
            billingInterval: "day",
            lastBilledAt: iso(current.last_billed_at),
            nextBillingAt: iso(current.next_billing_at),
            estimatedNextBillingAt: providerStopped ? null : iso(current.next_billing_at),
            totalBilled,
            cancelEndpoint: cancelEndpoint("container", container.id),
            cancelAction: "stop",
            metadata: {
              projectName: container.project_name,
              ...(cancellationId ? { cancellationId } : {}),
              cancellationRequestedAt: now.toISOString(),
              mode,
              infrastructureAction,
            },
          },
        };
      }
    }

    if (!resourceType || resourceType === "agent_sandbox") {
      // Authorize against the primary immediately before atomically acquiring
      // the durable lifecycle job. The daemon owns provider I/O and the final
      // billing write, so this request never fabricates completion.
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, resourceId),
            eq(agentSandboxes.organization_id, organizationId),
            activeBillingAgentAuthorityPredicate(),
          ),
        )
        .limit(1);

      if (agent) {
        const unitPrice =
          agent.status === "running"
            ? AGENT_PRICING.RUNNING_HOURLY_RATE
            : AGENT_PRICING.IDLE_HOURLY_RATE;
        const totalBilled = parseActiveBillingNonNegativeNumber(
          agent.total_billed,
          "agent_sandbox.total_billed",
        );
        await options.authorizeInfrastructureMutation();
        const billingWasSuspended =
          agent.status === "stopped" && agent.billing_status === "suspended";
        if (mode === "stop" && billingWasSuspended) {
          const infrastructureAction: InfrastructureCancellationAction = {
            attempted: false,
            status: "not_needed",
            message: "Managed agent is already stopped and billing is suspended.",
          };
          return {
            stoppedBilling: true,
            message: infrastructureAction.message,
            infrastructureAction,
            resource: {
              resourceType: "agent_sandbox",
              resourceId: agent.id,
              lifecycleRevision: agent.lifecycle_revision,
              name: agent.agent_name ?? agent.id,
              status: agent.status,
              billingStatus: agent.billing_status,
              unitPrice,
              billingInterval: "hour",
              lastBilledAt: iso(agent.last_billed_at),
              nextBillingAt: null,
              estimatedNextBillingAt: null,
              totalBilled,
              cancelEndpoint: cancelEndpoint("agent_sandbox", agent.id),
              cancelAction: "stop_compute",
              metadata: { characterId: agent.character_id, mode, infrastructureAction },
            },
          };
        }
        const cancellation = await enqueueAgentCancellation(
          agent.id,
          organizationId,
          agent.user_id,
          agent.lifecycle_revision,
          mode,
          triggerEnv,
        );
        const authoritySelection = {
          id: agentSandboxes.id,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
          status: agentSandboxes.status,
          billingStatus: agentSandboxes.billing_status,
          deletionAttemptId: agentSandboxes.deletion_attempt_id,
        };
        const [currentAuthority] =
          mode === "delete"
            ? await dbWrite
                .select(authoritySelection)
                .from(agentSandboxes)
                .innerJoin(
                  jobs,
                  and(
                    eq(jobs.id, cancellation.job.id),
                    eq(jobs.type, "agent_delete"),
                    eq(jobs.organization_id, organizationId),
                    eq(jobs.agent_id, agent.id),
                    inArray(jobs.status, ["pending", "in_progress"]),
                  ),
                )
                .where(
                  and(
                    eq(agentSandboxes.id, resourceId),
                    eq(agentSandboxes.organization_id, organizationId),
                    eq(agentSandboxes.status, "deletion_pending"),
                    isNotNull(agentSandboxes.deletion_attempt_id),
                    billableAgentAuthorityPredicate(),
                  ),
                )
                .limit(1)
            : await dbWrite
                .select(authoritySelection)
                .from(agentSandboxes)
                .where(
                  and(
                    eq(agentSandboxes.id, resourceId),
                    eq(agentSandboxes.organization_id, organizationId),
                    eq(agentSandboxes.lifecycle_revision, agent.lifecycle_revision),
                    activeBillingAgentAuthorityPredicate(),
                  ),
                )
                .limit(1);
        if (!currentAuthority) {
          throw new ApiError(
            409,
            "session_not_ready",
            "Managed agent billing authority changed during cancellation",
          );
        }
        if (
          mode === "delete" &&
          currentAuthority.billingStatus === "suspended" &&
          !billingWasSuspended
        ) {
          throw new ApiError(
            409,
            "session_not_ready",
            "Managed agent deletion lost billable provider authority",
          );
        }
        const infrastructureAction: InfrastructureCancellationAction = {
          attempted: false,
          status: "queued",
          message: "Managed agent cancellation is durably queued for orchestrator execution.",
        };

        return {
          stoppedBilling: billingWasSuspended && currentAuthority.billingStatus === "suspended",
          message: billingWasSuspended
            ? "Managed agent deletion is queued; billing remains suspended."
            : "Managed agent cancellation is pending provider confirmation; billing remains unsettled.",
          infrastructureAction,
          resource: {
            resourceType: "agent_sandbox",
            resourceId: agent.id,
            lifecycleRevision: currentAuthority.lifecycleRevision,
            name: agent.agent_name ?? agent.id,
            status: mode === "delete" ? "deletion_pending" : agent.status,
            billingStatus: currentAuthority.billingStatus,
            unitPrice,
            billingInterval: "hour",
            lastBilledAt: iso(agent.last_billed_at),
            nextBillingAt: null,
            estimatedNextBillingAt: agent.last_billed_at
              ? iso(addMs(agent.last_billed_at, 60 * 60 * 1000))
              : null,
            totalBilled,
            cancelEndpoint: cancelEndpoint("agent_sandbox", agent.id),
            cancelAction: "stop_compute",
            metadata: {
              characterId: agent.character_id,
              cancellationId: cancellation.job.id,
              ...(mode === "delete"
                ? { deletionAttemptId: currentAuthority.deletionAttemptId }
                : {}),
              cancellationRequestedAt: now.toISOString(),
              mode,
              infrastructureAction,
            },
          },
        };
      }
    }

    throw new Error("Billable resource not found");
  }
}

export const activeBillingService = new ActiveBillingService();

async function enqueueAgentCancellation(
  agentId: string,
  organizationId: string,
  userId: string,
  expectedLifecycleRevision: number,
  mode: "stop" | "delete",
  triggerEnv?: AppEnv["Bindings"],
): ReturnType<typeof provisioningJobService.enqueueAgentSuspendOnce> {
  try {
    // Both paths require provider access unavailable in Cloudflare Workers.
    // Their existing lifecycle queues are the durable ownership boundary.
    let result: Awaited<ReturnType<typeof provisioningJobService.enqueueAgentSuspendOnce>>;
    if (mode === "delete") {
      result = await provisioningJobService.enqueueAgentDeleteOnce({
        agentId,
        organizationId,
        userId,
        authorization: "billing_request",
      });
    } else {
      result = await provisioningJobService.enqueueAgentSuspendOnce({
        agentId,
        organizationId,
        userId,
        authorization: "user_request",
        expectedLifecycleRevision,
        requireUserOwnedBillingAuthority: true,
      });
    }
    // error-policy:J7 the durable job is committed; a nudge failure only delays
    // the independently polled orchestrator and must remain observable.
    void provisioningJobService.triggerImmediate(triggerEnv).catch((err) =>
      logger.warn("[ActiveBilling] provisioning triggerImmediate nudge failed", {
        agentId,
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return result;
  } catch (error) {
    // error-policy:J2 enqueue failure must not be translated into fabricated
    // cancellation success because no durable lifecycle owner exists.
    throw new ElizaError("Managed agent cancellation could not be durably enqueued", {
      code: "BILLING_CANCEL_AGENT_ENQUEUE_FAILED",
      context: { agentId, organizationId, mode },
      cause: error,
    });
  }
}
