/**
 * Persists one durable envelope for each logical agent-billing sweep. The
 * per-sandbox debit receipts remain owned by `agent-billing.ts`; this module
 * only claims invocation identity and records aggregate terminal outcomes.
 */

import { ElizaError } from "@elizaos/core/edge";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type AgentBillingRun,
  type AgentBillingRunErrorSample,
  type AgentBillingRunItem,
  type AgentBillingRunItemAction,
  type AgentBillingRunStatus,
  type AgentBillingRunTrigger,
  agentBillingRunItems,
  agentBillingRuns,
} from "../schemas/compute-billing";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_ERROR_SAMPLES = 20;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const MAX_INVOCATION_KEY_LENGTH = 512;

export interface StartAgentBillingRunInput {
  invocationKey: string;
  triggerKind: AgentBillingRunTrigger;
  schedule: string | null;
  scheduledAt: Date | null;
  leaseDurationMs: number;
}

export interface CompleteAgentBillingRunInput {
  status: Exclude<AgentBillingRunStatus, "started">;
  sandboxesProcessed: number;
  sandboxesBilled: number;
  warningsSent: number;
  sandboxesShutdown: number;
  errors: number;
  totalRevenue: string;
  errorSamples: AgentBillingRunErrorSample[];
}

export interface StartAgentBillingRunResult {
  run: AgentBillingRun;
  claimed: boolean;
  recovered: boolean;
  leaseToken: string | null;
}

export interface AgentBillingRunLeaseAuthority {
  runId: string;
  leaseToken: string;
}

export interface RecordAgentBillingRunItemInput {
  sandboxId: string;
  organizationId: string;
  agentName: string;
  action: AgentBillingRunItemAction;
  amountDecimal?: string;
  newBalanceDecimal?: string;
  transactionId?: string;
  detailCode?: string;
  detailMessage?: string;
  completedAt: Date;
}

export interface CompleteAgentBillingRunResult {
  run: AgentBillingRun;
  completedByCaller: boolean;
  terminalReplay: boolean;
}

function invalidRunInput(message: string): ElizaError {
  return new ElizaError(message, {
    code: "INVALID_AGENT_BILLING_RUN_INPUT",
    severity: "fatal",
  });
}

function boundedNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw invalidRunInput(`${field} must be a non-negative 32-bit integer`);
  }
  return value;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidRunInput(`${field} must be a valid Date`);
  }
  return value;
}

function validLeaseToken(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidRunInput("leaseToken must be a UUID");
  }
  return value;
}

function leaseLostError(): ElizaError {
  return new ElizaError("Agent billing run lease was lost", {
    code: "AGENT_BILLING_RUN_LEASE_LOST",
    severity: "fatal",
  });
}

function validLeaseDurationMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 86_400_000) {
    throw invalidRunInput("leaseDurationMs must be an integer between 10ms and one day");
  }
  return value;
}

function canonicalRevenue(value: string): string {
  if (!/^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) {
    throw invalidRunInput("totalRevenue must be a canonical non-negative decimal");
  }
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

function boundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw invalidRunInput(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function boundedErrorSamples(samples: AgentBillingRunErrorSample[]): AgentBillingRunErrorSample[] {
  return samples.slice(0, MAX_ERROR_SAMPLES).map((sample) => ({
    code: boundedText(sample.code, "error sample code", MAX_ERROR_CODE_LENGTH),
    message: boundedText(sample.message, "error sample message", MAX_ERROR_MESSAGE_LENGTH),
    ...(sample.sandboxId
      ? {
          sandboxId: boundedText(sample.sandboxId, "error sample sandbox id", 64),
        }
      : {}),
  }));
}

function normalizeRunItem(input: RecordAgentBillingRunItemInput) {
  const action = input.action;
  const amount = input.amountDecimal ? canonicalRevenue(input.amountDecimal) : "0.000000";
  const newBalance = input.newBalanceDecimal ? canonicalRevenue(input.newBalanceDecimal) : null;
  const transactionId = input.transactionId
    ? boundedText(input.transactionId, "transactionId", 128)
    : null;
  const detailCode = input.detailCode
    ? boundedText(input.detailCode, "detailCode", MAX_ERROR_CODE_LENGTH)
    : null;
  const detailMessage = input.detailMessage
    ? boundedText(input.detailMessage, "detailMessage", MAX_ERROR_MESSAGE_LENGTH)
    : null;
  if (
    (action === "billed" && (!transactionId || newBalance === null)) ||
    (action !== "billed" &&
      (amount !== "0.000000" || transactionId !== null || newBalance !== null)) ||
    (action === "error" && (!detailCode || !detailMessage))
  ) {
    throw invalidRunInput("run item evidence does not match its action");
  }
  return {
    sandbox_id: input.sandboxId,
    organization_id: input.organizationId,
    agent_name: boundedText(input.agentName, "agentName", 240),
    action,
    amount,
    new_balance: newBalance,
    transaction_id: transactionId,
    detail_code: detailCode,
    detail_message: detailMessage,
    completed_at: validDate(input.completedAt, "item completedAt"),
  };
}

export async function assertAgentBillingRunLeaseInTransaction(
  tx: DbTransaction,
  authority: AgentBillingRunLeaseAuthority,
): Promise<AgentBillingRun> {
  const leaseToken = validLeaseToken(authority.leaseToken);
  const [run] = await tx
    .select()
    .from(agentBillingRuns)
    .where(eq(agentBillingRuns.id, authority.runId))
    .for("update")
    .limit(1);
  const databaseNow = await readPostLockDatabaseNow(tx);
  if (
    !run ||
    run.status !== "started" ||
    run.lease_token !== leaseToken ||
    !run.lease_expires_at ||
    run.lease_expires_at.getTime() <= databaseNow.getTime()
  ) {
    throw leaseLostError();
  }
  return run;
}

export async function recordAgentBillingRunItemInTransaction(
  tx: DbTransaction,
  authority: AgentBillingRunLeaseAuthority,
  input: RecordAgentBillingRunItemInput,
): Promise<{ item: AgentBillingRunItem; created: boolean }> {
  await assertAgentBillingRunLeaseInTransaction(tx, authority);
  const normalized = normalizeRunItem(input);
  const [created] = await tx
    .insert(agentBillingRunItems)
    .values({ run_id: authority.runId, ...normalized })
    .onConflictDoNothing({
      target: [agentBillingRunItems.run_id, agentBillingRunItems.sandbox_id],
    })
    .returning();
  if (created) return { item: created, created: true };
  const [existing] = await tx
    .select()
    .from(agentBillingRunItems)
    .where(
      and(
        eq(agentBillingRunItems.run_id, authority.runId),
        eq(agentBillingRunItems.sandbox_id, normalized.sandbox_id),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new ElizaError("Agent billing run item claim could not be reconstructed", {
      code: "AGENT_BILLING_RUN_ITEM_CLAIM_LOST",
      severity: "fatal",
    });
  }
  return { item: existing, created: false };
}

function normalizeCompletion(input: CompleteAgentBillingRunInput) {
  const sandboxesProcessed = boundedNonNegativeInteger(
    input.sandboxesProcessed,
    "sandboxesProcessed",
  );
  const sandboxesBilled = boundedNonNegativeInteger(input.sandboxesBilled, "sandboxesBilled");
  const warningsSent = boundedNonNegativeInteger(input.warningsSent, "warningsSent");
  const sandboxesShutdown = boundedNonNegativeInteger(input.sandboxesShutdown, "sandboxesShutdown");
  const errors = boundedNonNegativeInteger(input.errors, "errors");
  const totalRevenue = canonicalRevenue(input.totalRevenue);
  const completedActions = sandboxesBilled + warningsSent + sandboxesShutdown;
  if (completedActions > sandboxesProcessed) {
    throw invalidRunInput("outcome counters cannot exceed sandboxesProcessed");
  }
  if (
    (input.status === "empty" &&
      (sandboxesProcessed !== 0 ||
        sandboxesBilled !== 0 ||
        warningsSent !== 0 ||
        sandboxesShutdown !== 0 ||
        errors !== 0 ||
        totalRevenue !== "0.000000")) ||
    (input.status === "succeeded" && (sandboxesProcessed === 0 || errors !== 0)) ||
    (input.status === "partial_failure" &&
      (errors === 0 ||
        sandboxesProcessed <= errors ||
        completedActions + errors > sandboxesProcessed)) ||
    (input.status === "failed" && errors === 0)
  ) {
    throw invalidRunInput("terminal status does not match its outcome counters");
  }
  return {
    status: input.status,
    sandboxes_processed: sandboxesProcessed,
    sandboxes_billed: sandboxesBilled,
    warnings_sent: warningsSent,
    sandboxes_shutdown: sandboxesShutdown,
    errors,
    total_revenue: totalRevenue,
    error_samples: boundedErrorSamples(input.errorSamples),
  };
}

export class AgentBillingRunRepository {
  async startOrLoad(input: StartAgentBillingRunInput): Promise<StartAgentBillingRunResult> {
    const invocationKey = boundedText(
      input.invocationKey,
      "invocationKey",
      MAX_INVOCATION_KEY_LENGTH,
    );
    const leaseDurationMs = validLeaseDurationMs(input.leaseDurationMs);
    const leaseToken = crypto.randomUUID();
    const schedule = input.schedule === null ? null : boundedText(input.schedule, "schedule", 64);
    const scheduledAt =
      input.scheduledAt === null ? null : validDate(input.scheduledAt, "scheduledAt");
    const validScheduledIdentity =
      input.triggerKind === "scheduled" && schedule !== null && scheduledAt !== null;
    const validManualIdentity =
      input.triggerKind === "manual" && input.schedule === null && input.scheduledAt === null;
    if (!validScheduledIdentity && !validManualIdentity) {
      throw invalidRunInput("trigger metadata does not match triggerKind");
    }

    return dbWrite.transaction(async (tx) => {
      let [existing] = await tx
        .select()
        .from(agentBillingRuns)
        .where(eq(agentBillingRuns.invocation_key, invocationKey))
        .for("update")
        .limit(1);
      let databaseNow = existing ? await readPostLockDatabaseNow(tx) : null;

      if (!existing) {
        const [created] = await tx
          .insert(agentBillingRuns)
          .values({
            invocation_key: invocationKey,
            trigger_kind: input.triggerKind,
            schedule,
            scheduled_at: scheduledAt,
            started_at: sql`date_trunc('milliseconds', clock_timestamp())`,
            billing_cutoff_at: sql`date_trunc('milliseconds', clock_timestamp())`,
            lease_token: leaseToken,
            lease_expires_at: sql`date_trunc('milliseconds', clock_timestamp()) + ${leaseDurationMs} * INTERVAL '1 millisecond'`,
            created_at: sql`date_trunc('milliseconds', clock_timestamp())`,
            updated_at: sql`date_trunc('milliseconds', clock_timestamp())`,
          })
          .onConflictDoNothing({ target: agentBillingRuns.invocation_key })
          .returning();
        if (created) {
          return {
            run: created,
            claimed: true,
            recovered: false,
            leaseToken,
          };
        }

        [existing] = await tx
          .select()
          .from(agentBillingRuns)
          .where(eq(agentBillingRuns.invocation_key, invocationKey))
          .for("update")
          .limit(1);
        databaseNow = await readPostLockDatabaseNow(tx);
      }

      if (!existing || !databaseNow) {
        throw new ElizaError("Agent billing run claim could not be reconstructed", {
          code: "AGENT_BILLING_RUN_CLAIM_LOST",
          severity: "fatal",
        });
      }
      if (
        existing.trigger_kind !== input.triggerKind ||
        existing.schedule !== schedule ||
        (existing.scheduled_at?.getTime() ?? null) !== (scheduledAt?.getTime() ?? null)
      ) {
        throw new ElizaError("Agent billing run identity metadata conflicts", {
          code: "AGENT_BILLING_RUN_IDENTITY_CONFLICT",
          severity: "fatal",
        });
      }

      if (
        existing.status === "started" &&
        (!existing.lease_expires_at || existing.lease_expires_at.getTime() <= databaseNow.getTime())
      ) {
        const leaseExpiresAt = new Date(databaseNow.getTime() + leaseDurationMs);
        const [recovered] = await tx
          .update(agentBillingRuns)
          .set({
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
            attempt_count: sql`${agentBillingRuns.attempt_count} + 1`,
            updated_at: databaseNow,
          })
          .where(
            and(
              eq(agentBillingRuns.id, existing.id),
              eq(agentBillingRuns.status, "started"),
              eq(agentBillingRuns.lease_token, existing.lease_token),
            ),
          )
          .returning();
        if (!recovered) {
          throw new ElizaError("Agent billing run recovery CAS was lost", {
            code: "AGENT_BILLING_RUN_CLAIM_LOST",
            severity: "fatal",
          });
        }
        return {
          run: recovered,
          claimed: true,
          recovered: true,
          leaseToken,
        };
      }

      return {
        run: existing,
        claimed: false,
        recovered: false,
        leaseToken: null,
      };
    });
  }

  async findByInvocationKey(invocationKey: string): Promise<AgentBillingRun | null> {
    const normalizedKey = boundedText(invocationKey, "invocationKey", MAX_INVOCATION_KEY_LENGTH);
    const [run] = await dbWrite
      .select()
      .from(agentBillingRuns)
      .where(eq(agentBillingRuns.invocation_key, normalizedKey))
      .limit(1);
    return run ?? null;
  }

  async listItems(runId: string): Promise<AgentBillingRunItem[]> {
    return dbWrite
      .select()
      .from(agentBillingRunItems)
      .where(eq(agentBillingRunItems.run_id, runId))
      .orderBy(asc(agentBillingRunItems.completed_at), asc(agentBillingRunItems.id));
  }

  async recordItem(
    authority: AgentBillingRunLeaseAuthority,
    input: RecordAgentBillingRunItemInput,
  ): Promise<{ item: AgentBillingRunItem; created: boolean }> {
    return dbWrite.transaction((tx) =>
      recordAgentBillingRunItemInTransaction(tx, authority, input),
    );
  }

  async renewLease(
    runId: string,
    leaseTokenInput: string,
    leaseDurationMsInput: number,
  ): Promise<AgentBillingRun> {
    const leaseToken = validLeaseToken(leaseTokenInput);
    const leaseDurationMs = validLeaseDurationMs(leaseDurationMsInput);
    return dbWrite.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(agentBillingRuns)
        .where(eq(agentBillingRuns.id, runId))
        .for("update")
        .limit(1);
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (
        !existing ||
        existing.status !== "started" ||
        existing.lease_token !== leaseToken ||
        !existing.lease_expires_at ||
        existing.lease_expires_at.getTime() <= databaseNow.getTime()
      ) {
        throw leaseLostError();
      }
      const leaseExpiresAt = new Date(databaseNow.getTime() + leaseDurationMs);
      const [renewed] = await tx
        .update(agentBillingRuns)
        .set({ lease_expires_at: leaseExpiresAt, updated_at: databaseNow })
        .where(
          and(
            eq(agentBillingRuns.id, existing.id),
            eq(agentBillingRuns.status, "started"),
            eq(agentBillingRuns.lease_token, leaseToken),
            gt(agentBillingRuns.lease_expires_at, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!renewed) throw leaseLostError();
      return renewed;
    });
  }

  async complete(
    runId: string,
    leaseTokenInput: string,
    input: CompleteAgentBillingRunInput,
  ): Promise<CompleteAgentBillingRunResult> {
    const leaseToken = validLeaseToken(leaseTokenInput);
    return dbWrite.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(agentBillingRuns)
        .where(eq(agentBillingRuns.id, runId))
        .for("update")
        .limit(1);
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (!existing) {
        throw new ElizaError("Agent billing run receipt disappeared before completion", {
          code: "AGENT_BILLING_RUN_RECEIPT_MISSING",
          severity: "fatal",
        });
      }
      if (existing.status !== "started") {
        return {
          run: existing,
          completedByCaller: false,
          terminalReplay: true,
        };
      }
      if (
        existing.lease_token !== leaseToken ||
        !existing.lease_expires_at ||
        existing.lease_expires_at.getTime() <= databaseNow.getTime()
      ) {
        throw leaseLostError();
      }

      const completion = normalizeCompletion(input);
      if (databaseNow.getTime() < existing.started_at.getTime()) {
        throw new ElizaError("Primary database clock preceded the billing run start", {
          code: "AGENT_BILLING_RUN_DATABASE_CLOCK_INVALID",
          severity: "fatal",
        });
      }
      const [completed] = await tx
        .update(agentBillingRuns)
        .set({
          ...completion,
          completed_at: databaseNow,
          duration_ms: sql`floor(extract(epoch from
            (${databaseNow}::timestamptz - ${agentBillingRuns.started_at})) * 1000)::bigint`,
          lease_expires_at: null,
          updated_at: databaseNow,
        })
        .where(
          and(
            eq(agentBillingRuns.id, existing.id),
            eq(agentBillingRuns.status, "started"),
            eq(agentBillingRuns.lease_token, leaseToken),
            gt(agentBillingRuns.lease_expires_at, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!completed) throw leaseLostError();
      return {
        run: completed,
        completedByCaller: true,
        terminalReplay: false,
      };
    });
  }
}

export const agentBillingRunRepository = new AgentBillingRunRepository();
