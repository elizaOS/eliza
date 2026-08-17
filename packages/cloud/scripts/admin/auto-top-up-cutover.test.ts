/**
 * Proves the auto-top-up cutover command is a dry-run-first, paginated, and
 * hermetic operator whose apply phase leaves charging paused and whose
 * activation phase can advance control only through the repository CAS.
 */

import { describe, expect, test } from "bun:test";
import {
  type AutoTopUpControlSnapshot,
  activateAutoTopUpCutoverPlan,
  applyAutoTopUpCutoverPlan,
  buildAutoTopUpCutoverPlan,
  type CutoverDependencies,
  type CutoverLegacyPaymentSnapshot,
  type CutoverRepository,
  parseOperatorArgs,
  pauseAutoTopUpForRollback,
  pausedRollbackOutput,
  type StripePaymentIntentListInput,
  type StripePaymentIntentRecord,
} from "./auto-top-up-cutover";

const WORKER_SHA = "a".repeat(40);
const INVENTORY_START = new Date("1970-01-01T00:00:00.000Z");
const PAUSED_AT = new Date("2026-08-17T10:00:00.000Z");
const PROVIDER_FENCE = new Date("2026-08-17T11:00:00.000Z");
const NOW = new Date("2026-08-17T12:00:00.000Z");
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const AFFILIATE_OWNER_ID = "20000000-0000-4000-8000-000000000002";
const AFFILIATE_CODE_ID = "30000000-0000-4000-8000-000000000003";
const CONFIRMATIONS = {
  providerFence: true,
  passiveWorker100Percent: true,
  workerSwitchOff: true,
  queueAndDlqReconciled: true,
  migrationAndRearmBaselines: true,
};

function legacyPayment(
  overrides: Partial<StripePaymentIntentRecord> & {
    metadata?: Record<string, string>;
  } = {},
): StripePaymentIntentRecord {
  const { metadata, ...recordOverrides } = overrides;
  return {
    id: "pi_legacy_1",
    created: Math.floor(PAUSED_AT.getTime() / 1000),
    status: "succeeded",
    amount: 1_000,
    amount_received: 1_000,
    currency: "usd",
    livemode: true,
    metadata: {
      type: "auto_top_up",
      organization_id: ORGANIZATION_ID,
      credits: "10.00",
      base_amount: "10.00",
      total_charged: "10.00",
      platform_fee_amount: "0.00",
      fees_included: "true",
      ...metadata,
    },
    ...recordOverrides,
  };
}

function affiliatePayment(
  overrides: Partial<StripePaymentIntentRecord> & {
    metadata?: Record<string, string>;
  } = {},
): StripePaymentIntentRecord {
  const { metadata, ...recordOverrides } = overrides;
  return legacyPayment({
    amount: 1_500,
    amount_received: 1_500,
    ...recordOverrides,
    metadata: {
      total_charged: "15.00",
      platform_fee_amount: "2.00",
      affiliate_fee_amount: "3.00",
      affiliate_owner_id: AFFILIATE_OWNER_ID,
      affiliate_code_id: AFFILIATE_CODE_ID,
      ...metadata,
    },
  });
}

interface HarnessOptions {
  pages?: StripePaymentIntentRecord[][];
  durableSwitchValue?: string;
  preferredResolutionAvailable?: boolean;
  now?: Date;
  pausedAt?: Date;
  controlMode?: "paused" | "durable";
}

function harness(options: HarnessOptions = {}) {
  const pages = options.pages ?? [[legacyPayment()]];
  let control: AutoTopUpControlSnapshot = {
    mode: options.controlMode ?? "paused",
    pausedAt: options.pausedAt ?? PAUSED_AT,
    legacyReconciledThrough: null,
  };
  const quarantined = new Set<string>();
  const resolutions = new Map<string, string>();
  const quarantineRows = new Map<string, CutoverLegacyPaymentSnapshot>();
  const calls = {
    getControl: 0,
    list: [] as StripePaymentIntentListInput[],
    quarantine: [] as Array<Record<string, unknown>>,
    resolve: [] as Array<Record<string, unknown>>,
    readLegacy: [] as string[],
    transition: [] as Array<Record<string, unknown>>,
  };
  const repository: CutoverRepository = {
    async getControl() {
      calls.getControl += 1;
      return { ...control };
    },
    async quarantineLegacyPaymentIntent(input) {
      calls.quarantine.push(input);
      const existing = quarantineRows.get(input.paymentIntentId);
      if (existing) {
        if (existing.providerStatus === input.providerStatus) {
          return { ...existing };
        }
        const refreshed = {
          ...existing,
          providerStatus: input.providerStatus,
          metadata: input.metadata,
        };
        quarantineRows.set(input.paymentIntentId, refreshed);
        return { ...refreshed };
      }
      quarantined.add(input.paymentIntentId);
      const row: CutoverLegacyPaymentSnapshot = {
        organizationId: input.organizationId,
        stripePaymentIntentId: input.paymentIntentId,
        providerStatus: input.providerStatus,
        creditAmountCents: input.creditAmountCents,
        status: "unresolved",
        creditTransactionId: null,
        metadata: input.metadata,
        resolvedAt: null,
      };
      quarantineRows.set(input.paymentIntentId, row);
      return { ...row };
    },
    async resolveLegacyPaymentIntent(input) {
      calls.resolve.push(input);
      const row = quarantineRows.get(input.paymentIntentId);
      if (!row) return null;
      const existing = resolutions.get(input.paymentIntentId);
      if (existing) {
        if (existing === input.resolution) return { ...row };
        if (existing !== "manual_review") return null;
      }
      if (
        input.resolution !== "manual_review" &&
        options.preferredResolutionAvailable === false
      ) {
        return null;
      }
      resolutions.set(input.paymentIntentId, input.resolution);
      const resolved: CutoverLegacyPaymentSnapshot = {
        ...row,
        status: input.resolution,
        creditTransactionId:
          input.resolution === "credited"
            ? "40000000-0000-4000-8000-000000000004"
            : null,
        metadata: input.metadata,
        resolvedAt: input.resolution === "manual_review" ? null : input.now,
      };
      quarantineRows.set(input.paymentIntentId, resolved);
      return { ...resolved };
    },
    async findLegacyPaymentByStripePaymentIntentId(paymentIntentId) {
      calls.readLegacy.push(paymentIntentId);
      const row = quarantineRows.get(paymentIntentId);
      return row ? { ...row } : null;
    },
    async transitionControl(input) {
      calls.transition.push(input);
      if (control.mode !== input.expectedMode) {
        return { outcome: "not_applied", reason: "mode_changed", control };
      }
      control = {
        mode: input.targetMode,
        pausedAt: input.targetMode === "paused" ? input.now : control.pausedAt,
        legacyReconciledThrough:
          input.targetMode === "paused"
            ? null
            : (input.legacyReconciledThrough ??
              control.legacyReconciledThrough),
      };
      return { outcome: "applied", control };
    },
  };
  const dependencies: CutoverDependencies = {
    repository,
    stripe: {
      paymentIntents: {
        async list(input) {
          calls.list.push(input);
          const index = calls.list.length - 1;
          const page = pages[index % pages.length] ?? [];
          return {
            data: page,
            has_more: index % pages.length < pages.length - 1,
          };
        },
      },
    },
    now: () => new Date(options.now ?? NOW),
    durableSwitchValue: options.durableSwitchValue,
  };
  return {
    calls,
    dependencies,
    quarantined,
    quarantineRows,
    resolutions,
  };
}

async function planFor(dependencies: CutoverDependencies) {
  return buildAutoTopUpCutoverPlan(
    {
      inventoryStart: INVENTORY_START,
      providerFenceAt: PROVIDER_FENCE,
      providerFenceEvidence: "INC-20717-provider-fence",
      workerVersion: WORKER_SHA,
    },
    dependencies,
  );
}

describe("auto-top-up cutover operator", () => {
  test("defaults to a read-only paginated Stripe inventory with a fixed high-water", async () => {
    const first = legacyPayment({ id: "pi_first" });
    const second = legacyPayment({
      id: "pi_second",
      created: first.created + 1,
      status: "canceled",
      amount_received: 0,
    });
    const state = harness({ pages: [[first], [second]] });

    const plan = await planFor(state.dependencies);

    expect(plan.blockers).toEqual([]);
    expect(plan.intents.map((intent) => intent.id)).toEqual([
      "pi_first",
      "pi_second",
    ]);
    expect(state.calls.list).toEqual([
      {
        created: {
          gte: 0,
          lte: Math.floor(PROVIDER_FENCE.getTime() / 1000),
        },
        limit: 100,
      },
      {
        created: {
          gte: 0,
          lte: Math.floor(PROVIDER_FENCE.getTime() / 1000),
        },
        limit: 100,
        starting_after: "pi_first",
      },
    ]);
    expect(state.calls.quarantine).toEqual([]);
    expect(state.calls.resolve).toEqual([]);
    expect(state.calls.transition).toEqual([]);
  });

  test("refuses an incomplete provider inventory lower bound before any read", async () => {
    const state = harness();

    await expect(
      buildAutoTopUpCutoverPlan(
        {
          inventoryStart: new Date("2026-08-17T09:00:00.000Z"),
          providerFenceAt: PROVIDER_FENCE,
          providerFenceEvidence: "INC-20717-provider-fence",
          workerVersion: WORKER_SHA,
        },
        state.dependencies,
      ),
    ).rejects.toThrow("must be the Unix epoch");
    expect(state.calls.getControl).toBe(0);
    expect(state.calls.list).toEqual([]);
  });

  test("blocks exact money metadata that violates affiliate fee policy", async () => {
    const excessiveNoAffiliateFee = legacyPayment({
      id: "pi_no_affiliate_overcharge",
      amount: 1_100,
      amount_received: 1_100,
      metadata: {
        total_charged: "11.00",
        platform_fee_amount: "1.00",
      },
    });
    const wrongPlatformFee = affiliatePayment({
      id: "pi_wrong_platform_fee",
      amount: 1_501,
      amount_received: 1_501,
      metadata: {
        total_charged: "15.01",
        platform_fee_amount: "2.01",
      },
    });
    const excessiveAffiliateFee = affiliatePayment({
      id: "pi_excessive_affiliate_fee",
      amount: 111_201,
      amount_received: 111_201,
      metadata: {
        total_charged: "1112.01",
        affiliate_fee_amount: "1100.01",
      },
    });
    const invalidOrganization = legacyPayment({
      id: "pi_invalid_organization",
      metadata: { organization_id: "org-not-a-uuid" },
    });
    const invalidAffiliateIdentity = affiliatePayment({
      id: "pi_invalid_affiliate_identity",
      metadata: { affiliate_owner_id: "owner-not-a-uuid" },
    });
    const belowLegacyMinimum = legacyPayment({
      id: "pi_below_legacy_minimum",
      amount: 99,
      amount_received: 99,
      metadata: {
        credits: "0.99",
        base_amount: "0.99",
        total_charged: "0.99",
      },
    });
    const impossibleZeroMarkupResidual = legacyPayment({
      id: "pi_zero_markup_residual",
      amount: 1_201,
      amount_received: 1_201,
      metadata: {
        total_charged: "12.01",
        platform_fee_amount: "2.00",
      },
    });
    const state = harness({
      pages: [
        [
          excessiveNoAffiliateFee,
          wrongPlatformFee,
          excessiveAffiliateFee,
          invalidOrganization,
          invalidAffiliateIdentity,
          belowLegacyMinimum,
          impossibleZeroMarkupResidual,
        ],
      ],
    });

    const plan = await planFor(state.dependencies);

    expect(plan.blockers).toHaveLength(7);
    expect(
      plan.blockers.map((blocker) => blocker.paymentIntentId).sort(),
    ).toEqual([
      "pi_below_legacy_minimum",
      "pi_excessive_affiliate_fee",
      "pi_invalid_affiliate_identity",
      "pi_invalid_organization",
      "pi_no_affiliate_overcharge",
      "pi_wrong_platform_fee",
      "pi_zero_markup_residual",
    ]);
    expect(
      plan.blockers.every(
        (blocker) => blocker.code === "malformed_legacy_payment",
      ),
    ).toBe(true);
  });

  test("accepts legacy independent rounding and zero-markup platform fees", async () => {
    const independentlyRounded = affiliatePayment({
      id: "pi_fractional_rounding",
      amount: 143,
      amount_received: 143,
      metadata: {
        credits: "1.02",
        base_amount: "1.02",
        total_charged: "1.43",
        platform_fee_amount: "0.20",
        affiliate_fee_amount: "0.20",
      },
    });
    const zeroMarkup = legacyPayment({
      id: "pi_zero_markup",
      amount: 1_200,
      amount_received: 1_200,
      metadata: {
        total_charged: "12.00",
        platform_fee_amount: "2.00",
      },
    });
    const state = harness({ pages: [[independentlyRounded, zeroMarkup]] });

    const plan = await planFor(state.dependencies);

    expect(plan.blockers).toEqual([]);
    expect(plan.intents.map((intent) => intent.id).sort()).toEqual([
      "pi_fractional_rounding",
      "pi_zero_markup",
    ]);
  });

  test("blocks durable-tagged provider work and an enabled secondary switch", async () => {
    const state = harness({
      durableSwitchValue: "true",
      pages: [
        [
          legacyPayment({
            metadata: { auto_top_up_attempt_id: "attempt-1" },
          }),
          legacyPayment({
            id: "pi_empty_durable_marker",
            metadata: { auto_top_up_attempt_id: "" },
          }),
        ],
      ],
    });

    const plan = await planFor(state.dependencies);

    expect(plan.blockers.map((blocker) => blocker.code).sort()).toEqual([
      "durable_switch_enabled",
      "unexpected_durable_payment",
      "unexpected_durable_payment",
    ]);
  });

  test("apply resolves reviewed legacy work while leaving database control paused", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);

    const result = await applyAutoTopUpCutoverPlan(
      plan,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(result.control.mode).toBe("paused");
    expect(result.resolutions).toEqual([
      { paymentIntentId: "pi_legacy_1", resolution: "credited" },
    ]);
    expect(state.calls.quarantine).toHaveLength(1);
    expect(state.calls.resolve).toHaveLength(1);
    expect(state.calls.transition).toEqual([]);
  });

  test("round-trips real database and operator timestamps with milliseconds", async () => {
    const state = harness({
      now: new Date("2026-08-17T12:00:00.123Z"),
      pausedAt: new Date("2026-08-17T10:00:00.456Z"),
    });
    const plan = await planFor(state.dependencies);

    const result = await applyAutoTopUpCutoverPlan(
      JSON.parse(JSON.stringify(plan)),
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(plan.generatedAt).toBe("2026-08-17T12:00:00.123Z");
    expect(plan.control.pausedAt).toBe("2026-08-17T10:00:00.456Z");
    expect(result.control.mode).toBe("paused");
  });

  test("apply falls back to durable manual review when a terminal proof is absent", async () => {
    const state = harness({ preferredResolutionAvailable: false });
    const plan = await planFor(state.dependencies);

    const result = await applyAutoTopUpCutoverPlan(
      plan,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(result.resolutions).toEqual([
      { paymentIntentId: "pi_legacy_1", resolution: "manual_review" },
    ]);
    expect(state.calls.resolve.map((call) => call.resolution)).toEqual([
      "credited",
      "manual_review",
    ]);
    expect(state.calls.transition).toEqual([]);

    const reviewedBeforeActivation = state.quarantineRows.get("pi_legacy_1");
    const resolveCallsBeforeActivation = state.calls.resolve.length;
    const activated = await activateAutoTopUpCutoverPlan(
      plan,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(activated.resolutions).toEqual([
      { paymentIntentId: "pi_legacy_1", resolution: "manual_review" },
    ]);
    expect(state.calls.resolve).toHaveLength(resolveCallsBeforeActivation);
    expect(state.quarantineRows.get("pi_legacy_1")).toEqual(
      reviewedBeforeActivation,
    );
  });

  test("replays a partially completed apply through idempotent repository operations", async () => {
    const state = harness({
      pages: [
        [
          legacyPayment({ id: "pi_first" }),
          legacyPayment({
            id: "pi_second",
            created: Math.floor(PAUSED_AT.getTime() / 1000) + 1,
          }),
        ],
      ],
    });
    const plan = await planFor(state.dependencies);
    const originalQuarantine =
      state.dependencies.repository.quarantineLegacyPaymentIntent;
    let interruptSecondPayment = true;
    state.dependencies.repository.quarantineLegacyPaymentIntent = async (
      input,
    ) => {
      if (input.paymentIntentId === "pi_second" && interruptSecondPayment) {
        interruptSecondPayment = false;
        throw new Error("simulated operator interruption");
      }
      return originalQuarantine(input);
    };

    await expect(
      applyAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("simulated operator interruption");
    expect(state.quarantined).toEqual(new Set(["pi_first"]));
    expect(state.resolutions).toEqual(new Map([["pi_first", "credited"]]));

    const replay = await applyAutoTopUpCutoverPlan(
      plan,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(replay.resolutions).toEqual([
      { paymentIntentId: "pi_first", resolution: "credited" },
      { paymentIntentId: "pi_second", resolution: "credited" },
    ]);
    expect(state.quarantined).toEqual(new Set(["pi_first", "pi_second"]));
    expect(state.resolutions).toEqual(
      new Map([
        ["pi_first", "credited"],
        ["pi_second", "credited"],
      ]),
    );
    expect(state.calls.transition).toEqual([]);
  });

  test("activate refuses unapplied inventory and never reaches the control CAS", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);

    await expect(
      activateAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("run apply and independently review");
    expect(state.calls.quarantine).toEqual([]);
    expect(state.calls.resolve).toEqual([]);
    expect(state.calls.readLegacy).toEqual(["pi_legacy_1"]);
    expect(state.calls.transition).toEqual([]);
  });

  test("activate refuses a partially applied unresolved quarantine without mutating it", async () => {
    const state = harness({
      pages: [
        [
          legacyPayment({ id: "pi_first" }),
          legacyPayment({
            id: "pi_second",
            created: Math.floor(PAUSED_AT.getTime() / 1000) + 1,
          }),
        ],
      ],
    });
    const plan = await planFor(state.dependencies);
    const originalResolve =
      state.dependencies.repository.resolveLegacyPaymentIntent;
    state.dependencies.repository.resolveLegacyPaymentIntent = async (
      input,
    ) => {
      if (input.paymentIntentId === "pi_second") {
        throw new Error("simulated interruption after quarantine");
      }
      return originalResolve(input);
    };

    await expect(
      applyAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("simulated interruption after quarantine");
    expect(state.quarantineRows.get("pi_first")?.status).toBe("credited");
    expect(state.quarantineRows.get("pi_second")?.status).toBe("unresolved");
    const quarantineCallsBeforeActivation = state.calls.quarantine.length;
    const resolveCallsBeforeActivation = state.calls.resolve.length;

    await expect(
      activateAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("remains unresolved");

    expect(state.calls.quarantine).toHaveLength(
      quarantineCallsBeforeActivation,
    );
    expect(state.calls.resolve).toHaveLength(resolveCallsBeforeActivation);
    expect(state.quarantineRows.get("pi_second")?.status).toBe("unresolved");
    expect(state.calls.transition).toEqual([]);
  });

  test("activate rechecks resolved inventory and advances only through repository CAS", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);
    await applyAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies);
    const quarantineCallsBeforeActivation = state.calls.quarantine.length;
    const resolveCallsBeforeActivation = state.calls.resolve.length;

    const result = await activateAutoTopUpCutoverPlan(
      plan,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(result.control.mode).toBe("durable");
    expect(result.control.legacyReconciledThrough).toEqual(PROVIDER_FENCE);
    expect(state.calls.quarantine).toHaveLength(
      quarantineCallsBeforeActivation,
    );
    expect(state.calls.resolve).toHaveLength(resolveCallsBeforeActivation);
    expect(state.calls.readLegacy).toEqual(["pi_legacy_1"]);
    expect(state.calls.transition).toEqual([
      {
        expectedMode: "paused",
        targetMode: "durable",
        now: NOW,
        legacyReconciledThrough: PROVIDER_FENCE,
      },
    ]);
  });

  test("activate refuses reviewed quarantine drift without any mutation", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);
    await applyAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies);
    const applied = state.quarantineRows.get("pi_legacy_1");
    if (!applied) throw new Error("expected an applied quarantine row");
    state.quarantineRows.set("pi_legacy_1", {
      ...applied,
      metadata: {
        ...applied.metadata,
        inventorySha256: "not-a-canonical-sha",
      },
    });
    const quarantineCallsBeforeActivation = state.calls.quarantine.length;
    const resolveCallsBeforeActivation = state.calls.resolve.length;

    await expect(
      activateAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("differs from the reviewed applied state");

    expect(state.calls.quarantine).toHaveLength(
      quarantineCallsBeforeActivation,
    );
    expect(state.calls.resolve).toHaveLength(resolveCallsBeforeActivation);
    expect(state.calls.transition).toEqual([]);
  });

  test("a refreshed plan activates read-only with stable terminal evidence from its prior plan", async () => {
    const stable = legacyPayment({ id: "pi_stable" });
    const evolving = legacyPayment({
      id: "pi_evolving",
      created: stable.created + 1,
      status: "processing",
      amount_received: 0,
    });
    const state = harness({ pages: [[stable, evolving]] });
    const planA = await planFor(state.dependencies);
    await applyAutoTopUpCutoverPlan(planA, CONFIRMATIONS, state.dependencies);
    expect(state.quarantineRows.get("pi_stable")?.status).toBe("credited");
    expect(state.quarantineRows.get("pi_evolving")?.status).toBe(
      "manual_review",
    );

    const canceled = legacyPayment({
      id: "pi_evolving",
      created: evolving.created,
      status: "canceled",
      amount_received: 0,
    });
    state.dependencies.stripe.paymentIntents.list = async (input) => {
      state.calls.list.push(input);
      return { data: [stable, canceled], has_more: false };
    };
    const planB = await planFor(state.dependencies);
    expect(planB.inventorySha256).not.toBe(planA.inventorySha256);
    await applyAutoTopUpCutoverPlan(planB, CONFIRMATIONS, state.dependencies);

    expect(
      state.quarantineRows.get("pi_stable")?.metadata.inventorySha256,
    ).toBe(planA.inventorySha256);
    expect(
      state.quarantineRows.get("pi_evolving")?.metadata.inventorySha256,
    ).toBe(planB.inventorySha256);
    expect(state.quarantineRows.get("pi_evolving")?.status).toBe("canceled");
    const quarantineCallsBeforeActivation = state.calls.quarantine.length;
    const resolveCallsBeforeActivation = state.calls.resolve.length;

    const activated = await activateAutoTopUpCutoverPlan(
      planB,
      CONFIRMATIONS,
      state.dependencies,
    );

    expect(activated.control.mode).toBe("durable");
    expect(activated.resolutions).toEqual([
      { paymentIntentId: "pi_stable", resolution: "credited" },
      { paymentIntentId: "pi_evolving", resolution: "canceled" },
    ]);
    expect(state.calls.quarantine).toHaveLength(
      quarantineCallsBeforeActivation,
    );
    expect(state.calls.resolve).toHaveLength(resolveCallsBeforeActivation);
    expect(state.calls.readLegacy.slice(-2)).toEqual([
      "pi_stable",
      "pi_evolving",
    ]);
  });

  test("rollback pauses the database by CAS before directing the Worker switch change", async () => {
    const state = harness({ controlMode: "durable" });
    state.dependencies.stripe.paymentIntents.list = async () => {
      throw new Error("rollback must not call Stripe");
    };

    await expect(
      pauseAutoTopUpForRollback(false, state.dependencies),
    ).rejects.toThrow("database is paused before the Worker switch");
    expect(state.calls.getControl).toBe(0);
    expect(state.calls.transition).toEqual([]);

    const result = await pauseAutoTopUpForRollback(true, state.dependencies);
    expect(result.outcome).toBe("paused");
    expect(state.calls.transition).toEqual([
      {
        expectedMode: "durable",
        targetMode: "paused",
        now: NOW,
      },
    ]);
    expect(pausedRollbackOutput(result)).toEqual({
      mode: "pause-for-rollback",
      outcome: "paused",
      controlMode: "paused",
      pausedAt: NOW.toISOString(),
      nextStep:
        "The primary database is paused; now remove or set AUTO_TOP_UP_DURABLE_ENABLED to false.",
    });
  });

  test("rollback reports an already-paused database without another transition", async () => {
    const state = harness();

    const result = await pauseAutoTopUpForRollback(true, state.dependencies);

    expect(result.outcome).toBe("already_paused");
    expect(result.control.mode).toBe("paused");
    expect(state.calls.transition).toEqual([]);
  });

  test("requires every human attestation before any apply read or write", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);
    const listReadsBeforeApply = state.calls.list.length;

    await expect(
      applyAutoTopUpCutoverPlan(
        plan,
        { ...CONFIRMATIONS, passiveWorker100Percent: false },
        state.dependencies,
      ),
    ).rejects.toThrow("passive-Worker-100-percent");
    expect(state.calls.list).toHaveLength(listReadsBeforeApply);
    expect(state.calls.quarantine).toEqual([]);
    expect(state.calls.resolve).toEqual([]);
    expect(state.calls.transition).toEqual([]);
  });

  test("rejects inventory drift before repository writes", async () => {
    const state = harness();
    const plan = await planFor(state.dependencies);
    const originalList = state.dependencies.stripe.paymentIntents.list;
    state.dependencies.stripe.paymentIntents.list = async (input) => {
      const page = await originalList(input);
      return {
        ...page,
        data: [...page.data, legacyPayment({ id: "pi_drift" })],
      };
    };

    await expect(
      applyAutoTopUpCutoverPlan(plan, CONFIRMATIONS, state.dependencies),
    ).rejects.toThrow("state drifted after review");
    expect(state.calls.quarantine).toEqual([]);
    expect(state.calls.resolve).toEqual([]);
    expect(state.calls.transition).toEqual([]);
  });

  test("CLI is dry-run by default and requires a full SHA plus explicit phases", () => {
    const dryRun = parseOperatorArgs([
      "--inventory-start",
      INVENTORY_START.toISOString(),
      "--provider-fence-at",
      PROVIDER_FENCE.toISOString(),
      "--provider-fence-evidence",
      "INC-20717-provider-fence",
      "--worker-version",
      WORKER_SHA,
    ]);
    expect(dryRun.mode).toBe("dry-run");
    expect(() =>
      parseOperatorArgs([
        "--inventory-start",
        "2026-08-17T09:00:00.000Z",
        "--provider-fence-at",
        PROVIDER_FENCE.toISOString(),
        "--provider-fence-evidence",
        "INC-20717-provider-fence",
        "--worker-version",
        WORKER_SHA,
      ]),
    ).toThrow("must be the Unix epoch");
    expect(() =>
      parseOperatorArgs([
        "--inventory-start",
        INVENTORY_START.toISOString(),
        "--provider-fence-at",
        PROVIDER_FENCE.toISOString(),
        "--provider-fence-evidence",
        "INC-20717-provider-fence",
        "--worker-version",
        "abc123",
      ]),
    ).toThrow("full lowercase 40-hex commit SHA");

    const confirmationFlags = [
      "--plan",
      "/tmp/reviewed.json",
      "--confirm-provider-fence",
      "--confirm-passive-worker-100-percent",
      "--confirm-worker-switch-off",
      "--confirm-queue-and-dlq-reconciled",
      "--confirm-migration-and-rearm-baselines",
    ];
    expect(parseOperatorArgs(["--apply", ...confirmationFlags]).mode).toBe(
      "apply",
    );
    expect(parseOperatorArgs(["--activate", ...confirmationFlags]).mode).toBe(
      "activate",
    );
    expect(
      parseOperatorArgs([
        "--pause-for-rollback",
        "--confirm-database-pause-first",
      ]).mode,
    ).toBe("pause-for-rollback");
    expect(() =>
      parseOperatorArgs(["--apply", "--activate", ...confirmationFlags]),
    ).toThrow("exactly one");
    expect(() =>
      parseOperatorArgs([
        "--apply",
        "--plan",
        "/tmp/reviewed.json",
        "--confirm-provider-fence",
        "--confirm-worker-switch-off",
        "--confirm-queue-and-dlq-reconciled",
      ]),
    ).toThrow("passive-Worker-100-percent");
    expect(() =>
      parseOperatorArgs([
        "--apply",
        ...confirmationFlags.filter(
          (flag) => flag !== "--confirm-migration-and-rearm-baselines",
        ),
      ]),
    ).toThrow("migration-and-rearm-baselines");
  });
});
