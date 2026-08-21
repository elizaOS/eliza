/**
 * Persists Cloud container records and enforces organization-scoped admission,
 * billing, lifecycle, and deployment-log boundaries.
 */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import {
  and,
  asc,
  desc,
  eq,
  type InferInsertModel,
  type InferSelectModel,
  inArray,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  type ContainerLimitResolution,
  resolveMaxContainersForOrg,
} from "../../lib/constants/pricing";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import { hydrateTextField, offloadTextField } from "../../lib/storage/object-store";
import { type Database, dbRead, dbWrite } from "../helpers";
import { containerComputeStopIntents } from "../schemas/compute-stop-intents";
import { containers, TERMINAL_CONTAINER_STATUS } from "../schemas/containers";
import { creditTransactions } from "../schemas/credit-transactions";
import { dockerNodes } from "../schemas/docker-nodes";
import { organizationConfig } from "../schemas/organization-config";
import { organizations } from "../schemas/organizations";
import { redeemableEarnings } from "../schemas/redeemable-earnings";
import { users } from "../schemas/users";
import { settleComputeRateSegments } from "./compute-billing-segments";
import { containerBillingRepository } from "./container-billing";
import { parseOrganizationCreditBalance } from "./organizations-credit-balance-numeric";

export type Container = InferSelectModel<typeof containers>;
export type NewContainer = InferInsertModel<typeof containers>;

export type ContainerStatus =
  | "pending"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed"
  | "deleting"
  // Spelled through the shared constant so the CAS predicate and this union can
  // never drift apart.
  | typeof TERMINAL_CONTAINER_STATUS;

export interface QuotaCheckResult {
  /** Distinguishes an authoritative quota decision from an unreadable source. */
  availability: "ready" | "unavailable";
  allowed: boolean;
  current: number;
  max: number;
  error?: string;
}

/** Result of admitting one canonical project intent under the organization lock. */
export interface ContainerProjectIntentResult {
  container: Container;
  created: boolean;
}

function resolveContainerLimitFromDatabaseSources(
  creditBalance: string | number | null | undefined,
  orgSettings: unknown,
): ContainerLimitResolution {
  let parsedBalance: number;
  try {
    parsedBalance = parseOrganizationCreditBalance(creditBalance, "credit_balance");
  } catch (cause) {
    // error-policy:J2 — retain the database-boundary diagnostic internally but
    // expose a stable, source-classified quota failure to callers.
    throw new ElizaError("Container quota credit balance is unavailable", {
      code:
        creditBalance === null || creditBalance === undefined || String(creditBalance).trim() === ""
          ? "MISSING_CONTAINER_QUOTA_SOURCE"
          : "INVALID_CONTAINER_QUOTA_SOURCE",
      cause,
      context: { source: "organizations.credit_balance" },
      severity: "fatal",
    });
  }

  return resolveMaxContainersForOrg(parsedBalance, orgSettings);
}

function hasDeploymentLogUpdate(data: Partial<NewContainer>): boolean {
  return data.deployment_log !== undefined;
}

async function hydrateContainerDeploymentLog(container: Container): Promise<Container> {
  const deploymentLog = await hydrateTextField({
    storage: container.deployment_log_storage,
    key: container.deployment_log_key,
    inlineValue: container.deployment_log,
  });

  return {
    ...container,
    deployment_log: deploymentLog,
  };
}

async function prepareContainerInsertPayload(
  data: NewContainer,
  context: Pick<Container, "id" | "organization_id" | "created_at">,
): Promise<NewContainer> {
  if (data.deployment_log_storage === "r2" || data.deployment_log === undefined) {
    return data;
  }

  const deploymentLog = await offloadTextField({
    namespace: ObjectNamespaces.ContainerDeployLogs,
    organizationId: data.organization_id,
    objectId: context.id,
    field: "deployment_log",
    // Deployment logs are diagnostics; bound them when offload is unavailable.
    oversizeInline: "clamp" as const,
    createdAt: data.created_at ?? context.created_at,
    value: data.deployment_log,
  });

  return {
    ...data,
    deployment_log: deploymentLog.value,
    deployment_log_storage: deploymentLog.storage,
    deployment_log_key: deploymentLog.key,
  };
}

async function prepareContainerUpdatePayload(
  data: Partial<NewContainer>,
  context: Pick<Container, "id" | "organization_id" | "created_at">,
): Promise<Partial<NewContainer>> {
  if (data.deployment_log_storage === "r2" || data.deployment_log === undefined) {
    return data;
  }

  const deploymentLog = await offloadTextField({
    namespace: ObjectNamespaces.ContainerDeployLogs,
    organizationId: data.organization_id ?? context.organization_id,
    objectId: context.id,
    field: "deployment_log",
    // Deployment logs are diagnostics; bound them when offload is unavailable.
    oversizeInline: "clamp" as const,
    createdAt: data.created_at ?? context.created_at ?? new Date(),
    value: data.deployment_log,
  });

  return {
    ...data,
    deployment_log: deploymentLog.value,
    deployment_log_storage: deploymentLog.storage,
    deployment_log_key: deploymentLog.key,
  };
}

/**
 * Custom error class for quota exceeded errors
 */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    public current: number,
    public max: number,
  ) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/**
 * Custom error class for duplicate container name errors
 */
export class DuplicateContainerNameError extends Error {
  constructor(
    message: string,
    public containerName: string,
  ) {
    super(message);
    this.name = "DuplicateContainerNameError";
  }
}

/**
 * Repository for container deployment database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class ContainersRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Lists all containers for an organization.
   */
  async listByOrganization(organizationId: string): Promise<Container[]> {
    return await dbRead
      .select()
      .from(containers)
      .where(eq(containers.organization_id, organizationId))
      .orderBy(desc(containers.created_at));
  }

  async listForAdminInfrastructure(
    limit: number,
  ): Promise<
    Array<
      Pick<
        Container,
        | "id"
        | "name"
        | "project_name"
        | "organization_id"
        | "user_id"
        | "status"
        | "public_hostname"
        | "node_id"
        | "cpu"
        | "memory"
        | "desired_count"
        | "created_at"
        | "updated_at"
      >
    >
  > {
    return dbRead
      .select({
        id: containers.id,
        name: containers.name,
        project_name: containers.project_name,
        organization_id: containers.organization_id,
        user_id: containers.user_id,
        status: containers.status,
        public_hostname: containers.public_hostname,
        node_id: containers.node_id,
        cpu: containers.cpu,
        memory: containers.memory,
        desired_count: containers.desired_count,
        created_at: containers.created_at,
        updated_at: containers.updated_at,
      })
      .from(containers)
      .orderBy(desc(containers.created_at))
      .limit(limit);
  }

  /**
   * Finds a container by ID within an organization.
   */
  async findById(id: string, organizationId: string): Promise<Container | null> {
    const results = await dbRead
      .select()
      .from(containers)
      .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
      .limit(1);

    return results[0] ? await hydrateContainerDeploymentLog(results[0]) : null;
  }

  /**
   * Finds the most recent non-terminal container for an org's project key.
   *
   * Non-terminal means the container is still pending/building/deploying or
   * running — i.e. a live deploy the caller would not want duplicated. Used by
   * the deploy route to make POST idempotent on (organization_id, project_name).
   */
  async findActiveByProjectName(
    organizationId: string,
    projectName: string,
  ): Promise<Container | null> {
    const results = await dbRead
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.organization_id, organizationId),
          eq(containers.project_name, projectName),
          notInArray(containers.status, ["stopped", "failed", "deleting", "deleted"]),
        ),
      )
      .orderBy(desc(containers.created_at))
      .limit(1);

    return results[0] ? await hydrateContainerDeploymentLog(results[0]) : null;
  }

  /**
   * Finds every not-yet-torn-down container for an org's project key.
   *
   * Returns containers in any state EXCEPT the terminal `deleting`/`deleted`
   * (rows already on their way out). Used by app-delete teardown to find the
   * live container(s) for an app (the deploy orchestrator sets
   * `project_name = appId`) so they can be stopped/removed and stop being
   * metered. `stopped`/`failed` rows are intentionally included: a `stopped`
   * row can still hold a node slot the daemon delete must release, and a
   * re-deploy may have left more than one row per project key.
   */
  async findUndeletedByProjectName(
    organizationId: string,
    projectName: string,
  ): Promise<Container[]> {
    return await dbRead
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.organization_id, organizationId),
          eq(containers.project_name, projectName),
          notInArray(containers.status, ["deleting", "deleted"]),
        ),
      )
      .orderBy(desc(containers.created_at));
  }

  /**
   * Finds the most recent container for a character.
   */
  async findByCharacterId(characterId: string): Promise<Container | null> {
    const results = await dbRead
      .select()
      .from(containers)
      .where(eq(containers.character_id, characterId))
      .orderBy(desc(containers.created_at))
      .limit(1);

    return results[0] ? await hydrateContainerDeploymentLog(results[0]) : null;
  }

  /**
   * Finds containers for multiple characters.
   */
  async findByCharacterIds(characterIds: string[]): Promise<Container[]> {
    if (characterIds.length === 0) {
      return [];
    }

    return await dbRead
      .select()
      .from(containers)
      .where(inArray(containers.character_id, characterIds))
      .orderBy(desc(containers.created_at));
  }

  /**
   * Checks container quota without creating a container (read-only check).
   *
   * Note: This has a small race condition window but is useful for pre-flight checks.
   * Use createWithQuotaCheck for atomic quota enforcement.
   */
  async checkQuota(organizationId: string): Promise<QuotaCheckResult> {
    // Get organization details
    const org = await dbRead.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { credit_balance: true },
    });

    if (!org) {
      return {
        availability: "unavailable",
        allowed: false,
        current: 0,
        max: 0,
        error: "Organization not found",
      };
    }

    // Get organization config for settings
    const config = await dbRead.query.organizationConfig.findFirst({
      where: eq(organizationConfig.organization_id, organizationId),
    });

    // Count active containers (excluding deleting/deleted status)
    const [{ count }] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(containers)
      .where(
        and(
          eq(containers.organization_id, organizationId),
          notInArray(containers.status, ["deleting", "deleted"]),
        ),
      );

    // error-policy:J4 — a corrupt `credit_balance` NUMERIC (`'NaN'::numeric`
    // migration artifact / manual DB edit) read through a bare `Number(...)`
    // would become NaN and silently drop the org into the FREE tier via
    // getMaxContainersForOrg, mislabelling a paying org's quota. Fail closed:
    // an unreadable balance denies the pre-flight check with a diagnostic
    // error rather than fabricating a free-tier max.
    let resolution: ContainerLimitResolution;
    try {
      resolution = resolveContainerLimitFromDatabaseSources(org.credit_balance, config?.settings);
    } catch (error) {
      // error-policy:J4 — only canonical missing/corrupt quota-source failures
      // become an explicit unavailable result; unexpected defects still fail fast.
      if (
        !(error instanceof ElizaError) ||
        !["MISSING_CONTAINER_QUOTA_SOURCE", "INVALID_CONTAINER_QUOTA_SOURCE"].includes(error.code)
      ) {
        throw error;
      }
      return {
        availability: "unavailable",
        allowed: false,
        current: count,
        max: 0,
        error: "Container quota source unavailable",
      };
    }
    const maxContainers = resolution.limit;

    const allowed = count < maxContainers;

    return {
      availability: "ready",
      allowed,
      current: count,
      max: maxContainers,
      error: allowed ? undefined : `Container quota exceeded (${count}/${maxContainers})`,
    };
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new container record.
   */
  async create(data: NewContainer): Promise<Container> {
    const id = data.id ?? randomUUID();
    const createdAt = data.created_at ?? new Date();
    const insertCandidate: NewContainer = {
      ...data,
      id,
      created_at: createdAt,
    };
    const insertData = await prepareContainerInsertPayload(insertCandidate, {
      id,
      organization_id: data.organization_id,
      created_at: createdAt,
    });

    const values: NewContainer = {
      ...insertData,
      updated_at: new Date(),
    };

    const [container] = await dbWrite.insert(containers).values(values).returning();

    return await hydrateContainerDeploymentLog(container);
  }

  /**
   * Updates an existing container.
   */
  async update(
    id: string,
    organizationId: string,
    data: Partial<NewContainer>,
  ): Promise<Container | null> {
    let updateData = data;
    if (hasDeploymentLogUpdate(data)) {
      const [existing] = await dbWrite
        .select()
        .from(containers)
        .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
        .limit(1);
      if (!existing) return null;
      updateData = await prepareContainerUpdatePayload(data, existing);
    }

    const [updated] = await dbWrite
      .update(containers)
      .set({
        ...updateData,
        updated_at: new Date(),
      })
      .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
      .returning();

    return updated ? await hydrateContainerDeploymentLog(updated) : null;
  }

  /**
   * Atomically fences a user restart against billing stop dispatch.
   *
   * Lock order matches compute billing: workload, organization, then stop
   * intent. A restart is admitted only when authoritative credits plus
   * policy-permitted earnings exceed the exact unsettled segment debt. The
   * elapsed cursor is preserved and marked immediately due, so the billing
   * writer must settle it instead of forgiving the grace interval. Changing
   * status advances lifecycle_revision before provider I/O, so an older
   * dispatcher can never stop the new run.
   */
  async prepareFundedRestart(id: string, organizationId: string, now: Date): Promise<Container> {
    return await dbWrite.transaction(async (tx) => {
      const [container] = await tx
        .select()
        .from(containers)
        .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
        .for("update")
        .limit(1);
      if (!container) throw new Error("Container not found");
      const [organization] = await tx
        .select({
          credit_balance: organizations.credit_balance,
          pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for("update")
        .limit(1);
      if (!organization) throw new Error("Container billing organization not found");
      const creditAvailable = new Decimal(organization.credit_balance);
      if (!creditAvailable.isFinite()) {
        throw new Error("Container restart credit funding is not a finite numeric value");
      }
      let earningsAvailable = new Decimal(0);
      let earningsSourceUserId: string | null = null;
      if (organization.pay_as_you_go_from_earnings) {
        const [sourceUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.organization_id, organizationId))
          .orderBy(desc(sql`${users.role} = 'owner'`), asc(users.created_at), asc(users.id))
          .limit(1);
        if (sourceUser) {
          earningsSourceUserId = sourceUser.id;
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${sourceUser.id}`}))`,
          );
          const [earnings] = await tx
            .select({ available_balance: redeemableEarnings.available_balance })
            .from(redeemableEarnings)
            .where(eq(redeemableEarnings.user_id, sourceUser.id))
            .for("update")
            .limit(1);
          if (earnings) earningsAvailable = new Decimal(earnings.available_balance);
        }
      }
      if (!earningsAvailable.isFinite()) {
        throw new Error("Container restart earnings funding is not a finite numeric value");
      }
      const debt = await settleComputeRateSegments(tx, {
        organizationId,
        workloadKind: "container",
        workloadId: id,
        periodStart: container.last_billed_at ?? container.created_at,
        periodEnd: now,
      });
      if (creditAvailable.plus(earningsAvailable).lte(debt.amount)) {
        throw new Error("Container restart requires funding beyond its unsettled compute debt");
      }

      const settlement = await containerBillingRepository.recordSuccessfulDailyBillingInTransaction(
        tx,
        {
          containerId: id,
          organizationId,
          userId: container.user_id,
          containerName: container.name,
          dailyRate: 0,
          earningsSourceUserId,
          payAsYouGoFromEarnings: organization.pay_as_you_go_from_earnings,
          newBalance: 0,
          now,
        },
        { forceLifecycleSettlement: true },
      );
      if (settlement.insufficient) {
        throw new Error("Container restart funding changed during accrued debt settlement");
      }

      await tx
        .update(containerComputeStopIntents)
        .set({ status: "superseded", superseded_at: now, updated_at: now })
        .where(
          and(
            eq(containerComputeStopIntents.organization_id, organizationId),
            eq(containerComputeStopIntents.container_id, id),
            inArray(containerComputeStopIntents.status, [
              "pending",
              "dispatching",
              "retry",
              "terminal_attention",
            ]),
          ),
        );
      const [prepared] = await tx
        .update(containers)
        .set({
          status: "deploying",
          billing_status: "active",
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          updated_at: now,
        })
        .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
        .returning();
      if (!prepared) throw new Error("Container restart fence was lost");
      return prepared;
    });
  }

  /**
   * Deletes a container by ID.
   */
  async delete(id: string, organizationId: string): Promise<boolean> {
    const results = await dbWrite
      .delete(containers)
      .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)))
      .returning();

    return results.length > 0;
  }

  /**
   * Stops billing on a container at delete time, org-scoped.
   *
   * Mirrors `ContainerBillingRepository.suspendContainer` (status `stopped`,
   * billing_status `suspended`) so the daily container-billing cron — which
   * only meters `status='running'` rows in an active billing state — stops
   * charging the org IMMEDIATELY, closing the cost-leak window between the app
   * delete and the daemon actually removing the live container. Org-scoped to
   * the deleting app's organization; idempotent (a re-run is a harmless no-op
   * write). The live container teardown + node-slot release is the daemon's
   * job via the enqueued CONTAINER_DELETE.
   */
  async markStoppedForBilling(id: string, organizationId: string): Promise<void> {
    await dbWrite
      .update(containers)
      .set({
        status: "stopped",
        billing_status: "suspended",
        updated_at: new Date(),
      })
      .where(and(eq(containers.id, id), eq(containers.organization_id, organizationId)));
  }

  /**
   * Updates container status and optional error message.
   *
   * Compare-and-set on the hard-terminal status. Lifecycle writers read the row
   * and write it back in two separate awaited round-trips with no enclosing
   * transaction (`ContainerRepoAppContainerStore.markRunning` reads at one
   * statement and lands `updateStatus` at another), and a `CONTAINER_DELETE`
   * job for the same container is independently claimable during a deploy
   * overlap — `claimPendingJobs` keys `FOR UPDATE SKIP LOCKED` on JOB rows by
   * type/status/scheduled_for, never by `containerId`. Without this predicate a
   * late write resurrects a container that a completed delete already drove to
   * `deleted`, silently: the row counts toward the organization container quota
   * again (`checkQuota` excludes only `deleting`/`deleted`), and the app-container
   * orphan reconciler treats a non-terminal row as LIVE, so it can never detect
   * or repair the mismatch.
   *
   * Scoped to `deleted` ONLY. Every other status is legitimately re-entered by
   * the lifecycle (a failed deploy retries, `stopped` is restarted by
   * `prepareFundedRestart`), so a broader CAS would reject transitions the live
   * path accepts today. Re-asserting `deleted` on a deleted row stays a
   * permitted idempotent write. Same shape as
   * `agentSandboxesRepository.markReconnectedFromDisconnected`/
   * `markRunningFromProvisioning`, which already compare-and-set this exact
   * class of transition.
   *
   * @returns the updated row, or null when the row is absent OR the CAS lost —
   * callers that must not proceed on a terminal row have to check for null.
   */
  async updateStatus(
    id: string,
    status: ContainerStatus,
    errorMessage?: string,
  ): Promise<Container | null> {
    const [updated] = await dbWrite
      .update(containers)
      .set({
        status,
        error_message: errorMessage || null,
        updated_at: new Date(),
      })
      .where(
        status === TERMINAL_CONTAINER_STATUS
          ? eq(containers.id, id)
          : and(eq(containers.id, id), ne(containers.status, TERMINAL_CONTAINER_STATUS)),
      )
      .returning();

    return updated ? await hydrateContainerDeploymentLog(updated) : null;
  }

  /**
   * Release this container's node slot EXACTLY ONCE, atomically (#8342).
   *
   * The slot decrement on a node (`docker_nodes.allocated_count`) must not run
   * twice for one container, or a re-claim of a CONTAINER_STOP/DELETE job (the
   * crash-retry window) frees a phantom slot that belongs to a LIVE container —
   * the node then over-allocates. The container `status` is NOT a usable gate
   * here: the billing cron pre-sets `status='stopped'` before enqueuing the
   * stop, so the daemon's first legitimate run already sees `stopped`.
   *
   * Instead we stamp a one-way `metadata.slotReleasedAt` marker and decrement
   * the node IN THE SAME TRANSACTION, gated on the marker being absent — so the
   * decrement and the "already released" bookkeeping commit together. A re-run
   * finds the marker set, the conditional update matches no row, and nothing is
   * decremented. Uses the existing `metadata` jsonb (no migration); `jsonb_set`
   * preserves all other keys and `jsonb_exists` avoids the `?` operator's
   * parameter-placeholder ambiguity.
   *
   * @returns true if THIS call released the slot, false if it was already released.
   */
  async tryReleaseNodeSlot(id: string, organizationId: string, nodeId: string): Promise<boolean> {
    return dbWrite.transaction(async (tx) => {
      const [marked] = await tx
        .update(containers)
        .set({
          metadata: sql`jsonb_set(coalesce(${containers.metadata}, '{}'::jsonb), '{slotReleasedAt}', to_jsonb(now()::text))`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(containers.id, id),
            eq(containers.organization_id, organizationId),
            sql`NOT jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'slotReleasedAt')`,
          ),
        )
        .returning({ id: containers.id });

      if (!marked) return false; // already released — never double-free

      await tx
        .update(dockerNodes)
        .set({
          allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
          updated_at: new Date(),
        })
        .where(eq(dockerNodes.node_id, nodeId));

      return true;
    });
  }

  /**
   * Updates the last health check timestamp for a container.
   */
  async updateHealthCheck(id: string): Promise<Container | null> {
    const [updated] = await dbWrite
      .update(containers)
      .set({
        last_health_check: new Date(),
        updated_at: new Date(),
      })
      .where(eq(containers.id, id))
      .returning();

    return updated ? await hydrateContainerDeploymentLog(updated) : null;
  }

  /**
   * Atomically checks quota and creates container in a transaction.
   *
   * Prevents race conditions where multiple concurrent requests could bypass quota limits.
   * Uses row-level locking (FOR UPDATE) to ensure atomicity.
   */
  async createWithQuotaCheck(data: NewContainer, transaction?: Database): Promise<Container> {
    const result = await this.createWithQuotaAndOptionalProjectIntent(data, false, transaction);
    return result.container;
  }

  /**
   * Atomically admits one active `(organization_id, project_name)` intent.
   *
   * The organization row lock is shared with quota enforcement, so a replica
   * preflight can never authorize a second provider-bound create. A retry sees
   * the primary row and returns it without consuming quota or inserting again.
   */
  async createWithProjectIntentAndQuotaCheck(
    data: NewContainer,
    transaction?: Database,
  ): Promise<ContainerProjectIntentResult> {
    return await this.createWithQuotaAndOptionalProjectIntent(data, true, transaction);
  }

  private async createWithQuotaAndOptionalProjectIntent(
    data: NewContainer,
    enforceProjectIntent: boolean,
    transaction?: Database,
  ): Promise<ContainerProjectIntentResult> {
    const executeInTransaction = async (tx: Database) => {
      // 1. Lock the organization row to prevent concurrent quota checks
      const [org] = await tx
        .select({
          id: organizations.id,
          credit_balance: organizations.credit_balance,
        })
        .from(organizations)
        .where(eq(organizations.id, data.organization_id))
        .for("update"); // FOR UPDATE locks the row

      if (!org) {
        throw new Error("Organization not found");
      }

      if (enforceProjectIntent) {
        const [existing] = await tx
          .select()
          .from(containers)
          .where(
            and(
              eq(containers.organization_id, data.organization_id),
              eq(containers.project_name, data.project_name),
              notInArray(containers.status, ["stopped", "failed", "deleting", "deleted"]),
            ),
          )
          .orderBy(desc(containers.created_at))
          .limit(1);
        if (existing) {
          return {
            container: await hydrateContainerDeploymentLog(existing),
            created: false,
          };
        }
      }

      // Get organization config for settings
      const config = await tx.query.organizationConfig.findFirst({
        where: eq(organizationConfig.organization_id, data.organization_id),
      });

      // 2. Count active containers (excluding deleting/deleted status)
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(containers)
        .where(
          and(
            eq(containers.organization_id, data.organization_id),
            notInArray(containers.status, ["deleting", "deleted"]),
          ),
        );

      // 3. Get max allowed containers for this org.
      // error-policy:J4 — fail closed on a corrupt `credit_balance` NUMERIC so a
      // migration artifact / manual DB edit cannot silently drop a paying org
      // into the FREE quota tier. The throw propagates out of the FOR UPDATE
      // transaction, rolling back atomically (no container row is created).
      const maxContainers = resolveContainerLimitFromDatabaseSources(
        org.credit_balance,
        config?.settings,
      ).limit;

      // 4. Check quota
      if (count >= maxContainers) {
        throw new QuotaExceededError(
          `Container quota exceeded. Current: ${count}, Max: ${maxContainers}`,
          count,
          maxContainers,
        );
      }

      const id = data.id ?? randomUUID();
      const createdAt = data.created_at ?? new Date();
      const insertCandidate: NewContainer = {
        ...data,
        id,
        created_at: createdAt,
      };
      const insertData = await prepareContainerInsertPayload(insertCandidate, {
        id,
        organization_id: data.organization_id,
        created_at: createdAt,
      });

      // 5. Create the container. NOTE: there is NO unique constraint on
      //    `containers.name` — each deploy inserts a fresh row and the
      //    deterministic `app-<id>` name is reused across rows. Consumers that
      //    key on name (e.g. the orphan reconciler) must handle >1 row per name.
      const values: NewContainer = {
        ...insertData,
        status: "pending",
        created_at: createdAt,
        updated_at: new Date(),
      };

      const [container] = await tx.insert(containers).values(values).returning();

      return {
        container: await hydrateContainerDeploymentLog(container),
        created: true,
      };
    };

    // Use external transaction if provided, otherwise create new one
    if (transaction) {
      return await executeInTransaction(transaction);
    } else {
      return await dbWrite.transaction(executeInTransaction);
    }
  }

  /**
   * Creates a container with quota check and credit deduction in a single transaction.
   */
  async createContainerWithCreditDeduction(
    containerData: NewContainer,
    userId: string,
    deploymentCost: number,
  ): Promise<{ container: Container; newBalance: number }> {
    return await dbWrite.transaction(async (tx) => {
      // Create container with quota check
      const container = await this.createWithQuotaCheck(containerData, tx as typeof dbWrite);

      // Check and deduct credits
      const org = await tx.query.organizations.findFirst({
        where: eq(organizations.id, containerData.organization_id),
      });

      if (!org) {
        throw new Error("Organization not found");
      }

      // error-policy:J1 — money-out spend gate. Read the balance fail-closed:
      // a corrupt `credit_balance` NUMERIC (`'NaN'::numeric`) through a bare
      // `Number(...)` becomes NaN, and `NaN < deploymentCost` is FALSE, so the
      // insufficient-balance guard is BYPASSED — the container deploys FREE and
      // `String(NaN - cost)` = "NaN" is written back, permanently poisoning the
      // balance column. Throwing here (still inside the dbWrite.transaction)
      // rolls the whole deploy+debit back atomically instead of authorizing an
      // unbacked deployment against an unreadable balance.
      const currentBalance = parseOrganizationCreditBalance(org.credit_balance, "credit_balance");

      if (currentBalance < deploymentCost) {
        throw new Error(
          `Insufficient balance. Required: $${deploymentCost.toFixed(2)}, Available: $${currentBalance.toFixed(2)}`,
        );
      }

      const newBalance = currentBalance - deploymentCost;

      await tx
        .update(organizations)
        .set({
          credit_balance: String(newBalance),
          updated_at: new Date(),
        })
        .where(eq(organizations.id, containerData.organization_id));

      await tx.insert(creditTransactions).values({
        organization_id: containerData.organization_id,
        user_id: userId,
        amount: String(-deploymentCost),
        type: "debit",
        description: `Container deployment: ${containerData.name}`,
        created_at: new Date(),
      });

      return { container, newBalance };
    });
  }
}

/**
 * Singleton instance of ContainersRepository.
 */
export const containersRepository = new ContainersRepository();
