import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { containers } from "@/db/schemas/containers";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { calculateDailyContainerCost } from "@/lib/constants/pricing";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";

export type BillableResourceType = "container" | "agent_sandbox";
export type BillableInterval = "day" | "hour";

export interface ActiveBillableResource {
  resourceType: BillableResourceType;
  resourceId: string;
  name: string;
  status: string;
  billingStatus: string;
  unitPrice: number;
  billingInterval: BillableInterval;
  lastBilledAt: string | null;
  nextBillingAt: string | null;
  estimatedNextBillingAt: string | null;
  totalBilled: number;
  cancelEndpoint: string;
  cancelAction: "stop" | "suspend_billing";
  metadata: Record<string, unknown>;
}

export interface InfrastructureCancellationAction {
  attempted: boolean;
  status: "not_needed" | "stopped" | "deleted" | "failed";
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
  async listActiveResources(organizationId: string): Promise<ActiveBillableResource[]> {
    const [containerRows, agentRows] = await Promise.all([
      dbRead
        .select()
        .from(containers)
        .where(
          and(
            eq(containers.organization_id, organizationId),
            eq(containers.status, "running"),
            inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
          ),
        ),
      dbRead
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, organizationId),
            inArray(agentSandboxes.billing_status, ["active", "warning", "shutdown_pending"]),
            or(
              eq(agentSandboxes.status, "running"),
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
        unitPrice,
        billingInterval: "day",
        lastBilledAt: iso(container.last_billed_at),
        nextBillingAt: iso(container.next_billing_at),
        estimatedNextBillingAt: iso(estimatedNext),
        totalBilled: Number(container.total_billed),
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
      const isRunning = agent.status === "running";
      const unitPrice = isRunning
        ? AGENT_PRICING.RUNNING_HOURLY_RATE
        : AGENT_PRICING.IDLE_HOURLY_RATE;
      const estimatedNext = agent.last_billed_at
        ? addMs(agent.last_billed_at, 60 * 60 * 1000)
        : null;

      return {
        resourceType: "agent_sandbox",
        resourceId: agent.id,
        name: agent.agent_name ?? agent.id.slice(0, 8),
        status: agent.status,
        billingStatus: agent.billing_status,
        unitPrice,
        billingInterval: "hour",
        lastBilledAt: iso(agent.last_billed_at),
        nextBillingAt: null,
        estimatedNextBillingAt: iso(estimatedNext),
        totalBilled: Number(agent.total_billed),
        cancelEndpoint: cancelEndpoint("agent_sandbox", agent.id),
        cancelAction: "suspend_billing",
        metadata: {
          characterId: agent.character_id,
          sandboxId: agent.sandbox_id,
          bridgeUrl: agent.bridge_url,
          hourlyRate: Number(agent.hourly_rate ?? unitPrice),
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
        amount: Number(row.amount),
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

  async cancelResource(options: CancelBillableResourceOptions): Promise<{
    resource: ActiveBillableResource;
    stoppedBilling: boolean;
    message: string;
    infrastructureAction: InfrastructureCancellationAction;
  }> {
    const { organizationId, resourceId, resourceType, mode = "stop" } = options;
    const now = new Date();

    if (!resourceType || resourceType === "container") {
      const [container] = await dbRead
        .select()
        .from(containers)
        .where(and(eq(containers.id, resourceId), eq(containers.organization_id, organizationId)))
        .limit(1);

      if (container) {
        const infrastructureAction = await cancelContainerInfrastructure(
          container.id,
          organizationId,
          mode,
        );
        const unitPrice = calculateDailyContainerCost({
          desiredCount: container.desired_count,
          cpu: container.cpu,
          memory: container.memory,
        });

        if (mode === "delete" && infrastructureAction.status === "deleted") {
          return {
            stoppedBilling: true,
            message: "Container was deleted and billing has stopped.",
            infrastructureAction,
            resource: {
              resourceType: "container",
              resourceId: container.id,
              name: container.name,
              status: "deleted",
              billingStatus: "suspended",
              unitPrice,
              billingInterval: "day",
              lastBilledAt: iso(container.last_billed_at),
              nextBillingAt: null,
              estimatedNextBillingAt: null,
              totalBilled: Number(container.total_billed),
              cancelEndpoint: cancelEndpoint("container", container.id),
              cancelAction: "stop",
              metadata: {
                projectName: container.project_name,
                cancelledAt: now.toISOString(),
                mode,
                infrastructureAction,
              },
            },
          };
        }

        const metadata = {
          ...(container.metadata ?? {}),
          billing_cancelled_at: now.toISOString(),
          billing_cancel_mode: mode,
          billing_cancel_infrastructure_action: infrastructureAction,
        };
        const [updated] = await dbWrite
          .update(containers)
          .set({
            status: "stopped",
            billing_status: "suspended",
            next_billing_at: null,
            scheduled_shutdown_at: null,
            shutdown_warning_sent_at: null,
            metadata,
            updated_at: now,
          })
          .where(and(eq(containers.id, resourceId), eq(containers.organization_id, organizationId)))
          .returning();

        return {
          stoppedBilling: true,
          message:
            infrastructureAction.status === "stopped"
              ? "Container was stopped and billing has been suspended."
              : "Container billing has been suspended; infrastructure stop needs operator follow-up.",
          infrastructureAction,
          resource: {
            resourceType: "container",
            resourceId: updated.id,
            name: updated.name,
            status: updated.status,
            billingStatus: updated.billing_status,
            unitPrice,
            billingInterval: "day",
            lastBilledAt: iso(updated.last_billed_at),
            nextBillingAt: iso(updated.next_billing_at),
            estimatedNextBillingAt: null,
            totalBilled: Number(updated.total_billed),
            cancelEndpoint: cancelEndpoint("container", updated.id),
            cancelAction: "stop",
            metadata: {
              projectName: updated.project_name,
              cancelledAt: now.toISOString(),
              mode,
              infrastructureAction,
            },
          },
        };
      }
    }

    if (!resourceType || resourceType === "agent_sandbox") {
      const [agent] = await dbRead
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, resourceId),
            eq(agentSandboxes.organization_id, organizationId),
          ),
        )
        .limit(1);

      if (agent) {
        const infrastructureAction = await cancelAgentInfrastructure(
          agent.id,
          organizationId,
          mode,
        );
        const unitPrice =
          agent.status === "running"
            ? AGENT_PRICING.RUNNING_HOURLY_RATE
            : AGENT_PRICING.IDLE_HOURLY_RATE;

        if (mode === "delete" && infrastructureAction.status === "deleted") {
          return {
            stoppedBilling: true,
            message: "Managed agent was deleted and billing has stopped.",
            infrastructureAction,
            resource: {
              resourceType: "agent_sandbox",
              resourceId: agent.id,
              name: agent.agent_name ?? agent.id.slice(0, 8),
              status: "deleted",
              billingStatus: "suspended",
              unitPrice,
              billingInterval: "hour",
              lastBilledAt: iso(agent.last_billed_at),
              nextBillingAt: null,
              estimatedNextBillingAt: null,
              totalBilled: Number(agent.total_billed),
              cancelEndpoint: cancelEndpoint("agent_sandbox", agent.id),
              cancelAction: "suspend_billing",
              metadata: {
                characterId: agent.character_id,
                cancelledAt: now.toISOString(),
                mode,
                infrastructureAction,
              },
            },
          };
        }

        const [updated] = await dbWrite
          .update(agentSandboxes)
          .set({
            status: infrastructureAction.status === "stopped" ? "stopped" : agent.status,
            billing_status: "suspended",
            scheduled_shutdown_at: null,
            shutdown_warning_sent_at: null,
            updated_at: now,
          })
          .where(
            and(
              eq(agentSandboxes.id, resourceId),
              eq(agentSandboxes.organization_id, organizationId),
            ),
          )
          .returning();

        return {
          stoppedBilling: true,
          message:
            infrastructureAction.status === "stopped"
              ? "Managed agent was stopped and billing has been suspended."
              : "Managed agent billing has been suspended; infrastructure stop needs operator follow-up.",
          infrastructureAction,
          resource: {
            resourceType: "agent_sandbox",
            resourceId: updated.id,
            name: updated.agent_name ?? updated.id.slice(0, 8),
            status: updated.status,
            billingStatus: updated.billing_status,
            unitPrice,
            billingInterval: "hour",
            lastBilledAt: iso(updated.last_billed_at),
            nextBillingAt: null,
            estimatedNextBillingAt: null,
            totalBilled: Number(updated.total_billed),
            cancelEndpoint: cancelEndpoint("agent_sandbox", updated.id),
            cancelAction: "suspend_billing",
            metadata: {
              characterId: updated.character_id,
              cancelledAt: now.toISOString(),
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

async function cancelContainerInfrastructure(
  containerId: string,
  organizationId: string,
  mode: "stop" | "delete",
): Promise<InfrastructureCancellationAction> {
  try {
    const { getHetznerContainersClient } = await import("@/lib/services/containers/hetzner-client");
    const client = getHetznerContainersClient();

    if (mode === "delete") {
      await client.deleteContainer(containerId, organizationId, { purgeVolume: false });
      return {
        attempted: true,
        status: "deleted",
        message: "Container runtime and control-plane row were deleted.",
      };
    }

    await client.stopContainer(containerId, organizationId, { purgeVolume: false });
    return {
      attempted: true,
      status: "stopped",
      message: "Container runtime was stopped and removed from the Docker node.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[active-billing] Container infrastructure cancellation failed", {
      containerId,
      organizationId,
      mode,
      error: message,
    });
    return {
      attempted: true,
      status: "failed",
      message: "Container billing was suspended, but infrastructure cleanup failed.",
      error: message,
    };
  }
}

async function cancelAgentInfrastructure(
  agentId: string,
  organizationId: string,
  mode: "stop" | "delete",
): Promise<InfrastructureCancellationAction> {
  try {
    const result =
      mode === "delete"
        ? await elizaSandboxService.deleteAgent(agentId, organizationId)
        : await elizaSandboxService.shutdown(agentId, organizationId);

    if (!result.success) {
      return {
        attempted: true,
        status: "failed",
        message: result.error ?? "Agent lifecycle operation failed.",
        error: result.error,
      };
    }

    return {
      attempted: true,
      status: mode === "delete" ? "deleted" : "stopped",
      message:
        mode === "delete"
          ? "Managed agent runtime, database, and control-plane row were deleted."
          : "Managed agent runtime was shut down with a pre-shutdown snapshot when available.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[active-billing] Agent infrastructure cancellation failed", {
      agentId,
      organizationId,
      mode,
      error: message,
    });
    return {
      attempted: true,
      status: "failed",
      message: "Managed agent billing was suspended, but infrastructure cleanup failed.",
      error: message,
    };
  }
}
