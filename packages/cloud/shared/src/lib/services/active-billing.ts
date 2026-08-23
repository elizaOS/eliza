/**
 * Selects organization-scoped billable compute resources and coordinates
 * their ledger and cancellation operations. Snapshot callers may supply an
 * open read transaction so resource identity and canonical rate segments share
 * one primary-database observation boundary.
 */

import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { type Database, dbRead } from "../../db/client";
import { agentSandboxes, CONTAINER_BACKED_EXECUTION_TIERS } from "../../db/schemas/agent-sandboxes";
import type { BillingCancelResourceType } from "../../db/schemas/billing-cancel-commands";
import { containers } from "../../db/schemas/containers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { AGENT_PRICING } from "../constants/agent-pricing";
import { calculateDailyContainerCost } from "../constants/pricing";
import {
  parseActiveBillingNonNegativeNumber,
  parseActiveBillingNumber,
} from "./active-billing-numeric";
import {
  billingResourceCancellationsService,
  type RequestBillingCancellationOptions,
} from "./billing-resource-cancellations";

export type BillableResourceType = BillingCancelResourceType;
export type BillableInterval = "day" | "hour";

export interface ActiveBillableResource {
  resourceType: BillableResourceType;
  resourceId: string;
  name: string;
  status: string;
  billingStatus: string;
  /** Compare-and-set generation required by the durable stop endpoint. */
  lifecycleRevision: number;
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

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function cancelEndpoint(resource: BillableResourceType, id: string): string {
  return `/api/v1/billing/resources/${id}/cancel?resourceType=${resource}`;
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
            eq(containers.status, "running"),
            inArray(containers.billing_status, ["active", "warning", "shutdown_pending"]),
          ),
        ),
      database
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, organizationId),
            activeBillingAgentAuthorityPredicate(),
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
        cancelAction: "suspend_billing",
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

  /** Durable, replay-safe replacement for the legacy one-shot cancellation flow. */
  async requestCancellation(options: RequestBillingCancellationOptions) {
    return await billingResourceCancellationsService.request(options);
  }
}

export const activeBillingService = new ActiveBillingService();
