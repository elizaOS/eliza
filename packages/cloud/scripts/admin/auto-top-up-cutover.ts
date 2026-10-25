/**
 * Plans, applies, and activates the durable auto-top-up production cutover.
 * Dry-run is the default and performs only primary-control and paginated
 * Stripe reads. Apply imports and resolves the reviewed legacy inventory while
 * leaving the database paused. Activate revalidates that inventory and uses
 * the repository's guarded control transition. This operator never changes
 * the Worker runtime switch.
 *
 * Usage:
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
 *     --inventory-start 1970-01-01T00:00:00.000Z \
 *     --provider-fence-at 2026-08-17T12:00:00.000Z \
 *     --provider-fence-evidence INC-20717-key-revoked \
 *     --worker-version <full-sha> --output /tmp/auto-top-up-cutover.json
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
 *     --apply --plan /tmp/auto-top-up-cutover.json \
 *     --confirm-provider-fence --confirm-passive-worker-100-percent \
 *     --confirm-worker-switch-off --confirm-queue-and-dlq-reconciled \
 *     --confirm-migration-and-rearm-baselines
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
 *     --activate --plan /tmp/auto-top-up-cutover.json \
 *     --confirm-provider-fence --confirm-passive-worker-100-percent \
 *     --confirm-worker-switch-off --confirm-queue-and-dlq-reconciled \
 *     --confirm-migration-and-rearm-baselines
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
 *     --pause-for-rollback --confirm-database-pause-first
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PLAN_SCHEMA_VERSION = 1 as const;
const STRIPE_PAGE_LIMIT = 100;
const MIN_CREDIT_AMOUNT_CENTS = 100;
const MAX_CREDIT_AMOUNT_CENTS = 100_000;
const MAX_CHARGE_AMOUNT_CENTS = 1_120_000;
const COMPLETE_INVENTORY_START_ISO = "1970-01-01T00:00:00.000Z";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const EVIDENCE_TOKEN = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ControlMode = "paused" | "durable";
type LegacyResolution = "credited" | "canceled" | "manual_review";

export interface AutoTopUpControlSnapshot {
  mode: ControlMode;
  pausedAt: Date;
  legacyReconciledThrough: Date | null;
}

export interface StripePaymentIntentRecord {
  id: string;
  created: number;
  status: string;
  amount: number;
  amount_received: number;
  currency: string;
  livemode: boolean;
  metadata: Record<string, string>;
}

export interface StripePaymentIntentListPage {
  data: unknown[];
  has_more: boolean;
}

export interface StripePaymentIntentListInput {
  created: { gte: number; lte: number };
  limit: number;
  starting_after?: string;
}

export interface CutoverStripeClient {
  paymentIntents: {
    list(
      input: StripePaymentIntentListInput,
    ): Promise<StripePaymentIntentListPage>;
  };
}

interface LiveStripeListBoundary {
  paymentIntents: {
    list(input: StripePaymentIntentListInput): PromiseLike<{
      data: unknown[];
      has_more: boolean;
    }>;
  };
}

export interface CutoverLegacyPaymentSnapshot {
  organizationId: string;
  stripePaymentIntentId: string;
  providerStatus: string;
  creditAmountCents: number;
  status: "unresolved" | LegacyResolution;
  creditTransactionId: string | null;
  metadata: Record<string, unknown>;
  resolvedAt: Date | null;
}

export interface CutoverRepository {
  getControl(): Promise<AutoTopUpControlSnapshot>;
  quarantineLegacyPaymentIntent(input: {
    organizationId: string;
    paymentIntentId: string;
    providerStatus: string;
    creditAmountCents: number;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<unknown | null>;
  resolveLegacyPaymentIntent(input: {
    paymentIntentId: string;
    resolution: LegacyResolution;
    metadata: Record<string, unknown>;
    now: Date;
  }): Promise<unknown | null>;
  findLegacyPaymentByStripePaymentIntentId(
    paymentIntentId: string,
  ): Promise<CutoverLegacyPaymentSnapshot | null>;
  transitionControl(input: {
    expectedMode: ControlMode;
    targetMode: ControlMode;
    now: Date;
    legacyReconciledThrough?: Date;
  }): Promise<
    | { outcome: "applied"; control: AutoTopUpControlSnapshot }
    | {
        outcome: "not_applied";
        reason: string;
        control: AutoTopUpControlSnapshot;
      }
  >;
}

export interface CutoverDependencies {
  stripe: CutoverStripeClient;
  repository: CutoverRepository;
  now(): Date;
  durableSwitchValue?: string;
}

export interface CutoverPlanInput {
  inventoryStart: Date;
  providerFenceAt: Date;
  providerFenceEvidence: string;
  workerVersion: string;
}

export interface CutoverPlanIntent {
  id: string;
  created: number;
  organizationId: string;
  providerStatus: string;
  creditAmountCents: number;
  chargeAmountCents: number;
  action:
    | "verify_credited_or_review"
    | "verify_canceled_or_review"
    | "manual_review";
}

export interface CutoverPlanBlocker {
  code:
    | "control_not_paused"
    | "durable_switch_enabled"
    | "inventory_start_after_pause"
    | "provider_fence_before_pause"
    | "provider_fence_in_future"
    | "malformed_legacy_payment"
    | "unexpected_durable_payment";
  message: string;
  paymentIntentId?: string;
}

export interface AutoTopUpCutoverPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  generatedAt: string;
  workerVersion: string;
  providerFenceEvidence: string;
  inventoryStart: string;
  providerFenceAt: string;
  control: {
    mode: ControlMode;
    pausedAt: string;
    legacyReconciledThrough: string | null;
  };
  intents: CutoverPlanIntent[];
  blockers: CutoverPlanBlocker[];
  inventorySha256: string;
}

export interface ApplyConfirmations {
  providerFence: boolean;
  passiveWorker100Percent: boolean;
  workerSwitchOff: boolean;
  queueAndDlqReconciled: boolean;
  migrationAndRearmBaselines: boolean;
}

export interface AppliedCutoverResult {
  inventorySha256: string;
  resolutions: Array<{ paymentIntentId: string; resolution: LegacyResolution }>;
  control: AutoTopUpControlSnapshot;
}

export interface ActivatedCutoverResult extends AppliedCutoverResult {
  control: AutoTopUpControlSnapshot & { mode: "durable" };
}

export interface PausedRollbackResult {
  outcome: "paused" | "already_paused";
  control: AutoTopUpControlSnapshot & { mode: "paused" };
}

export type OperatorArgs =
  | {
      mode: "dry-run";
      input: CutoverPlanInput;
      output?: string;
    }
  | {
      mode: "apply";
      plan: string;
      confirmations: ApplyConfirmations;
    }
  | {
      mode: "activate";
      plan: string;
      confirmations: ApplyConfirmations;
    }
  | {
      mode: "pause-for-rollback";
      databasePauseFirst: true;
    };

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty canonical string`);
  }
  return value;
}

function commitSha(value: unknown, field: string): string {
  const sha = requiredString(value, field);
  if (!COMMIT_SHA.test(sha)) {
    throw new TypeError(`${field} must be a full lowercase 40-hex commit SHA`);
  }
  return sha;
}

function canonicalIsoDate(value: unknown, field: string): Date {
  const text = requiredString(value, field);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  return date;
}

function canonicalWholeSecondDate(value: unknown, field: string): Date {
  const date = canonicalIsoDate(value, field);
  if (date.getUTCMilliseconds() !== 0) {
    throw new TypeError(`${field} must resolve to a whole second`);
  }
  return date;
}

function completeInventoryStart(value: unknown, field: string): Date {
  const date = canonicalWholeSecondDate(value, field);
  if (date.getTime() !== 0) {
    throw new TypeError(
      `${field} must be the Unix epoch (${COMPLETE_INVENTORY_START_ISO}) for a complete provider inventory`,
    );
  }
  return date;
}

function canonicalCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(value))
    return null;
  const [whole, fraction] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function roundPositivePercentCents(cents: number, percent: number): number {
  // Inputs are bounded integer cents. Adding half the denominator implements
  // the same positive ROUND_HALF_UP policy used by the billing service.
  return Math.floor((cents * percent + 50) / 100);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function planFingerprintMaterial(
  plan: Omit<AutoTopUpCutoverPlan, "inventorySha256">,
): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    workerVersion: plan.workerVersion,
    providerFenceEvidence: plan.providerFenceEvidence,
    inventoryStart: plan.inventoryStart,
    providerFenceAt: plan.providerFenceAt,
    control: plan.control,
    intents: plan.intents,
    blockers: plan.blockers,
  };
}

function fingerprintPlan(
  plan: Omit<AutoTopUpCutoverPlan, "inventorySha256">,
): string {
  return createHash("sha256")
    .update(stableJson(planFingerprintMaterial(plan)))
    .digest("hex");
}

function assertPaymentIntent(value: unknown): StripePaymentIntentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Stripe PaymentIntent must be an object");
  }
  const record = Object.fromEntries(Object.entries(value));
  const id = requiredString(record.id, "Stripe PaymentIntent id");
  if (!Number.isSafeInteger(record.created) || Number(record.created) < 0) {
    throw new TypeError(
      "Stripe PaymentIntent created must be a non-negative integer",
    );
  }
  const status = requiredString(record.status, "Stripe PaymentIntent status");
  if (!Number.isSafeInteger(record.amount) || Number(record.amount) < 0) {
    throw new TypeError(
      "Stripe PaymentIntent amount must be a non-negative integer",
    );
  }
  if (
    !Number.isSafeInteger(record.amount_received) ||
    Number(record.amount_received) < 0
  ) {
    throw new TypeError(
      "Stripe PaymentIntent amount_received must be a non-negative integer",
    );
  }
  const currency = requiredString(
    record.currency,
    "Stripe PaymentIntent currency",
  );
  if (typeof record.livemode !== "boolean") {
    throw new TypeError("Stripe PaymentIntent livemode must be boolean");
  }
  if (
    !record.metadata ||
    typeof record.metadata !== "object" ||
    Array.isArray(record.metadata)
  ) {
    throw new TypeError("Stripe PaymentIntent metadata must be an object");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(record.metadata)) {
    if (typeof item !== "string") {
      throw new TypeError(
        "Stripe PaymentIntent metadata values must be strings",
      );
    }
    metadata[key] = item;
  }
  return {
    id,
    created: Number(record.created),
    status,
    amount: Number(record.amount),
    amount_received: Number(record.amount_received),
    currency,
    livemode: record.livemode,
    metadata,
  };
}

/** Restricts the live Stripe SDK to the single paginated read this command permits. */
export function adaptStripeForCutover(
  stripe: LiveStripeListBoundary,
): CutoverStripeClient {
  return {
    paymentIntents: {
      async list(input) {
        const page = await stripe.paymentIntents.list(input);
        return { data: page.data, has_more: page.has_more };
      },
    },
  };
}

export async function listPaymentIntentsForCutover(
  stripe: CutoverStripeClient,
  inventoryStart: Date,
  providerFenceAt: Date,
): Promise<StripePaymentIntentRecord[]> {
  completeInventoryStart(inventoryStart.toISOString(), "inventoryStart");
  const gte = 0;
  const lte = Math.floor(providerFenceAt.getTime() / 1000);
  const values: StripePaymentIntentRecord[] = [];
  const seen = new Set<string>();
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.paymentIntents.list({
      created: { gte, lte },
      limit: STRIPE_PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (
      !page ||
      !Array.isArray(page.data) ||
      typeof page.has_more !== "boolean"
    ) {
      throw new TypeError("Stripe PaymentIntent list returned an invalid page");
    }
    const validatedPage: StripePaymentIntentRecord[] = [];
    for (const raw of page.data) {
      const paymentIntent = assertPaymentIntent(raw);
      if (paymentIntent.created < gte || paymentIntent.created > lte) {
        throw new Error(
          `Stripe PaymentIntent ${paymentIntent.id} is outside the requested window`,
        );
      }
      if (seen.has(paymentIntent.id)) {
        throw new Error(
          `Stripe PaymentIntent ${paymentIntent.id} was returned more than once`,
        );
      }
      seen.add(paymentIntent.id);
      validatedPage.push(paymentIntent);
      values.push(paymentIntent);
    }
    if (!page.has_more) {
      return values.sort(
        (left, right) =>
          left.created - right.created || left.id.localeCompare(right.id),
      );
    }
    const last = validatedPage.at(-1);
    if (!last)
      throw new Error(
        "Stripe pagination reported more data from an empty page",
      );
    startingAfter = last.id;
  }
}

function classifyLegacyPayment(
  paymentIntent: StripePaymentIntentRecord,
): CutoverPlanIntent | CutoverPlanBlocker | null {
  const metadata = paymentIntent.metadata;
  if (metadata.type !== "auto_top_up") return null;
  if (metadata.auto_top_up_attempt_id !== undefined) {
    return {
      code: "unexpected_durable_payment",
      paymentIntentId: paymentIntent.id,
      message:
        "A durable-tagged PaymentIntent exists before cutover activation",
    };
  }

  const malformed = (message: string): CutoverPlanBlocker => ({
    code: "malformed_legacy_payment",
    paymentIntentId: paymentIntent.id,
    message,
  });
  const organizationId = metadata.organization_id;
  if (!organizationId || !CANONICAL_UUID.test(organizationId)) {
    return malformed(
      "Legacy PaymentIntent organization metadata is not a canonical UUID",
    );
  }
  const creditAmountCents = canonicalCents(metadata.credits);
  const baseAmountCents = canonicalCents(metadata.base_amount);
  const totalAmountCents = canonicalCents(metadata.total_charged);
  const platformFeeCents = canonicalCents(metadata.platform_fee_amount);
  const affiliateFeePresent = metadata.affiliate_fee_amount !== undefined;
  const affiliateOwnerPresent = metadata.affiliate_owner_id !== undefined;
  const affiliateCodePresent = metadata.affiliate_code_id !== undefined;
  const affiliateFeeCents = affiliateFeePresent
    ? canonicalCents(metadata.affiliate_fee_amount)
    : 0;
  if (
    creditAmountCents === null ||
    creditAmountCents < MIN_CREDIT_AMOUNT_CENTS ||
    creditAmountCents > MAX_CREDIT_AMOUNT_CENTS ||
    baseAmountCents !== creditAmountCents ||
    totalAmountCents !== paymentIntent.amount ||
    platformFeeCents === null ||
    affiliateFeeCents === null ||
    paymentIntent.amount < 1 ||
    paymentIntent.amount > MAX_CHARGE_AMOUNT_CENTS ||
    metadata.fees_included !== "true"
  ) {
    return malformed("Legacy PaymentIntent amount metadata is inconsistent");
  }
  if (
    affiliateFeePresent !== affiliateOwnerPresent ||
    affiliateFeePresent !== affiliateCodePresent ||
    (affiliateFeePresent &&
      (!CANONICAL_UUID.test(metadata.affiliate_owner_id ?? "") ||
        !CANONICAL_UUID.test(metadata.affiliate_code_id ?? "")))
  ) {
    return malformed("Legacy PaymentIntent affiliate metadata is incomplete");
  }
  const expectedPlatformFeeCents = roundPositivePercentCents(
    creditAmountCents,
    20,
  );
  const maxAffiliateFeeCents = roundPositivePercentCents(
    creditAmountCents,
    1000,
  );
  const roundedComponentResidual = Math.abs(
    creditAmountCents +
      platformFeeCents +
      affiliateFeeCents -
      paymentIntent.amount,
  );
  if (
    affiliateFeePresent
      ? platformFeeCents !== expectedPlatformFeeCents ||
        affiliateFeeCents > maxAffiliateFeeCents ||
        roundedComponentResidual > 1
      : affiliateFeeCents !== 0 ||
        (platformFeeCents === 0
          ? paymentIntent.amount !== creditAmountCents
          : platformFeeCents !== expectedPlatformFeeCents ||
            roundedComponentResidual !== 0)
  ) {
    return malformed(
      "Legacy PaymentIntent fee metadata violates billing policy",
    );
  }
  if (
    paymentIntent.currency.toLowerCase() !== "usd" ||
    !paymentIntent.livemode
  ) {
    return malformed("Legacy PaymentIntent is not a live USD payment");
  }
  if (
    paymentIntent.status === "succeeded" &&
    paymentIntent.amount_received !== paymentIntent.amount
  ) {
    return malformed(
      "Succeeded legacy PaymentIntent has an inconsistent received amount",
    );
  }

  return {
    id: paymentIntent.id,
    created: paymentIntent.created,
    organizationId,
    providerStatus: paymentIntent.status,
    creditAmountCents,
    chargeAmountCents: paymentIntent.amount,
    action:
      paymentIntent.status === "succeeded"
        ? "verify_credited_or_review"
        : paymentIntent.status === "canceled"
          ? "verify_canceled_or_review"
          : "manual_review",
  };
}

export async function buildAutoTopUpCutoverPlan(
  input: CutoverPlanInput,
  dependencies: CutoverDependencies,
): Promise<AutoTopUpCutoverPlan> {
  if (!EVIDENCE_TOKEN.test(input.providerFenceEvidence)) {
    throw new TypeError(
      "providerFenceEvidence must be a non-secret evidence token",
    );
  }
  const workerVersion = commitSha(input.workerVersion, "workerVersion");
  const inventoryStart = completeInventoryStart(
    input.inventoryStart.toISOString(),
    "inventoryStart",
  );
  const providerFenceAt = canonicalWholeSecondDate(
    input.providerFenceAt.toISOString(),
    "providerFenceAt",
  );
  if (inventoryStart.getTime() > providerFenceAt.getTime()) {
    throw new TypeError("inventoryStart must not be after providerFenceAt");
  }
  const generatedAt = dependencies.now();
  if (!Number.isFinite(generatedAt.getTime()))
    throw new TypeError("now must be a valid date");

  const [control, paymentIntents] = await Promise.all([
    dependencies.repository.getControl(),
    listPaymentIntentsForCutover(
      dependencies.stripe,
      inventoryStart,
      providerFenceAt,
    ),
  ]);
  const blockers: CutoverPlanBlocker[] = [];
  if (control.mode !== "paused") {
    blockers.push({
      code: "control_not_paused",
      message:
        "The primary auto-top-up control must remain paused during inventory",
    });
  }
  if (dependencies.durableSwitchValue === "true") {
    blockers.push({
      code: "durable_switch_enabled",
      message: "The secondary durable Worker switch is already enabled",
    });
  }
  if (inventoryStart.getTime() > control.pausedAt.getTime()) {
    blockers.push({
      code: "inventory_start_after_pause",
      message: "The inventory window starts after the database pause watermark",
    });
  }
  if (providerFenceAt.getTime() < control.pausedAt.getTime()) {
    blockers.push({
      code: "provider_fence_before_pause",
      message: "The provider fence predates the database pause watermark",
    });
  }
  if (providerFenceAt.getTime() > generatedAt.getTime()) {
    blockers.push({
      code: "provider_fence_in_future",
      message: "The provider fence cannot be in the future",
    });
  }

  const intents: CutoverPlanIntent[] = [];
  for (const paymentIntent of paymentIntents) {
    const classified = classifyLegacyPayment(paymentIntent);
    if (!classified) continue;
    if ("code" in classified) blockers.push(classified);
    else intents.push(classified);
  }
  intents.sort(
    (left, right) =>
      left.created - right.created || left.id.localeCompare(right.id),
  );
  blockers.sort((left, right) =>
    `${left.paymentIntentId ?? ""}:${left.code}`.localeCompare(
      `${right.paymentIntentId ?? ""}:${right.code}`,
    ),
  );

  const withoutFingerprint: Omit<AutoTopUpCutoverPlan, "inventorySha256"> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    workerVersion,
    providerFenceEvidence: input.providerFenceEvidence,
    inventoryStart: inventoryStart.toISOString(),
    providerFenceAt: providerFenceAt.toISOString(),
    control: {
      mode: control.mode,
      pausedAt: control.pausedAt.toISOString(),
      legacyReconciledThrough:
        control.legacyReconciledThrough?.toISOString() ?? null,
    },
    intents,
    blockers,
  };
  return {
    ...withoutFingerprint,
    inventorySha256: fingerprintPlan(withoutFingerprint),
  };
}

function assertReviewedPlan(value: unknown): AutoTopUpCutoverPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Cutover plan must be an object");
  }
  const record = Object.fromEntries(Object.entries(value));
  if (record.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new TypeError("Cutover plan schema version is unsupported");
  }
  const generatedAt = canonicalIsoDate(
    record.generatedAt,
    "plan.generatedAt",
  ).toISOString();
  const inventoryStart = completeInventoryStart(
    record.inventoryStart,
    "plan.inventoryStart",
  ).toISOString();
  const providerFenceAt = canonicalWholeSecondDate(
    record.providerFenceAt,
    "plan.providerFenceAt",
  ).toISOString();
  const workerVersion = commitSha(record.workerVersion, "plan.workerVersion");
  if (
    typeof record.providerFenceEvidence !== "string" ||
    !EVIDENCE_TOKEN.test(record.providerFenceEvidence)
  ) {
    throw new TypeError("plan.providerFenceEvidence is invalid");
  }
  if (
    !record.control ||
    typeof record.control !== "object" ||
    Array.isArray(record.control)
  ) {
    throw new TypeError("plan.control must be an object");
  }
  const controlRecord = Object.fromEntries(Object.entries(record.control));
  if (controlRecord.mode !== "paused" && controlRecord.mode !== "durable") {
    throw new TypeError("plan.control.mode is invalid");
  }
  const pausedAt = canonicalIsoDate(
    controlRecord.pausedAt,
    "plan.control.pausedAt",
  ).toISOString();
  const legacyReconciledThrough =
    controlRecord.legacyReconciledThrough === null
      ? null
      : canonicalIsoDate(
          controlRecord.legacyReconciledThrough,
          "plan.control.legacyReconciledThrough",
        ).toISOString();
  if (!Array.isArray(record.intents) || !Array.isArray(record.blockers)) {
    throw new TypeError("Cutover plan lists are invalid");
  }
  const actions = new Set<CutoverPlanIntent["action"]>([
    "verify_credited_or_review",
    "verify_canceled_or_review",
    "manual_review",
  ]);
  const intents = record.intents.map((value, index): CutoverPlanIntent => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`plan.intents[${index}] must be an object`);
    }
    const intent = Object.fromEntries(Object.entries(value));
    if (
      !Number.isSafeInteger(intent.created) ||
      Number(intent.created) < 0 ||
      !Number.isSafeInteger(intent.creditAmountCents) ||
      Number(intent.creditAmountCents) < 1 ||
      !Number.isSafeInteger(intent.chargeAmountCents) ||
      Number(intent.chargeAmountCents) < 1 ||
      !actions.has(intent.action as CutoverPlanIntent["action"])
    ) {
      throw new TypeError(`plan.intents[${index}] is invalid`);
    }
    return {
      id: requiredString(intent.id, `plan.intents[${index}].id`),
      created: Number(intent.created),
      organizationId: requiredString(
        intent.organizationId,
        `plan.intents[${index}].organizationId`,
      ),
      providerStatus: requiredString(
        intent.providerStatus,
        `plan.intents[${index}].providerStatus`,
      ),
      creditAmountCents: Number(intent.creditAmountCents),
      chargeAmountCents: Number(intent.chargeAmountCents),
      action: intent.action as CutoverPlanIntent["action"],
    };
  });
  const blockerCodes = new Set<CutoverPlanBlocker["code"]>([
    "control_not_paused",
    "durable_switch_enabled",
    "inventory_start_after_pause",
    "provider_fence_before_pause",
    "provider_fence_in_future",
    "malformed_legacy_payment",
    "unexpected_durable_payment",
  ]);
  const blockers = record.blockers.map((value, index): CutoverPlanBlocker => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`plan.blockers[${index}] must be an object`);
    }
    const blocker = Object.fromEntries(Object.entries(value));
    if (!blockerCodes.has(blocker.code as CutoverPlanBlocker["code"])) {
      throw new TypeError(`plan.blockers[${index}].code is invalid`);
    }
    return {
      code: blocker.code as CutoverPlanBlocker["code"],
      message: requiredString(
        blocker.message,
        `plan.blockers[${index}].message`,
      ),
      ...(blocker.paymentIntentId === undefined
        ? {}
        : {
            paymentIntentId: requiredString(
              blocker.paymentIntentId,
              `plan.blockers[${index}].paymentIntentId`,
            ),
          }),
    };
  });
  if (
    typeof record.inventorySha256 !== "string" ||
    !SHA256.test(record.inventorySha256)
  ) {
    throw new TypeError("Cutover plan fingerprint is invalid");
  }
  const plan: AutoTopUpCutoverPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatedAt,
    workerVersion,
    providerFenceEvidence: record.providerFenceEvidence,
    inventoryStart,
    providerFenceAt,
    control: {
      mode: controlRecord.mode,
      pausedAt,
      legacyReconciledThrough,
    },
    intents,
    blockers,
    inventorySha256: record.inventorySha256,
  };
  const { inventorySha256: _fingerprint, ...withoutFingerprint } = plan;
  if (fingerprintPlan(withoutFingerprint) !== plan.inventorySha256) {
    throw new Error(
      "Cutover plan fingerprint does not match its reviewed contents",
    );
  }
  return plan;
}

async function resolveLegacyPayment(
  intent: CutoverPlanIntent,
  inventorySha256: string,
  repository: CutoverRepository,
  now: Date,
): Promise<LegacyResolution> {
  const commonMetadata = {
    source: "auto_top_up_cutover_operator",
    inventorySha256,
    providerCreatedAt: new Date(intent.created * 1000).toISOString(),
    providerStatus: intent.providerStatus,
  };
  const quarantined = await repository.quarantineLegacyPaymentIntent({
    organizationId: intent.organizationId,
    paymentIntentId: intent.id,
    providerStatus: intent.providerStatus,
    creditAmountCents: intent.creditAmountCents,
    metadata: commonMetadata,
    now,
  });
  if (!quarantined) {
    throw new Error(
      `Legacy PaymentIntent ${intent.id} could not be quarantined while paused`,
    );
  }

  const preferred: LegacyResolution | null =
    intent.providerStatus === "succeeded"
      ? "credited"
      : intent.providerStatus === "canceled"
        ? "canceled"
        : null;
  if (preferred) {
    const resolved = await repository.resolveLegacyPaymentIntent({
      paymentIntentId: intent.id,
      resolution: preferred,
      metadata: { ...commonMetadata, resolution: preferred },
      now,
    });
    if (resolved) return preferred;
  }

  const reviewed = await repository.resolveLegacyPaymentIntent({
    paymentIntentId: intent.id,
    resolution: "manual_review",
    metadata: { ...commonMetadata, resolution: "manual_review" },
    now,
  });
  if (!reviewed) {
    throw new Error(
      `Legacy PaymentIntent ${intent.id} could not enter manual review`,
    );
  }
  return "manual_review";
}

function assertCutoverConfirmations(confirmations: ApplyConfirmations): void {
  if (
    !confirmations.providerFence ||
    !confirmations.passiveWorker100Percent ||
    !confirmations.workerSwitchOff ||
    !confirmations.queueAndDlqReconciled ||
    !confirmations.migrationAndRearmBaselines
  ) {
    throw new Error(
      "Cutover requires provider-fence, passive-Worker-100-percent, Worker-switch-off, queue-and-DLQ-reconciled, and migration-and-rearm-baselines confirmations",
    );
  }
}

async function refreshReviewedPlan(
  reviewedValue: unknown,
  confirmations: ApplyConfirmations,
  dependencies: CutoverDependencies,
): Promise<AutoTopUpCutoverPlan> {
  const reviewed = assertReviewedPlan(reviewedValue);
  assertCutoverConfirmations(confirmations);
  if (reviewed.blockers.length > 0) {
    throw new Error("Reviewed cutover plan contains blockers");
  }

  const fresh = await buildAutoTopUpCutoverPlan(
    {
      inventoryStart: completeInventoryStart(
        reviewed.inventoryStart,
        "plan.inventoryStart",
      ),
      providerFenceAt: canonicalWholeSecondDate(
        reviewed.providerFenceAt,
        "plan.providerFenceAt",
      ),
      providerFenceEvidence: reviewed.providerFenceEvidence,
      workerVersion: reviewed.workerVersion,
    },
    dependencies,
  );
  if (fresh.blockers.length > 0) {
    throw new Error("Fresh cutover inventory contains blockers");
  }
  if (fresh.inventorySha256 !== reviewed.inventorySha256) {
    throw new Error(
      "Cutover state drifted after review; generate and review a new dry-run plan",
    );
  }
  return fresh;
}

async function verifyAppliedLegacyPayment(
  intent: CutoverPlanIntent,
  repository: CutoverRepository,
): Promise<LegacyResolution> {
  const expectedMetadata = {
    source: "auto_top_up_cutover_operator",
    providerCreatedAt: new Date(intent.created * 1000).toISOString(),
    providerStatus: intent.providerStatus,
  };
  const observed = await repository.findLegacyPaymentByStripePaymentIntentId(
    intent.id,
  );
  if (!observed) {
    throw new Error(
      `Legacy PaymentIntent ${intent.id} is absent from quarantine; run apply and independently review it before activation`,
    );
  }
  if (observed.status === "unresolved") {
    throw new Error(
      `Legacy PaymentIntent ${intent.id} remains unresolved; finish apply and independently review it before activation`,
    );
  }

  const resolution = observed.status;
  const allowedResolution =
    resolution === "manual_review" ||
    (intent.providerStatus === "succeeded" && resolution === "credited") ||
    (intent.providerStatus === "canceled" && resolution === "canceled");
  const metadata = observed.metadata;
  const expectedMetadataKeys = [
    "inventorySha256",
    "providerCreatedAt",
    "providerStatus",
    "resolution",
    "source",
  ];
  const metadataKeys = Object.keys(metadata).sort();
  const metadataMatches =
    metadataKeys.length === expectedMetadataKeys.length &&
    metadataKeys.every((key, index) => key === expectedMetadataKeys[index]) &&
    metadata.source === expectedMetadata.source &&
    typeof metadata.inventorySha256 === "string" &&
    SHA256.test(metadata.inventorySha256) &&
    metadata.providerCreatedAt === expectedMetadata.providerCreatedAt &&
    metadata.providerStatus === expectedMetadata.providerStatus &&
    metadata.resolution === resolution;
  const creditLinkMatches =
    resolution === "credited"
      ? typeof observed.creditTransactionId === "string" &&
        CANONICAL_UUID.test(observed.creditTransactionId)
      : observed.creditTransactionId === null;
  const resolutionTimeMatches =
    resolution === "manual_review"
      ? observed.resolvedAt === null
      : observed.resolvedAt instanceof Date &&
        Number.isFinite(observed.resolvedAt.getTime());

  if (
    observed.organizationId !== intent.organizationId ||
    observed.stripePaymentIntentId !== intent.id ||
    observed.providerStatus !== intent.providerStatus ||
    observed.creditAmountCents !== intent.creditAmountCents ||
    !allowedResolution ||
    !metadataMatches ||
    !creditLinkMatches ||
    !resolutionTimeMatches
  ) {
    throw new Error(
      `Legacy PaymentIntent ${intent.id} differs from the reviewed applied state; rerun apply and independently review it before activation`,
    );
  }
  return resolution;
}

export async function applyAutoTopUpCutoverPlan(
  reviewedValue: unknown,
  confirmations: ApplyConfirmations,
  dependencies: CutoverDependencies,
): Promise<AppliedCutoverResult> {
  const fresh = await refreshReviewedPlan(
    reviewedValue,
    confirmations,
    dependencies,
  );

  const appliedAt = dependencies.now();
  if (!Number.isFinite(appliedAt.getTime()))
    throw new TypeError("now must be a valid date");
  const resolutions: AppliedCutoverResult["resolutions"] = [];
  for (const intent of fresh.intents) {
    const resolution = await resolveLegacyPayment(
      intent,
      fresh.inventorySha256,
      dependencies.repository,
      appliedAt,
    );
    resolutions.push({ paymentIntentId: intent.id, resolution });
  }

  const control = await dependencies.repository.getControl();
  if (control.mode !== "paused") {
    throw new Error(
      "Auto-top-up control changed while the reviewed inventory was applied",
    );
  }
  return {
    inventorySha256: fresh.inventorySha256,
    resolutions,
    control,
  };
}

export async function activateAutoTopUpCutoverPlan(
  reviewedValue: unknown,
  confirmations: ApplyConfirmations,
  dependencies: CutoverDependencies,
): Promise<ActivatedCutoverResult> {
  const fresh = await refreshReviewedPlan(
    reviewedValue,
    confirmations,
    dependencies,
  );
  const activatedAt = dependencies.now();
  if (!Number.isFinite(activatedAt.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  const resolutions: ActivatedCutoverResult["resolutions"] = [];
  for (const intent of fresh.intents) {
    const resolution = await verifyAppliedLegacyPayment(
      intent,
      dependencies.repository,
    );
    resolutions.push({ paymentIntentId: intent.id, resolution });
  }

  const transition = await dependencies.repository.transitionControl({
    expectedMode: "paused",
    targetMode: "durable",
    now: activatedAt,
    legacyReconciledThrough: canonicalWholeSecondDate(
      fresh.providerFenceAt,
      "plan.providerFenceAt",
    ),
  });
  if (transition.outcome !== "applied") {
    throw new Error(
      `Auto-top-up control transition was blocked: ${transition.reason}`,
    );
  }
  if (transition.control.mode !== "durable") {
    throw new Error(
      "Auto-top-up control transition returned a non-durable state",
    );
  }
  return {
    inventorySha256: fresh.inventorySha256,
    resolutions,
    control: { ...transition.control, mode: "durable" },
  };
}

export async function pauseAutoTopUpForRollback(
  databasePauseFirst: boolean,
  dependencies: Pick<CutoverDependencies, "repository" | "now">,
): Promise<PausedRollbackResult> {
  if (!databasePauseFirst) {
    throw new Error(
      "Rollback pause requires confirmation that the database is paused before the Worker switch is changed",
    );
  }
  const observed = await dependencies.repository.getControl();
  if (observed.mode === "paused") {
    return {
      outcome: "already_paused",
      control: { ...observed, mode: "paused" },
    };
  }
  const pausedAt = dependencies.now();
  if (!Number.isFinite(pausedAt.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  const transition = await dependencies.repository.transitionControl({
    expectedMode: "durable",
    targetMode: "paused",
    now: pausedAt,
  });
  if (transition.outcome !== "applied") {
    if (transition.control.mode === "paused") {
      return {
        outcome: "already_paused",
        control: { ...transition.control, mode: "paused" },
      };
    }
    throw new Error(
      `Auto-top-up rollback pause was blocked: ${transition.reason}`,
    );
  }
  if (transition.control.mode !== "paused") {
    throw new Error(
      "Auto-top-up rollback transition returned a non-paused state",
    );
  }
  return {
    outcome: "paused",
    control: { ...transition.control, mode: "paused" },
  };
}

export function pausedRollbackOutput(result: PausedRollbackResult) {
  return {
    mode: "pause-for-rollback" as const,
    outcome: result.outcome,
    controlMode: result.control.mode,
    pausedAt: result.control.pausedAt.toISOString(),
    nextStep:
      "The primary database is paused; now remove or set AUTO_TOP_UP_DURABLE_ENABLED to false.",
  };
}

export function parseOperatorArgs(argv: string[]): OperatorArgs {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      apply: { type: "boolean", default: false },
      activate: { type: "boolean", default: false },
      "pause-for-rollback": { type: "boolean", default: false },
      plan: { type: "string" },
      output: { type: "string" },
      "inventory-start": { type: "string" },
      "provider-fence-at": { type: "string" },
      "provider-fence-evidence": { type: "string" },
      "worker-version": { type: "string" },
      "confirm-provider-fence": { type: "boolean", default: false },
      "confirm-passive-worker-100-percent": {
        type: "boolean",
        default: false,
      },
      "confirm-worker-switch-off": { type: "boolean", default: false },
      "confirm-queue-and-dlq-reconciled": {
        type: "boolean",
        default: false,
      },
      "confirm-migration-and-rearm-baselines": {
        type: "boolean",
        default: false,
      },
      "confirm-database-pause-first": { type: "boolean", default: false },
    },
  });
  const values = parsed.values;
  const selectedMutationModes = [
    values.apply,
    values.activate,
    values["pause-for-rollback"],
  ].filter(Boolean).length;
  if (selectedMutationModes > 1) {
    throw new Error(
      "Choose exactly one of --apply, --activate, or --pause-for-rollback",
    );
  }
  if (values["pause-for-rollback"]) {
    if (
      values.plan ||
      values.output ||
      values["inventory-start"] ||
      values["provider-fence-at"] ||
      values["provider-fence-evidence"] ||
      values["worker-version"] ||
      values["confirm-provider-fence"] ||
      values["confirm-passive-worker-100-percent"] ||
      values["confirm-worker-switch-off"] ||
      values["confirm-queue-and-dlq-reconciled"] ||
      values["confirm-migration-and-rearm-baselines"] ||
      !values["confirm-database-pause-first"]
    ) {
      throw new Error(
        "Rollback pause requires only --confirm-database-pause-first",
      );
    }
    return {
      mode: "pause-for-rollback",
      databasePauseFirst: true,
    };
  }
  if (values.apply || values.activate) {
    if (
      !values.plan ||
      values.output ||
      values["inventory-start"] ||
      values["provider-fence-at"] ||
      values["provider-fence-evidence"] ||
      values["worker-version"] ||
      values["confirm-database-pause-first"]
    ) {
      throw new Error(
        "Apply and activate require only --plan plus all five confirmation flags",
      );
    }
    const confirmations = {
      providerFence: values["confirm-provider-fence"],
      passiveWorker100Percent: values["confirm-passive-worker-100-percent"],
      workerSwitchOff: values["confirm-worker-switch-off"],
      queueAndDlqReconciled: values["confirm-queue-and-dlq-reconciled"],
      migrationAndRearmBaselines:
        values["confirm-migration-and-rearm-baselines"],
    };
    assertCutoverConfirmations(confirmations);
    return {
      mode: values.apply ? "apply" : "activate",
      plan: values.plan,
      confirmations,
    };
  }
  if (
    values.plan ||
    values["confirm-provider-fence"] ||
    values["confirm-passive-worker-100-percent"] ||
    values["confirm-worker-switch-off"] ||
    values["confirm-queue-and-dlq-reconciled"] ||
    values["confirm-migration-and-rearm-baselines"] ||
    values["confirm-database-pause-first"]
  ) {
    throw new Error("Dry-run rejects apply-only plan and confirmation flags");
  }
  return {
    mode: "dry-run",
    input: {
      inventoryStart: completeInventoryStart(
        values["inventory-start"],
        "--inventory-start",
      ),
      providerFenceAt: canonicalWholeSecondDate(
        values["provider-fence-at"],
        "--provider-fence-at",
      ),
      providerFenceEvidence: requiredString(
        values["provider-fence-evidence"],
        "--provider-fence-evidence",
      ),
      workerVersion: commitSha(values["worker-version"], "--worker-version"),
    },
    ...(values.output ? { output: values.output } : {}),
  };
}

async function liveRepositoryDependencies(): Promise<
  Pick<CutoverDependencies, "repository" | "now">
> {
  const { autoTopUpAttemptsRepository } = await import(
    "../../shared/src/db/repositories/auto-top-up-attempts"
  );
  return {
    repository: autoTopUpAttemptsRepository,
    now: () => new Date(),
  };
}

async function liveDependencies(): Promise<CutoverDependencies> {
  const [{ requireStripe }, { getCloudAwareEnv }, repositoryDependencies] =
    await Promise.all([
      import("../../shared/src/lib/stripe"),
      import("../../shared/src/lib/runtime/cloud-bindings"),
      liveRepositoryDependencies(),
    ]);
  return {
    ...repositoryDependencies,
    stripe: adaptStripeForCutover(requireStripe()),
    durableSwitchValue: getCloudAwareEnv().AUTO_TOP_UP_DURABLE_ENABLED,
  };
}

async function main(): Promise<void> {
  const args = parseOperatorArgs(process.argv.slice(2));
  if (args.mode === "pause-for-rollback") {
    const dependencies = await liveRepositoryDependencies();
    const result = await pauseAutoTopUpForRollback(
      args.databasePauseFirst,
      dependencies,
    );
    console.log(JSON.stringify(pausedRollbackOutput(result)));
    return;
  }
  const dependencies = await liveDependencies();
  if (args.mode === "dry-run") {
    const plan = await buildAutoTopUpCutoverPlan(args.input, dependencies);
    const serialized = `${JSON.stringify(plan, null, 2)}\n`;
    if (args.output)
      writeFileSync(args.output, serialized, { flag: "wx", mode: 0o600 });
    else console.log(serialized.trimEnd());
    console.log(
      JSON.stringify({
        mode: "dry-run",
        providerInventoryReady: plan.blockers.length === 0,
        legacyPayments: plan.intents.length,
        blockers: plan.blockers.length,
        inventorySha256: plan.inventorySha256,
        output: args.output ?? null,
        activationReadiness:
          "Database activation blockers are authoritatively checked by the repository CAS during --activate.",
      }),
    );
    if (plan.blockers.length > 0) {
      throw new Error("Dry-run found cutover blockers; no changes were made");
    }
    return;
  }

  const reviewed = JSON.parse(readFileSync(args.plan, "utf8")) as unknown;
  if (args.mode === "apply") {
    const applied = await applyAutoTopUpCutoverPlan(
      reviewed,
      args.confirmations,
      dependencies,
    );
    console.log(
      JSON.stringify({
        mode: "apply",
        inventorySha256: applied.inventorySha256,
        resolutions: applied.resolutions,
        controlMode: applied.control.mode,
        nextStep:
          "Independently review the applied resolutions, then rerun this reviewed plan with --activate and all five attestations.",
        rollback:
          "The database remains paused; keep AUTO_TOP_UP_DURABLE_ENABLED absent or false.",
      }),
    );
    return;
  }

  const activated = await activateAutoTopUpCutoverPlan(
    reviewed,
    args.confirmations,
    dependencies,
  );
  console.log(
    JSON.stringify({
      mode: "activate",
      inventorySha256: activated.inventorySha256,
      resolutions: activated.resolutions,
      controlMode: activated.control.mode,
      legacyReconciledThrough:
        activated.control.legacyReconciledThrough?.toISOString() ?? null,
      nextStep:
        "After independent review, bind AUTO_TOP_UP_DURABLE_ENABLED to exact true.",
      rollback:
        "Transition the database control durable -> paused first, then remove/false the Worker switch.",
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // error-policy:J1 The CLI boundary emits one curated failure and exits non-zero.
    console.error(
      error instanceof Error ? error.message : "Auto-top-up cutover failed",
    );
    process.exitCode = 1;
  });
}
