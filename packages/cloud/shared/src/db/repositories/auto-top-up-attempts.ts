/**
 * Owns the transactional auto-top-up attempt ledger: eligibility is rechecked
 * under the organization row lock, provider work is protected by expiring
 * lease tokens, and successful charges are atomically applied and linked while
 * the attempt remains recoverable. A separate fenced terminal transition runs
 * only after cache invalidation. Monetary inputs and outputs remain exact
 * integer cents or canonical Postgres decimal strings throughout this module.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, gt, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { dbWrite } from "../client";
import {
  type AutoTopUpAttemptRow,
  type AutoTopUpAttemptStatus,
  type AutoTopUpControlMode,
  type AutoTopUpControlRow,
  type AutoTopUpLegacyPaymentQuarantineRow,
  type AutoTopUpLegacyQuarantineStatus,
  type AutoTopUpTriggerSource,
  autoTopUpAttempts,
  autoTopUpControl,
  autoTopUpLegacyPaymentQuarantine,
} from "../schemas/auto-top-up-attempts";
import { creditTransactions } from "../schemas/credit-transactions";
import { organizations } from "../schemas/organizations";

export const AUTO_TOP_UP_ATTEMPT_INVALID_INPUT = "AUTO_TOP_UP_ATTEMPT_INVALID_INPUT";
export const AUTO_TOP_UP_ATTEMPT_INVARIANT_VIOLATION = "AUTO_TOP_UP_ATTEMPT_INVARIANT_VIOLATION";

const BLOCKING_STATUSES: AutoTopUpAttemptStatus[] = [
  "claimed",
  "payment_pending",
  "payment_succeeded",
  "manual_review",
];
const CLAIMABLE_STATUSES: AutoTopUpAttemptStatus[] = [
  "claimed",
  "payment_pending",
  "payment_succeeded",
];
const MIN_AUTO_TOP_UP_CENTS = 100;
const MAX_AUTO_TOP_UP_CENTS = 100_000;
const MAX_AUTO_TOP_UP_CHARGE_CENTS = 1_120_000;
const MAX_DUE_LIMIT = 100;
const TERMINAL_LEGACY_PROVIDER_STATUSES = new Set(["succeeded", "canceled"]);
const TRIGGER_SOURCES = new Set<AutoTopUpTriggerSource>([
  "cron",
  "credit_deduction",
  "manual",
  "recovery",
]);

export interface AutoTopUpAttempt {
  id: string;
  organizationId: string;
  triggerSource: AutoTopUpTriggerSource;
  status: AutoTopUpAttemptStatus;
  creditAmountCents: number;
  chargeAmountCents: number;
  currency: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  requestMetadata: Record<string, unknown>;
  idempotencyKey: string;
  stripePaymentIntentId: string | null;
  creditTransactionId: string | null;
  coveredBalanceDecreaseRevision: number | null;
  providerStatus: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  providerRequestStartedAt: Date | null;
  recoveryDeadlineAt: Date | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  paymentSucceededAt: Date | null;
  creditedAt: Date | null;
  canceledAt: Date | null;
  manualReviewAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutoTopUpControl {
  mode: AutoTopUpControlMode;
  pausedAt: Date;
  legacyReconciledThrough: Date | null;
}

export type AutoTopUpControlTransitionBlockedReason =
  | "mode_mismatch"
  | "legacy_not_reconciled"
  | "future_reconciliation_watermark"
  | "blocking_attempts"
  | "legacy_quarantine"
  | "enabled_manual_review";

export interface TransitionAutoTopUpControlInput {
  expectedMode: AutoTopUpControlMode;
  targetMode: AutoTopUpControlMode;
  now: Date;
  legacyReconciledThrough?: Date;
}

export type TransitionAutoTopUpControlResult =
  | { outcome: "applied"; control: AutoTopUpControl }
  | {
      outcome: "not_applied";
      reason: AutoTopUpControlTransitionBlockedReason;
      control: AutoTopUpControl;
    };

export interface AutoTopUpLegacyPaymentQuarantine {
  id: string;
  organizationId: string;
  stripePaymentIntentId: string;
  providerStatus: string;
  creditAmountCents: number;
  status: AutoTopUpLegacyQuarantineStatus;
  creditTransactionId: string | null;
  metadata: Record<string, unknown>;
  discoveredAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
}

export interface QuarantineLegacyPaymentIntentInput {
  organizationId: string;
  paymentIntentId: string;
  providerStatus: string;
  creditAmountCents: number;
  metadata: Record<string, unknown>;
  now: Date;
}

export interface ResolveLegacyPaymentIntentInput {
  paymentIntentId: string;
  resolution: Exclude<AutoTopUpLegacyQuarantineStatus, "unresolved">;
  metadata: Record<string, unknown>;
  now: Date;
}

export interface ClaimEligibleAttemptInput {
  organizationId: string;
  triggerSource: AutoTopUpTriggerSource;
  attemptId: string;
  idempotencyKey: string;
  now: Date;
}

export type AutoTopUpNotEligibleReason =
  | "cutover_paused"
  | "legacy_payment_unresolved"
  | "not_found"
  | "disabled"
  | "balance_at_or_above_threshold"
  | "missing_customer"
  | "unverified_customer_authority"
  | "missing_payment_method"
  | "invalid_balance"
  | "invalid_threshold"
  | "invalid_amount"
  | "balance_not_rearmed";

export type ClaimEligibleAttemptResult =
  | {
      outcome: "created" | "reused";
      attempt: AutoTopUpAttempt;
    }
  | {
      outcome: "not_eligible";
      organizationId: string;
      reason: AutoTopUpNotEligibleReason;
      currentBalanceCents?: number;
      thresholdCents?: number;
    };

export interface ClaimDueLeaseInput {
  attemptId: string;
  leaseToken: string;
  now: Date;
  leaseExpiresAt: Date;
}

export interface FinalizeAutoTopUpRequestInput {
  attemptId: string;
  leaseToken: string;
  chargeAmountCents: number;
  requestMetadata: Record<string, unknown>;
  now: Date;
}

export interface MarkProviderRequestStartedInput {
  attemptId: string;
  leaseToken: string;
  now: Date;
  recoveryDeadlineAt: Date;
}

export type AuthorizeAutoTopUpProviderRequestResult =
  | { outcome: "authorized"; attempt: AutoTopUpAttempt }
  | { outcome: "rejected"; attempt: AutoTopUpAttempt }
  | { outcome: "fence_lost" };

export interface RecordPaymentIntentInput {
  attemptId: string;
  leaseToken: string;
  paymentIntentId: string;
  providerStatus: string;
  result: Record<string, unknown>;
  now: Date;
}

export interface RecordAutoTopUpFailureInput {
  attemptId: string;
  leaseToken: string;
  error: string;
  result?: Record<string, unknown>;
  nextAttemptAt: Date;
  now: Date;
}

export interface MarkAutoTopUpTerminalInput {
  attemptId: string;
  leaseToken: string;
  error: string;
  result?: Record<string, unknown>;
  now: Date;
}

export interface ReopenManualReviewForSucceededPaymentInput {
  attemptId: string;
  paymentIntentId: string;
  result: Record<string, unknown>;
  now: Date;
}

export interface ListDueAutoTopUpAttemptsInput {
  now: Date;
  limit: number;
}

export type SettleSucceededAttemptResult =
  | {
      outcome: "applied" | "already_applied";
      attempt: AutoTopUpAttempt;
      creditTransactionId: string;
      newBalance: string;
    }
  | {
      outcome: "manual_review";
      attempt: AutoTopUpAttempt;
    };

export interface MarkAutoTopUpCreditedInput {
  attemptId: string;
  leaseToken: string;
  now: Date;
}

function invalidInput(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: AUTO_TOP_UP_ATTEMPT_INVALID_INPUT,
    context,
  });
}

function invariantViolation(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: AUTO_TOP_UP_ATTEMPT_INVARIANT_VIOLATION,
    context,
    severity: "fatal",
  });
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidInput("Auto-top-up attempt date is invalid", { field });
  }
}

function requiredString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    invalidInput("Auto-top-up attempt string is missing or non-canonical", { field });
  }
  return value;
}

function jsonObject(value: Record<string, unknown>, field: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    invalidInput("Auto-top-up attempt JSON value must be a plain object", { field });
  }
  try {
    JSON.stringify(value);
  } catch (cause) {
    // error-policy:J2 Preserve the serialization cause in the typed repository failure.
    throw new ElizaError("Auto-top-up attempt JSON value is not serializable", {
      code: AUTO_TOP_UP_ATTEMPT_INVALID_INPUT,
      cause,
      context: { field },
    });
  }
  return value;
}

function safeIntegerCents(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidInput("Auto-top-up cents must be a positive safe integer", { field });
  }
  return value;
}

function canonicalNonNegativeDecimal(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function canonicalSignedDecimal(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

function exactCentsFromDecimal(raw: unknown): number | null {
  const value = canonicalNonNegativeDecimal(raw);
  if (!value) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(2).replaceAll("0", "").length > 0) return null;
  const cents = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function exactSignedCentsFromDecimal(raw: unknown): number | null {
  const value = canonicalSignedDecimal(raw);
  if (!value) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const cents = exactCentsFromDecimal(unsigned);
  return cents === null ? null : negative ? -cents : cents;
}

function toAttempt(row: AutoTopUpAttemptRow): AutoTopUpAttempt {
  const creditAmountCents = safeIntegerCents(row.credit_amount_cents, "credit_amount_cents");
  const chargeAmountCents = safeIntegerCents(row.charge_amount_cents, "charge_amount_cents");
  if (chargeAmountCents < creditAmountCents) {
    invariantViolation("Auto-top-up charge is smaller than its credit amount", {
      attemptId: row.id,
    });
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    triggerSource: row.trigger_source,
    status: row.status,
    creditAmountCents,
    chargeAmountCents,
    currency: row.currency,
    stripeCustomerId: row.stripe_customer_id_snapshot,
    stripePaymentMethodId: row.stripe_payment_method_id_snapshot,
    requestMetadata: row.request_metadata,
    idempotencyKey: row.idempotency_key,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    creditTransactionId: row.credit_transaction_id,
    coveredBalanceDecreaseRevision: row.covered_balance_decrease_revision,
    providerStatus: row.provider_status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    providerRequestStartedAt: row.provider_request_started_at,
    recoveryDeadlineAt: row.recovery_deadline_at,
    lastError: row.last_error,
    result: row.result,
    paymentSucceededAt: row.payment_succeeded_at,
    creditedAt: row.credited_at,
    canceledAt: row.canceled_at,
    manualReviewAt: row.manual_review_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toControl(row: AutoTopUpControlRow): AutoTopUpControl {
  return {
    mode: row.mode,
    pausedAt: row.paused_at,
    legacyReconciledThrough: row.legacy_reconciled_through,
  };
}

function toLegacyQuarantine(
  row: AutoTopUpLegacyPaymentQuarantineRow,
): AutoTopUpLegacyPaymentQuarantine {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    providerStatus: row.provider_status,
    creditAmountCents: safeIntegerCents(row.credit_amount_cents, "credit_amount_cents"),
    status: row.status,
    creditTransactionId: row.credit_transaction_id,
    metadata: row.metadata,
    discoveredAt: row.discovered_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function notEligible(
  organizationId: string,
  reason: AutoTopUpNotEligibleReason,
  amounts?: { currentBalanceCents?: number; thresholdCents?: number },
): ClaimEligibleAttemptResult {
  return { outcome: "not_eligible", organizationId, reason, ...amounts };
}

function assertLeaseWindow(now: Date, leaseExpiresAt: Date): void {
  assertDate(now, "now");
  assertDate(leaseExpiresAt, "leaseExpiresAt");
  if (leaseExpiresAt.getTime() <= now.getTime()) {
    invalidInput("Auto-top-up lease must expire after its claim time", {
      field: "leaseExpiresAt",
    });
  }
}

/** Primary-only CQRS repository; recovery reads intentionally never use a lagging replica. */
export class AutoTopUpAttemptsRepository {
  /**
   * Primary-read provider-I/O hint. Eligibility is still rechecked under lock
   * by claimEligibleAttempt; false-to-true races fail closed in its authority guard.
   */
  async customerReconciliationMayBeNeeded(organizationId: string): Promise<boolean> {
    requiredString(organizationId, "organizationId");
    const [row] = await dbWrite
      .select({
        eligible: sql<boolean>`${organizations.is_active} = true
          AND ${organizations.auto_top_up_enabled} = true
          AND ${organizations.credit_balance} < ${organizations.auto_top_up_threshold}
          AND ${organizations.auto_top_up_threshold} BETWEEN 0 AND 1000
          AND ${organizations.auto_top_up_amount} BETWEEN 1 AND 1000
          AND ${organizations.stripe_default_payment_method} IS NOT NULL`,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return row?.eligible === true;
  }

  /**
   * Primary-read hint for recovery. The database trigger repeats this check at
   * each attempt mutation, so a false-to-true race cannot authorize provider work.
   */
  async customerSnapshotHasAuthority(attemptId: string): Promise<boolean> {
    requiredString(attemptId, "attemptId");
    const result = await dbWrite.execute(sql`
      SELECT "stripe_customer_binding_is_authoritative"(
        "organization_id", "stripe_customer_id_snapshot"
      ) AS authoritative
      FROM "auto_top_up_attempts" WHERE "id"=${attemptId} LIMIT 1
    `);
    return result.rows[0]?.authoritative === true;
  }

  /**
   * Final provider-I/O fence. It locks the current organization before the
   * attempt, validates exact publication/receipt authority, and either starts
   * or reauthorizes the persisted provider window. Invalid recovery snapshots
   * become durable manual review without calling Stripe.
   */
  async authorizeProviderRequest(
    input: MarkProviderRequestStartedInput,
  ): Promise<AuthorizeAutoTopUpProviderRequestResult> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertLeaseWindow(input.now, input.recoveryDeadlineAt);
    const [snapshot] = await dbWrite
      .select({ organizationId: autoTopUpAttempts.organization_id })
      .from(autoTopUpAttempts)
      .where(eq(autoTopUpAttempts.id, input.attemptId))
      .limit(1);
    if (!snapshot) return { outcome: "fence_lost" };

    return dbWrite.transaction(async (tx) => {
      const [organization] = await tx
        .select({ customerId: organizations.stripe_customer_id })
        .from(organizations)
        .where(eq(organizations.id, snapshot.organizationId))
        .for("update")
        .limit(1);
      const [attempt] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (
        !organization ||
        !attempt ||
        attempt.organization_id !== snapshot.organizationId ||
        attempt.lease_token !== input.leaseToken ||
        !attempt.lease_expires_at ||
        attempt.lease_expires_at.getTime() <= input.now.getTime() ||
        attempt.status !== "payment_pending"
      ) {
        return { outcome: "fence_lost" };
      }
      const authority = await tx.execute(sql`
        SELECT "stripe_customer_binding_is_authoritative"(
          ${attempt.organization_id}::uuid, ${attempt.stripe_customer_id_snapshot}::text
        ) AS authoritative
      `);
      if (
        organization.customerId !== attempt.stripe_customer_id_snapshot ||
        authority.rows[0]?.authoritative !== true
      ) {
        const [rejected] = await tx
          .update(autoTopUpAttempts)
          .set({
            status: "manual_review",
            lease_token: null,
            lease_expires_at: null,
            next_attempt_at: null,
            last_error: "Stripe Customer authority changed before provider request",
            manual_review_at: input.now,
            updated_at: input.now,
          })
          .where(
            and(
              eq(autoTopUpAttempts.id, input.attemptId),
              eq(autoTopUpAttempts.lease_token, input.leaseToken),
            ),
          )
          .returning();
        if (!rejected) return { outcome: "fence_lost" };
        return { outcome: "rejected", attempt: toAttempt(rejected) };
      }
      if (!attempt.provider_request_started_at) {
        const [started] = await tx
          .update(autoTopUpAttempts)
          .set({
            provider_request_started_at: input.now,
            recovery_deadline_at: input.recoveryDeadlineAt,
            next_attempt_at: input.now,
            updated_at: input.now,
          })
          .where(
            and(
              eq(autoTopUpAttempts.id, input.attemptId),
              eq(autoTopUpAttempts.lease_token, input.leaseToken),
              isNull(autoTopUpAttempts.provider_request_started_at),
            ),
          )
          .returning();
        return started
          ? { outcome: "authorized", attempt: toAttempt(started) }
          : { outcome: "fence_lost" };
      }
      return { outcome: "authorized", attempt: toAttempt(attempt) };
    });
  }

  /**
   * Read the singleton cutover authority from the primary. Missing state is a
   * fatal migration/configuration error; callers must never infer a mode.
   */
  async getControl(): Promise<AutoTopUpControl> {
    const [row] = await dbWrite
      .select()
      .from(autoTopUpControl)
      .where(eq(autoTopUpControl.singleton, true))
      .limit(1);
    if (!row) invariantViolation("Auto-top-up control row is missing", {});
    return toControl(row);
  }

  /**
   * Compare-and-set the cutover mode under an exclusive singleton lock.
   * Activation and claim acquisition use the same first lock, making the
   * paused/durable boundary linearizable. Pausing never strands recovery:
   * only new claims consult this control row.
   */
  async transitionControl(
    input: TransitionAutoTopUpControlInput,
  ): Promise<TransitionAutoTopUpControlResult> {
    assertDate(input.now, "now");
    if (input.legacyReconciledThrough) {
      assertDate(input.legacyReconciledThrough, "legacyReconciledThrough");
    }
    if (
      (input.expectedMode !== "paused" && input.expectedMode !== "durable") ||
      (input.targetMode !== "paused" && input.targetMode !== "durable") ||
      input.expectedMode === input.targetMode
    ) {
      invalidInput("Auto-top-up control transition is invalid", {
        expectedMode: input.expectedMode,
        targetMode: input.targetMode,
      });
    }

    return dbWrite.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(autoTopUpControl)
        .where(eq(autoTopUpControl.singleton, true))
        .for("update")
        .limit(1);
      if (!locked) invariantViolation("Auto-top-up control row is missing", {});
      const current = toControl(locked);
      if (locked.mode !== input.expectedMode) {
        return { outcome: "not_applied", reason: "mode_mismatch", control: current };
      }

      if (input.targetMode === "paused") {
        const [paused] = await tx
          .update(autoTopUpControl)
          .set({
            mode: "paused",
            paused_at: input.now,
            legacy_reconciled_through: null,
            updated_at: input.now,
          })
          .where(
            and(
              eq(autoTopUpControl.singleton, true),
              eq(autoTopUpControl.mode, input.expectedMode),
            ),
          )
          .returning();
        if (!paused) invariantViolation("Auto-top-up pause CAS lost its control row", {});
        return { outcome: "applied", control: toControl(paused) };
      }

      const reconciledThrough = input.legacyReconciledThrough ?? locked.legacy_reconciled_through;
      if (reconciledThrough && reconciledThrough.getTime() > input.now.getTime()) {
        return {
          outcome: "not_applied",
          reason: "future_reconciliation_watermark",
          control: current,
        };
      }
      if (!reconciledThrough || reconciledThrough.getTime() < locked.paused_at.getTime()) {
        return {
          outcome: "not_applied",
          reason: "legacy_not_reconciled",
          control: current,
        };
      }

      const [blockingAttempt] = await tx
        .select({ id: autoTopUpAttempts.id })
        .from(autoTopUpAttempts)
        .where(
          inArray(autoTopUpAttempts.status, ["claimed", "payment_pending", "payment_succeeded"]),
        )
        .limit(1);
      if (blockingAttempt) {
        return { outcome: "not_applied", reason: "blocking_attempts", control: current };
      }

      const [quarantined] = await tx
        .select({ id: autoTopUpLegacyPaymentQuarantine.id })
        .from(autoTopUpLegacyPaymentQuarantine)
        .where(eq(autoTopUpLegacyPaymentQuarantine.status, "unresolved"))
        .limit(1);
      if (quarantined) {
        return { outcome: "not_applied", reason: "legacy_quarantine", control: current };
      }

      const [enabledLegacyManualReview] = await tx
        .select({ id: autoTopUpLegacyPaymentQuarantine.id })
        .from(autoTopUpLegacyPaymentQuarantine)
        .innerJoin(
          organizations,
          eq(organizations.id, autoTopUpLegacyPaymentQuarantine.organization_id),
        )
        .where(
          and(
            eq(autoTopUpLegacyPaymentQuarantine.status, "manual_review"),
            eq(organizations.auto_top_up_enabled, true),
          ),
        )
        .limit(1);
      if (enabledLegacyManualReview) {
        return { outcome: "not_applied", reason: "legacy_quarantine", control: current };
      }

      const [enabledManualReview] = await tx
        .select({ id: autoTopUpAttempts.id })
        .from(autoTopUpAttempts)
        .innerJoin(organizations, eq(organizations.id, autoTopUpAttempts.organization_id))
        .where(
          and(
            eq(autoTopUpAttempts.status, "manual_review"),
            eq(organizations.auto_top_up_enabled, true),
          ),
        )
        .limit(1);
      if (enabledManualReview) {
        return { outcome: "not_applied", reason: "enabled_manual_review", control: current };
      }

      const [durable] = await tx
        .update(autoTopUpControl)
        .set({
          mode: "durable",
          legacy_reconciled_through: reconciledThrough,
          updated_at: input.now,
        })
        .where(
          and(eq(autoTopUpControl.singleton, true), eq(autoTopUpControl.mode, input.expectedMode)),
        )
        .returning();
      if (!durable) invariantViolation("Auto-top-up activation CAS lost its control row", {});
      return { outcome: "applied", control: toControl(durable) };
    });
  }

  /**
   * Import a newly discovered legacy PaymentIntent only while paused. An exact
   * existing-row replay may still refresh a nonterminal provider status after
   * durable activation; identity and credit amount remain immutable, and this
   * method never starts a provider request.
   */
  async quarantineLegacyPaymentIntent(
    input: QuarantineLegacyPaymentIntentInput,
  ): Promise<AutoTopUpLegacyPaymentQuarantine | null> {
    requiredString(input.organizationId, "organizationId");
    requiredString(input.paymentIntentId, "paymentIntentId");
    requiredString(input.providerStatus, "providerStatus");
    assertDate(input.now, "now");
    const metadata = jsonObject(input.metadata, "metadata");
    const creditAmountCents = safeIntegerCents(input.creditAmountCents, "creditAmountCents");
    if (creditAmountCents < MIN_AUTO_TOP_UP_CENTS || creditAmountCents > MAX_AUTO_TOP_UP_CENTS) {
      invalidInput("Legacy PaymentIntent credit amount is outside its bounded range", {
        creditAmountCents,
      });
    }

    return dbWrite.transaction(async (tx) => {
      // Match lifecycle, claim, and reconciliation: organization -> control ->
      // quarantine. New inserts also take their FK lock only after this row.
      const [lockedOrganization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update")
        .limit(1);
      if (!lockedOrganization) {
        invariantViolation("Legacy PaymentIntent organization is missing", {
          paymentIntentId: input.paymentIntentId,
          organizationId: input.organizationId,
        });
      }

      const [control] = await tx
        .select({ mode: autoTopUpControl.mode })
        .from(autoTopUpControl)
        .where(eq(autoTopUpControl.singleton, true))
        .for("share")
        .limit(1);
      if (!control) invariantViolation("Auto-top-up control row is missing", {});
      let [existing] = await tx
        .select()
        .from(autoTopUpLegacyPaymentQuarantine)
        .where(eq(autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id, input.paymentIntentId))
        .for("update")
        .limit(1);
      if (!existing) {
        if (control.mode !== "paused") return null;
        const [inserted] = await tx
          .insert(autoTopUpLegacyPaymentQuarantine)
          .values({
            organization_id: input.organizationId,
            stripe_payment_intent_id: input.paymentIntentId,
            provider_status: input.providerStatus,
            credit_amount_cents: creditAmountCents,
            status: "unresolved",
            metadata,
            discovered_at: input.now,
            updated_at: input.now,
          })
          .onConflictDoNothing({
            target: autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id,
          })
          .returning();
        if (inserted) return toLegacyQuarantine(inserted);
        [existing] = await tx
          .select()
          .from(autoTopUpLegacyPaymentQuarantine)
          .where(
            eq(autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id, input.paymentIntentId),
          )
          .for("update")
          .limit(1);
      }
      if (!existing) {
        invariantViolation("Legacy PaymentIntent quarantine conflict returned no row", {
          paymentIntentId: input.paymentIntentId,
        });
      }
      if (existing.organization_id !== input.organizationId) {
        invariantViolation("Legacy PaymentIntent belongs to another organization", {
          paymentIntentId: input.paymentIntentId,
          organizationId: input.organizationId,
        });
      }
      if (existing.credit_amount_cents !== creditAmountCents) {
        invariantViolation("Legacy PaymentIntent snapshot conflicts with its quarantine", {
          paymentIntentId: input.paymentIntentId,
          organizationId: input.organizationId,
        });
      }
      if (existing.provider_status === input.providerStatus) return toLegacyQuarantine(existing);
      if (
        existing.status === "credited" ||
        existing.status === "canceled" ||
        TERMINAL_LEGACY_PROVIDER_STATUSES.has(existing.provider_status)
      ) {
        invariantViolation("Legacy PaymentIntent terminal status cannot be rewritten", {
          paymentIntentId: input.paymentIntentId,
          providerStatus: existing.provider_status,
          requestedProviderStatus: input.providerStatus,
        });
      }

      const [refreshed] = await tx
        .update(autoTopUpLegacyPaymentQuarantine)
        .set({
          provider_status: input.providerStatus,
          metadata,
          updated_at: input.now,
        })
        .where(
          and(
            eq(autoTopUpLegacyPaymentQuarantine.id, existing.id),
            eq(autoTopUpLegacyPaymentQuarantine.provider_status, existing.provider_status),
            inArray(autoTopUpLegacyPaymentQuarantine.status, ["unresolved", "manual_review"]),
          ),
        )
        .returning();
      if (!refreshed) {
        invariantViolation("Legacy PaymentIntent status refresh lost its quarantine fence", {
          paymentIntentId: input.paymentIntentId,
        });
      }
      return toLegacyQuarantine(refreshed);
    });
  }

  async resolveLegacyPaymentIntent(
    input: ResolveLegacyPaymentIntentInput,
  ): Promise<AutoTopUpLegacyPaymentQuarantine | null> {
    requiredString(input.paymentIntentId, "paymentIntentId");
    assertDate(input.now, "now");
    const metadata = jsonObject(input.metadata, "metadata");
    if (!(["credited", "canceled", "manual_review"] as const).includes(input.resolution)) {
      invalidInput("Legacy PaymentIntent resolution is unsupported", {
        resolution: input.resolution,
      });
    }

    return dbWrite.transaction(async (tx) => {
      // The first read discovers immutable ownership without taking a row lock.
      // Every actual lock then follows organization -> quarantine -> credit,
      // matching imports, claims, lifecycle guards, and webhook credit writers.
      const [observedEntry] = await tx
        .select({
          id: autoTopUpLegacyPaymentQuarantine.id,
          organizationId: autoTopUpLegacyPaymentQuarantine.organization_id,
        })
        .from(autoTopUpLegacyPaymentQuarantine)
        .where(eq(autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id, input.paymentIntentId))
        .limit(1);
      if (!observedEntry) return null;

      const [lockedOrganization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, observedEntry.organizationId))
        .for("update")
        .limit(1);
      if (!lockedOrganization) return null;

      const [entry] = await tx
        .select()
        .from(autoTopUpLegacyPaymentQuarantine)
        .where(
          and(
            eq(autoTopUpLegacyPaymentQuarantine.id, observedEntry.id),
            eq(autoTopUpLegacyPaymentQuarantine.organization_id, observedEntry.organizationId),
            eq(autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id, input.paymentIntentId),
          ),
        )
        .for("update")
        .limit(1);
      if (!entry) return null;

      const [credit] = await tx
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.stripe_payment_intent_id, input.paymentIntentId))
        .for("update")
        .limit(1);
      const creditAmountCents = credit ? exactCentsFromDecimal(credit.amount) : null;
      const creditMatches =
        credit !== undefined &&
        credit.organization_id === entry.organization_id &&
        credit.type === "credit" &&
        credit.metadata.type === "auto_top_up" &&
        creditAmountCents === entry.credit_amount_cents;

      if (entry.status === "credited" || entry.status === "canceled") {
        if (entry.status !== input.resolution) return null;
        if (entry.status === "credited") {
          return entry.provider_status === "succeeded" && creditMatches
            ? toLegacyQuarantine(entry)
            : null;
        }
        return entry.provider_status === "canceled" && !credit ? toLegacyQuarantine(entry) : null;
      }

      if (input.resolution === "credited") {
        if (entry.provider_status !== "succeeded" || !creditMatches) {
          return null;
        }
      } else if (input.resolution === "canceled") {
        if (entry.provider_status !== "canceled" || credit) return null;
      }

      if (input.resolution === "manual_review") {
        const disabled = await tx
          .update(organizations)
          .set({ auto_top_up_enabled: false, updated_at: input.now })
          .where(eq(organizations.id, entry.organization_id))
          .returning({ id: organizations.id });
        if (disabled.length !== 1) {
          invariantViolation("Legacy PaymentIntent review could not disable its organization", {
            paymentIntentId: input.paymentIntentId,
            organizationId: entry.organization_id,
          });
        }
      }
      const [resolved] = await tx
        .update(autoTopUpLegacyPaymentQuarantine)
        .set({
          status: input.resolution,
          credit_transaction_id: input.resolution === "credited" ? credit?.id : null,
          metadata,
          resolved_at: input.resolution === "manual_review" ? null : input.now,
          updated_at: input.now,
        })
        .where(eq(autoTopUpLegacyPaymentQuarantine.id, entry.id))
        .returning();
      return resolved ? toLegacyQuarantine(resolved) : null;
    });
  }

  async findById(attemptId: string): Promise<AutoTopUpAttempt | null> {
    const [row] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(eq(autoTopUpAttempts.id, attemptId))
      .limit(1);
    return row ? toAttempt(row) : null;
  }

  async findBlockingByOrganization(organizationId: string): Promise<AutoTopUpAttempt | null> {
    requiredString(organizationId, "organizationId");
    const [row] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(
        and(
          eq(autoTopUpAttempts.organization_id, organizationId),
          inArray(autoTopUpAttempts.status, BLOCKING_STATUSES),
        ),
      )
      .orderBy(desc(autoTopUpAttempts.created_at))
      .limit(1);
    return row ? toAttempt(row) : null;
  }

  /**
   * Primary-read UX hint for settings flows. This is not the security boundary:
   * claimEligibleAttempt rechecks the same predicate under the organization lock.
   */
  async findBlockingLegacyPaymentByOrganization(
    organizationId: string,
  ): Promise<AutoTopUpLegacyPaymentQuarantine | null> {
    requiredString(organizationId, "organizationId");
    const [row] = await dbWrite
      .select()
      .from(autoTopUpLegacyPaymentQuarantine)
      .where(
        and(
          eq(autoTopUpLegacyPaymentQuarantine.organization_id, organizationId),
          inArray(autoTopUpLegacyPaymentQuarantine.status, ["unresolved", "manual_review"]),
        ),
      )
      .orderBy(desc(autoTopUpLegacyPaymentQuarantine.discovered_at))
      .limit(1);
    return row ? toLegacyQuarantine(row) : null;
  }

  /** Read one exact legacy quarantine snapshot without changing its lifecycle. */
  async findLegacyPaymentByStripePaymentIntentId(
    paymentIntentId: string,
  ): Promise<AutoTopUpLegacyPaymentQuarantine | null> {
    requiredString(paymentIntentId, "paymentIntentId");
    const [row] = await dbWrite
      .select()
      .from(autoTopUpLegacyPaymentQuarantine)
      .where(eq(autoTopUpLegacyPaymentQuarantine.stripe_payment_intent_id, paymentIntentId))
      .limit(1);
    return row ? toLegacyQuarantine(row) : null;
  }

  async findByPaymentIntentId(paymentIntentId: string): Promise<AutoTopUpAttempt | null> {
    requiredString(paymentIntentId, "paymentIntentId");
    const [row] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(eq(autoTopUpAttempts.stripe_payment_intent_id, paymentIntentId))
      .limit(1);
    return row ? toAttempt(row) : null;
  }

  /**
   * Linearization point for a new top-up. The organization row is locked before
   * checking an idempotency replay, an existing blocking attempt, or current
   * billing eligibility. The inserted provider snapshot therefore cannot be
   * assembled from a stale pre-lock organization read.
   */
  async claimEligibleAttempt(
    input: ClaimEligibleAttemptInput,
  ): Promise<ClaimEligibleAttemptResult> {
    requiredString(input.organizationId, "organizationId");
    requiredString(input.attemptId, "attemptId");
    requiredString(input.idempotencyKey, "idempotencyKey");
    assertDate(input.now, "now");
    if (!TRIGGER_SOURCES.has(input.triggerSource)) {
      invalidInput("Auto-top-up trigger source is unsupported", { field: "triggerSource" });
    }

    return dbWrite.transaction(async (tx) => {
      // Global lock order is organization -> cutover control -> quarantine.
      // Lifecycle triggers already hold the organization before consulting the
      // control row; matching that order prevents a queued phase writer from
      // creating a PostgreSQL fairness deadlock.
      const [organization] = await tx
        .select({
          id: organizations.id,
          is_active: organizations.is_active,
          auto_top_up_enabled: organizations.auto_top_up_enabled,
          credit_balance: organizations.credit_balance,
          auto_top_up_threshold: organizations.auto_top_up_threshold,
          auto_top_up_amount: organizations.auto_top_up_amount,
          stripe_customer_id: organizations.stripe_customer_id,
          stripe_default_payment_method: organizations.stripe_default_payment_method,
          balance_decrease_revision: organizations.balance_decrease_revision,
          covered_balance_decrease_revision:
            organizations.auto_top_up_covered_balance_decrease_revision,
          below_threshold: sql<boolean>`${organizations.credit_balance} < ${organizations.auto_top_up_threshold}`,
        })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update")
        .limit(1);

      if (!organization) return notEligible(input.organizationId, "not_found");

      // A pause or activation takes the singleton exclusively. Reading it only
      // after the tenant lock still linearizes the phase boundary: the claim
      // waits for any queued writer, then acts on the committed mode.
      const [control] = await tx
        .select({ mode: autoTopUpControl.mode })
        .from(autoTopUpControl)
        .where(eq(autoTopUpControl.singleton, true))
        .for("share")
        .limit(1);
      if (!control) invariantViolation("Auto-top-up control row is missing", {});
      if (control.mode !== "durable") {
        return notEligible(input.organizationId, "cutover_paused");
      }

      // Authoritative legacy quarantine fence. Settings may have been
      // re-enabled after global cutover, so force the tenant back to disabled
      // while the same organization lock is held before considering any
      // idempotency replay or new provider work. This read deliberately takes
      // no quarantine row lock; a concurrent stale blocking read is safely
      // fail-closed.
      const [blockingLegacyPayment] = await tx
        .select({ id: autoTopUpLegacyPaymentQuarantine.id })
        .from(autoTopUpLegacyPaymentQuarantine)
        .where(
          and(
            eq(autoTopUpLegacyPaymentQuarantine.organization_id, input.organizationId),
            inArray(autoTopUpLegacyPaymentQuarantine.status, ["unresolved", "manual_review"]),
          ),
        )
        .limit(1);
      if (blockingLegacyPayment) {
        const disabled = await tx
          .update(organizations)
          .set({ auto_top_up_enabled: false, updated_at: input.now })
          .where(eq(organizations.id, input.organizationId))
          .returning({ id: organizations.id });
        if (disabled.length !== 1) {
          invariantViolation("Legacy PaymentIntent quarantine could not disable its organization", {
            organizationId: input.organizationId,
            quarantineId: blockingLegacyPayment.id,
          });
        }
        return notEligible(input.organizationId, "legacy_payment_unresolved");
      }

      const [idempotent] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.idempotency_key, input.idempotencyKey))
        .limit(1);
      if (idempotent) {
        if (idempotent.organization_id !== input.organizationId) {
          invariantViolation("Auto-top-up idempotency key belongs to another organization", {
            organizationId: input.organizationId,
            attemptId: idempotent.id,
          });
        }
        return { outcome: "reused", attempt: toAttempt(idempotent) };
      }

      const [blocking] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(
          and(
            eq(autoTopUpAttempts.organization_id, input.organizationId),
            inArray(autoTopUpAttempts.status, BLOCKING_STATUSES),
          ),
        )
        .limit(1);
      if (blocking) return { outcome: "reused", attempt: toAttempt(blocking) };

      if (!organization.is_active || organization.auto_top_up_enabled !== true) {
        return notEligible(input.organizationId, "disabled");
      }

      const disableInvalidConfiguration = async (
        reason: Extract<
          AutoTopUpNotEligibleReason,
          | "invalid_balance"
          | "invalid_threshold"
          | "invalid_amount"
          | "missing_customer"
          | "missing_payment_method"
        >,
        amounts?: { currentBalanceCents?: number; thresholdCents?: number },
      ): Promise<ClaimEligibleAttemptResult> => {
        const disabled = await tx
          .update(organizations)
          .set({ auto_top_up_enabled: false, updated_at: input.now })
          .where(eq(organizations.id, input.organizationId))
          .returning({ id: organizations.id });
        if (disabled.length !== 1) {
          invariantViolation("Invalid auto-top-up configuration could not be disabled", {
            organizationId: input.organizationId,
            reason,
          });
        }
        return notEligible(input.organizationId, reason, amounts);
      };

      const balance = canonicalSignedDecimal(organization.credit_balance);
      if (!balance) return disableInvalidConfiguration("invalid_balance");
      const currentBalanceCents = exactSignedCentsFromDecimal(balance) ?? undefined;
      const thresholdCents = exactCentsFromDecimal(organization.auto_top_up_threshold);
      if (thresholdCents === null || thresholdCents > MAX_AUTO_TOP_UP_CENTS) {
        return disableInvalidConfiguration("invalid_threshold", { currentBalanceCents });
      }
      if (organization.below_threshold !== true) {
        return notEligible(input.organizationId, "balance_at_or_above_threshold", {
          currentBalanceCents,
          thresholdCents,
        });
      }
      const creditAmountCents = exactCentsFromDecimal(organization.auto_top_up_amount);
      if (
        creditAmountCents === null ||
        creditAmountCents < MIN_AUTO_TOP_UP_CENTS ||
        creditAmountCents > MAX_AUTO_TOP_UP_CENTS
      ) {
        return disableInvalidConfiguration("invalid_amount", {
          currentBalanceCents,
          thresholdCents,
        });
      }
      const stripeCustomerId = organization.stripe_customer_id;
      if (!stripeCustomerId || stripeCustomerId !== stripeCustomerId.trim()) {
        return disableInvalidConfiguration("missing_customer", {
          currentBalanceCents,
          thresholdCents,
        });
      }
      const customerAuthority = await tx.execute(sql`
        SELECT "stripe_customer_binding_is_authoritative"(
          ${input.organizationId}::uuid, ${stripeCustomerId}::text
        ) AS authoritative
      `);
      if (customerAuthority.rows[0]?.authoritative !== true) {
        return notEligible(input.organizationId, "unverified_customer_authority", {
          currentBalanceCents,
          thresholdCents,
        });
      }
      const stripePaymentMethodId = organization.stripe_default_payment_method;
      if (!stripePaymentMethodId || stripePaymentMethodId !== stripePaymentMethodId.trim()) {
        return disableInvalidConfiguration("missing_payment_method", {
          currentBalanceCents,
          thresholdCents,
        });
      }

      if (
        organization.covered_balance_decrease_revision !== null &&
        organization.balance_decrease_revision <= organization.covered_balance_decrease_revision
      ) {
        return notEligible(input.organizationId, "balance_not_rearmed", {
          currentBalanceCents,
          thresholdCents,
        });
      }

      const [created] = await tx
        .insert(autoTopUpAttempts)
        .values({
          id: input.attemptId,
          organization_id: input.organizationId,
          trigger_source: input.triggerSource,
          status: "claimed",
          credit_amount_cents: creditAmountCents,
          charge_amount_cents: creditAmountCents,
          currency: "usd",
          stripe_customer_id_snapshot: stripeCustomerId,
          stripe_payment_method_id_snapshot: stripePaymentMethodId,
          request_metadata: {},
          idempotency_key: input.idempotencyKey,
          next_attempt_at: input.now,
          created_at: input.now,
          updated_at: input.now,
        })
        .returning();
      if (!created) {
        invariantViolation("Auto-top-up claim insert returned no row", {
          organizationId: input.organizationId,
          attemptId: input.attemptId,
        });
      }
      return { outcome: "created", attempt: toAttempt(created) };
    });
  }

  async claimDueLease(input: ClaimDueLeaseInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertLeaseWindow(input.now, input.leaseExpiresAt);
    const [claimed] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        lease_token: input.leaseToken,
        lease_expires_at: input.leaseExpiresAt,
        attempt_count: sql`${autoTopUpAttempts.attempt_count} + 1`,
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          inArray(autoTopUpAttempts.status, CLAIMABLE_STATUSES),
          lte(autoTopUpAttempts.next_attempt_at, input.now),
          or(
            isNull(autoTopUpAttempts.lease_token),
            lte(autoTopUpAttempts.lease_expires_at, input.now),
          ),
        ),
      )
      .returning();
    if (claimed) return toAttempt(claimed);

    const [replayed] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          inArray(autoTopUpAttempts.status, CLAIMABLE_STATUSES),
        ),
      )
      .limit(1);
    return replayed ? toAttempt(replayed) : null;
  }

  async finalizeRequest(input: FinalizeAutoTopUpRequestInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertDate(input.now, "now");
    const chargeAmountCents = safeIntegerCents(input.chargeAmountCents, "chargeAmountCents");
    if (chargeAmountCents > MAX_AUTO_TOP_UP_CHARGE_CENTS) {
      invalidInput("Auto-top-up charge exceeds the configured provider bound", {
        field: "chargeAmountCents",
        max: MAX_AUTO_TOP_UP_CHARGE_CENTS,
      });
    }
    const metadata = jsonObject(input.requestMetadata, "requestMetadata");
    const [updated] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        status: "payment_pending",
        charge_amount_cents: chargeAmountCents,
        request_metadata: metadata,
        last_error: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          eq(autoTopUpAttempts.status, "claimed"),
          isNull(autoTopUpAttempts.provider_request_started_at),
          lte(autoTopUpAttempts.credit_amount_cents, chargeAmountCents),
        ),
      )
      .returning();
    if (updated) return toAttempt(updated);

    const [replayed] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          eq(autoTopUpAttempts.status, "payment_pending"),
          isNull(autoTopUpAttempts.provider_request_started_at),
          eq(autoTopUpAttempts.charge_amount_cents, chargeAmountCents),
          sql`${autoTopUpAttempts.request_metadata} = ${JSON.stringify(metadata)}::jsonb`,
        ),
      )
      .limit(1);
    return replayed ? toAttempt(replayed) : null;
  }

  async markProviderRequestStarted(
    input: MarkProviderRequestStartedInput,
  ): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertLeaseWindow(input.now, input.recoveryDeadlineAt);
    const [updated] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        provider_request_started_at: input.now,
        recovery_deadline_at: input.recoveryDeadlineAt,
        next_attempt_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          eq(autoTopUpAttempts.status, "payment_pending"),
          isNull(autoTopUpAttempts.provider_request_started_at),
        ),
      )
      .returning();
    if (updated) return toAttempt(updated);

    const [replayed] = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          eq(autoTopUpAttempts.status, "payment_pending"),
          gt(autoTopUpAttempts.recovery_deadline_at, input.now),
        ),
      )
      .limit(1);
    return replayed ? toAttempt(replayed) : null;
  }

  async recordPaymentIntent(input: RecordPaymentIntentInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    requiredString(input.paymentIntentId, "paymentIntentId");
    requiredString(input.providerStatus, "providerStatus");
    assertDate(input.now, "now");
    const result = jsonObject(input.result, "result");
    const succeeded = input.providerStatus === "succeeded";
    const allowedStatuses: AutoTopUpAttemptStatus[] = succeeded
      ? ["payment_pending", "payment_succeeded"]
      : ["payment_pending"];
    const [updated] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        status: succeeded ? "payment_succeeded" : "payment_pending",
        stripe_payment_intent_id: input.paymentIntentId,
        provider_status: input.providerStatus,
        result,
        last_error: null,
        ...(succeeded ? { payment_succeeded_at: input.now, next_attempt_at: input.now } : {}),
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          inArray(autoTopUpAttempts.status, allowedStatuses),
          or(
            isNull(autoTopUpAttempts.stripe_payment_intent_id),
            eq(autoTopUpAttempts.stripe_payment_intent_id, input.paymentIntentId),
          ),
          sql`${autoTopUpAttempts.provider_request_started_at} IS NOT NULL`,
        ),
      )
      .returning();
    return updated ? toAttempt(updated) : null;
  }

  async recordFailure(input: RecordAutoTopUpFailureInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    requiredString(input.error, "error");
    assertDate(input.now, "now");
    assertDate(input.nextAttemptAt, "nextAttemptAt");
    if (input.nextAttemptAt.getTime() <= input.now.getTime()) {
      invalidInput("Auto-top-up retry must be scheduled in the future", {
        field: "nextAttemptAt",
      });
    }
    const result = input.result ? jsonObject(input.result, "result") : undefined;
    const [updated] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        last_error: input.error,
        ...(result ? { result } : {}),
        next_attempt_at: sql`CASE
          WHEN ${autoTopUpAttempts.stripe_payment_intent_id} IS NULL
            THEN LEAST(${input.nextAttemptAt}, COALESCE(${autoTopUpAttempts.recovery_deadline_at}, ${input.nextAttemptAt}))
          ELSE ${input.nextAttemptAt}
        END`,
        lease_token: null,
        lease_expires_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          inArray(autoTopUpAttempts.status, ["claimed", "payment_pending"]),
        ),
      )
      .returning();
    return updated ? toAttempt(updated) : null;
  }

  async markCanceled(input: MarkAutoTopUpTerminalInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    requiredString(input.error, "error");
    assertDate(input.now, "now");
    const result = input.result ? jsonObject(input.result, "result") : undefined;

    return dbWrite.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (
        !attempt ||
        attempt.lease_token !== input.leaseToken ||
        !attempt.lease_expires_at ||
        attempt.lease_expires_at.getTime() <= input.now.getTime() ||
        (attempt.status !== "claimed" && attempt.status !== "payment_pending") ||
        !(
          (attempt.provider_request_started_at === null &&
            attempt.stripe_payment_intent_id === null) ||
          (attempt.stripe_payment_intent_id !== null && attempt.provider_status === "canceled")
        )
      ) {
        return null;
      }

      const disabled = await tx
        .update(organizations)
        .set({ auto_top_up_enabled: false, updated_at: input.now })
        .where(eq(organizations.id, attempt.organization_id))
        .returning({ id: organizations.id });
      if (disabled.length !== 1) {
        invariantViolation("Auto-top-up cancellation could not disable its organization", {
          attemptId: attempt.id,
          organizationId: attempt.organization_id,
        });
      }

      const [canceled] = await tx
        .update(autoTopUpAttempts)
        .set({
          status: "canceled",
          last_error: input.error,
          ...(result ? { result } : {}),
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null,
          canceled_at: input.now,
          updated_at: input.now,
        })
        .where(
          and(
            eq(autoTopUpAttempts.id, attempt.id),
            eq(autoTopUpAttempts.status, attempt.status),
            eq(autoTopUpAttempts.lease_token, input.leaseToken),
            gt(autoTopUpAttempts.lease_expires_at, input.now),
            or(
              and(
                isNull(autoTopUpAttempts.provider_request_started_at),
                isNull(autoTopUpAttempts.stripe_payment_intent_id),
              ),
              and(
                sql`${autoTopUpAttempts.stripe_payment_intent_id} IS NOT NULL`,
                eq(autoTopUpAttempts.provider_status, "canceled"),
              ),
            ),
          ),
        )
        .returning();
      if (!canceled) {
        invariantViolation("Auto-top-up cancellation lost its lease fence", {
          attemptId: attempt.id,
        });
      }
      return toAttempt(canceled);
    });
  }

  async markManualReview(input: MarkAutoTopUpTerminalInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    requiredString(input.error, "error");
    assertDate(input.now, "now");
    const result = input.result ? jsonObject(input.result, "result") : undefined;

    return dbWrite.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (
        !attempt ||
        attempt.lease_token !== input.leaseToken ||
        !attempt.lease_expires_at ||
        attempt.lease_expires_at.getTime() <= input.now.getTime() ||
        !CLAIMABLE_STATUSES.includes(attempt.status)
      ) {
        return null;
      }

      const disabled = await tx
        .update(organizations)
        .set({ auto_top_up_enabled: false, updated_at: input.now })
        .where(eq(organizations.id, attempt.organization_id))
        .returning({ id: organizations.id });
      if (disabled.length !== 1) {
        invariantViolation("Auto-top-up manual review could not disable its organization", {
          attemptId: attempt.id,
          organizationId: attempt.organization_id,
        });
      }

      const [reviewed] = await tx
        .update(autoTopUpAttempts)
        .set({
          status: "manual_review",
          last_error: input.error,
          ...(result ? { result } : {}),
          next_attempt_at: null,
          lease_token: null,
          lease_expires_at: null,
          manual_review_at: input.now,
          updated_at: input.now,
        })
        .where(
          and(
            eq(autoTopUpAttempts.id, attempt.id),
            eq(autoTopUpAttempts.status, attempt.status),
            eq(autoTopUpAttempts.lease_token, input.leaseToken),
            gt(autoTopUpAttempts.lease_expires_at, input.now),
          ),
        )
        .returning();
      if (!reviewed) {
        invariantViolation("Auto-top-up manual review lost its lease fence", {
          attemptId: attempt.id,
        });
      }
      return toAttempt(reviewed);
    });
  }

  /**
   * Reopen only a previously provider-started manual review after the service
   * validates a late signed success. The organization deliberately remains
   * disabled and the audit timestamp is retained; recovery must claim a fresh
   * lease before settlement.
   */
  async reopenManualReviewForSucceededPayment(
    input: ReopenManualReviewForSucceededPaymentInput,
  ): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.paymentIntentId, "paymentIntentId");
    assertDate(input.now, "now");
    const result = jsonObject(input.result, "result");

    return dbWrite.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (!attempt) return null;
      if (
        (attempt.status === "payment_succeeded" || attempt.status === "credited") &&
        attempt.stripe_payment_intent_id === input.paymentIntentId
      ) {
        return toAttempt(attempt);
      }
      if (
        attempt.status !== "manual_review" ||
        !attempt.provider_request_started_at ||
        attempt.credit_transaction_id !== null ||
        (attempt.stripe_payment_intent_id !== null &&
          attempt.stripe_payment_intent_id !== input.paymentIntentId)
      ) {
        return null;
      }

      const [reopened] = await tx
        .update(autoTopUpAttempts)
        .set({
          status: "payment_succeeded",
          stripe_payment_intent_id: input.paymentIntentId,
          provider_status: "succeeded",
          result,
          last_error: null,
          payment_succeeded_at: input.now,
          next_attempt_at: input.now,
          updated_at: input.now,
        })
        .where(
          and(
            eq(autoTopUpAttempts.id, attempt.id),
            eq(autoTopUpAttempts.status, "manual_review"),
            or(
              isNull(autoTopUpAttempts.stripe_payment_intent_id),
              eq(autoTopUpAttempts.stripe_payment_intent_id, input.paymentIntentId),
            ),
            sql`${autoTopUpAttempts.provider_request_started_at} IS NOT NULL`,
          ),
        )
        .returning();
      return reopened ? toAttempt(reopened) : null;
    });
  }

  async listDue(input: ListDueAutoTopUpAttemptsInput): Promise<AutoTopUpAttempt[]> {
    assertDate(input.now, "now");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_DUE_LIMIT) {
      invalidInput("Auto-top-up due limit is outside its bounded range", {
        field: "limit",
        max: MAX_DUE_LIMIT,
      });
    }
    const rows = await dbWrite
      .select()
      .from(autoTopUpAttempts)
      .where(
        and(
          inArray(autoTopUpAttempts.status, CLAIMABLE_STATUSES),
          lte(autoTopUpAttempts.next_attempt_at, input.now),
          or(
            isNull(autoTopUpAttempts.lease_token),
            lte(autoTopUpAttempts.lease_expires_at, input.now),
          ),
        ),
      )
      .orderBy(asc(autoTopUpAttempts.next_attempt_at), asc(autoTopUpAttempts.created_at))
      .limit(input.limit);
    return rows.map(toAttempt);
  }

  async listDueAttempts(input: ListDueAutoTopUpAttemptsInput): Promise<AutoTopUpAttempt[]> {
    return this.listDue(input);
  }

  /**
   * Primary-only bounded discovery hint for the cron. Every returned id still
   * passes through claimEligibleAttempt, which owns the locked authoritative
   * eligibility decision and rejects corrupt monetary fields.
   */
  async listEligibleOrganizationIds(input: { limit: number }): Promise<string[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_DUE_LIMIT) {
      invalidInput("Auto-top-up discovery limit is outside its bounded range", {
        field: "limit",
        max: MAX_DUE_LIMIT,
      });
    }
    const rows = await dbWrite
      .select({ organizationId: organizations.id })
      .from(organizations)
      .innerJoin(autoTopUpControl, eq(autoTopUpControl.singleton, true))
      .where(
        and(
          eq(autoTopUpControl.mode, "durable"),
          eq(organizations.is_active, true),
          eq(organizations.auto_top_up_enabled, true),
          sql`${organizations.credit_balance} < ${organizations.auto_top_up_threshold}`,
          notExists(
            dbWrite
              .select({ present: sql`1` })
              .from(autoTopUpAttempts)
              .where(
                and(
                  eq(autoTopUpAttempts.organization_id, organizations.id),
                  inArray(autoTopUpAttempts.status, BLOCKING_STATUSES),
                ),
              ),
          ),
          notExists(
            dbWrite
              .select({ present: sql`1` })
              .from(autoTopUpLegacyPaymentQuarantine)
              .where(
                and(
                  eq(autoTopUpLegacyPaymentQuarantine.organization_id, organizations.id),
                  inArray(autoTopUpLegacyPaymentQuarantine.status, ["unresolved", "manual_review"]),
                ),
              ),
          ),
          or(
            isNull(organizations.auto_top_up_covered_balance_decrease_revision),
            sql`${organizations.auto_top_up_covered_balance_decrease_revision} < ${organizations.balance_decrease_revision}`,
          ),
        ),
      )
      .orderBy(asc(organizations.id))
      .limit(input.limit);
    return rows.map((row) => row.organizationId);
  }

  /**
   * Apply or find the exact provider credit and link it to the succeeded
   * attempt. The status deliberately remains payment_succeeded: only the
   * service can mark it credited after entitlement caches are invalidated.
   */
  async settleSucceededAttempt(input: {
    attemptId: string;
    leaseToken: string;
    now: Date;
  }): Promise<SettleSucceededAttemptResult | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertDate(input.now, "now");

    return dbWrite.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(autoTopUpAttempts)
        .where(eq(autoTopUpAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (!attempt) return null;

      // Match the canonical credit writer's lock order: organization before
      // credit_transactions. The independent attempt lock cannot participate
      // in a cycle because provider/webhook credit writers never acquire it.
      const [lockedOrganization] = await tx
        .select({
          balance: organizations.credit_balance,
          balanceDecreaseRevision: organizations.balance_decrease_revision,
          coveredBalanceDecreaseRevision:
            organizations.auto_top_up_covered_balance_decrease_revision,
        })
        .from(organizations)
        .where(eq(organizations.id, attempt.organization_id))
        .for("update")
        .limit(1);
      if (!lockedOrganization) {
        invariantViolation("Auto-top-up settlement organization is missing", {
          attemptId: attempt.id,
          organizationId: attempt.organization_id,
        });
      }

      if (attempt.status === "credited") {
        if (!attempt.credit_transaction_id) {
          invariantViolation("Credited auto-top-up has no credit transaction", {
            attemptId: attempt.id,
          });
        }
        return {
          outcome: "already_applied",
          attempt: toAttempt(attempt),
          creditTransactionId: attempt.credit_transaction_id,
          newBalance: String(lockedOrganization.balance),
        };
      }

      if (
        attempt.status !== "payment_succeeded" ||
        attempt.lease_token !== input.leaseToken ||
        !attempt.lease_expires_at ||
        attempt.lease_expires_at.getTime() <= input.now.getTime() ||
        !attempt.stripe_payment_intent_id
      ) {
        return null;
      }

      const [existingCredit] = await tx
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.stripe_payment_intent_id, attempt.stripe_payment_intent_id))
        .for("update")
        .limit(1);
      if (existingCredit) {
        const existingCents = exactCentsFromDecimal(existingCredit.amount);
        if (
          existingCredit.organization_id !== attempt.organization_id ||
          existingCredit.type !== "credit" ||
          existingCredit.metadata.type !== "auto_top_up" ||
          existingCents !== attempt.credit_amount_cents
        ) {
          const reviewed = await this.markManualReviewInTransaction(tx, attempt, input.now);
          return { outcome: "manual_review", attempt: toAttempt(reviewed) };
        }
        const coveredRevision =
          attempt.covered_balance_decrease_revision ??
          lockedOrganization.coveredBalanceDecreaseRevision;
        if (coveredRevision === null) {
          const reviewed = await this.markManualReviewInTransaction(tx, attempt, input.now, {
            error: "Existing credit timing cannot be reconciled safely",
            creditTransactionId: existingCredit.id,
          });
          return { outcome: "manual_review", attempt: toAttempt(reviewed) };
        }
        const linked = await this.linkCreditInTransaction(
          tx,
          attempt,
          existingCredit.id,
          // A retry after credit application must preserve the revision that
          // was covered by that credit. Using the live revision here would
          // swallow a debit that happened after settlement but before the
          // cache/final-state step recovered.
          coveredRevision,
          input.now,
        );
        return {
          outcome: "already_applied",
          attempt: toAttempt(linked),
          creditTransactionId: existingCredit.id,
          newBalance: String(lockedOrganization.balance),
        };
      }

      const metadata = {
        ...attempt.request_metadata,
        type: "auto_top_up",
        auto_top_up_attempt_id: attempt.id,
        auto_top_up_idempotency_key: attempt.idempotency_key,
        payment_intent_id: attempt.stripe_payment_intent_id,
      };
      const [creditTransaction] = await tx
        .insert(creditTransactions)
        .values({
          organization_id: attempt.organization_id,
          amount: sql`${String(attempt.credit_amount_cents)}::numeric / 100`,
          type: "credit",
          description: `Auto top-up - ${attempt.credit_amount_cents} cents`,
          metadata,
          stripe_payment_intent_id: attempt.stripe_payment_intent_id,
          created_at: input.now,
        })
        .returning();
      if (!creditTransaction) {
        invariantViolation("Auto-top-up credit insert returned no row", {
          attemptId: attempt.id,
        });
      }

      const [organization] = await tx
        .update(organizations)
        .set({
          credit_balance: sql`${organizations.credit_balance} + (${String(attempt.credit_amount_cents)}::numeric / 100)`,
          settings: sql`COALESCE(${organizations.settings}, '{}'::jsonb) - 'welcomeBonusWithheld'`,
          updated_at: input.now,
        })
        .where(eq(organizations.id, attempt.organization_id))
        .returning({ balance: organizations.credit_balance });
      if (!organization) {
        invariantViolation("Auto-top-up credit balance update returned no organization", {
          attemptId: attempt.id,
          organizationId: attempt.organization_id,
        });
      }

      const linked = await this.linkCreditInTransaction(
        tx,
        attempt,
        creditTransaction.id,
        lockedOrganization.balanceDecreaseRevision,
        input.now,
      );
      return {
        outcome: "applied",
        attempt: toAttempt(linked),
        creditTransactionId: creditTransaction.id,
        newBalance: String(organization.balance),
      };
    });
  }

  /** Terminalize only after the service has awaited all required cache invalidations. */
  async markCredited(input: MarkAutoTopUpCreditedInput): Promise<AutoTopUpAttempt | null> {
    requiredString(input.attemptId, "attemptId");
    requiredString(input.leaseToken, "leaseToken");
    assertDate(input.now, "now");
    const [credited] = await dbWrite
      .update(autoTopUpAttempts)
      .set({
        status: "credited",
        credited_at: input.now,
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null,
        last_error: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, input.attemptId),
          eq(autoTopUpAttempts.status, "payment_succeeded"),
          eq(autoTopUpAttempts.lease_token, input.leaseToken),
          gt(autoTopUpAttempts.lease_expires_at, input.now),
          sql`${autoTopUpAttempts.credit_transaction_id} IS NOT NULL`,
          sql`${autoTopUpAttempts.covered_balance_decrease_revision} IS NOT NULL`,
        ),
      )
      .returning();
    return credited ? toAttempt(credited) : null;
  }

  private async markManualReviewInTransaction(
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    attempt: AutoTopUpAttemptRow,
    now: Date,
    options: { error?: string; creditTransactionId?: string } = {},
  ): Promise<AutoTopUpAttemptRow> {
    const disabled = await tx
      .update(organizations)
      .set({ auto_top_up_enabled: false, updated_at: now })
      .where(eq(organizations.id, attempt.organization_id))
      .returning({ id: organizations.id });
    if (disabled.length !== 1) {
      invariantViolation("Auto-top-up settlement review could not disable its organization", {
        attemptId: attempt.id,
        organizationId: attempt.organization_id,
      });
    }

    const [reviewed] = await tx
      .update(autoTopUpAttempts)
      .set({
        status: "manual_review",
        credit_transaction_id: options.creditTransactionId ?? attempt.credit_transaction_id,
        last_error:
          options.error ?? "Existing credit transaction does not match the auto-top-up attempt",
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null,
        manual_review_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, attempt.id),
          eq(autoTopUpAttempts.status, "payment_succeeded"),
          eq(autoTopUpAttempts.lease_token, attempt.lease_token as string),
          gt(autoTopUpAttempts.lease_expires_at, now),
        ),
      )
      .returning();
    if (!reviewed) {
      invariantViolation("Auto-top-up manual-review transition lost its fence", {
        attemptId: attempt.id,
      });
    }
    return reviewed;
  }

  private async linkCreditInTransaction(
    tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
    attempt: AutoTopUpAttemptRow,
    creditTransactionId: string,
    coveredBalanceDecreaseRevision: number,
    now: Date,
  ): Promise<AutoTopUpAttemptRow> {
    const [linked] = await tx
      .update(autoTopUpAttempts)
      .set({
        credit_transaction_id: creditTransactionId,
        covered_balance_decrease_revision: coveredBalanceDecreaseRevision,
        next_attempt_at: now,
        last_error: null,
        updated_at: now,
      })
      .where(
        and(
          eq(autoTopUpAttempts.id, attempt.id),
          eq(autoTopUpAttempts.status, "payment_succeeded"),
          eq(autoTopUpAttempts.lease_token, attempt.lease_token as string),
        ),
      )
      .returning();
    if (!linked) {
      invariantViolation("Auto-top-up credit-link transition lost its fence", {
        attemptId: attempt.id,
      });
    }
    return linked;
  }
}

export const autoTopUpAttemptsRepository = new AutoTopUpAttemptsRepository();
