/**
 * Owns durable Stripe Checkout quotes and atomically fulfills organization-credit purchases.
 * Stripe metadata is only a lookup hint; every money and tenant field is compared to this record.
 */
import { ElizaError } from "@elizaos/core/edge";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import {
  type StripeCheckoutOrder,
  type StripeCheckoutPurchaseType,
  stripeCheckoutLegacyQuarantine,
  stripeCheckoutOrders,
} from "../../db/schemas/stripe-checkout-orders";
import { users } from "../../db/schemas/users";
import { creditsService } from "./credits";

const FULFILLABLE_STATUSES = ["delivered"] as const;

export class StripeCheckoutAuthorityError extends ElizaError {
  override readonly name = "StripeCheckoutAuthorityError";

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message, { code, context, severity: "fatal" });
  }
}

export interface CreateStripeCheckoutOrderInput {
  organizationId: string;
  initiatedByUserId: string;
  clientRequestKey: string;
  requestDigest: string;
  purchaseType: StripeCheckoutPurchaseType;
  creditPackId?: string | null;
  creditsToGrant: string;
  chargeAmountCents: number;
  currency: string;
  stripeCustomerId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StripeCheckoutReceipt {
  checkoutOrderId: string;
  clientReferenceId: string | null;
  metadataOrderId: string | null;
  checkoutSessionId: string;
  paymentIntentId: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  customerId: string | null;
}

export interface SettleStripeCheckoutOptions {
  callerOrganizationId?: string;
  callerUserId?: string;
}

export interface StripeCheckoutSettlement {
  order: StripeCheckoutOrder;
  alreadyApplied: boolean;
  newBalance: number;
}

export interface LegacyStripeCheckoutReceipt {
  checkoutSessionId: string;
  paymentIntentId: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  customerId: string | null;
  organizationId: string | null;
  initiatedByUserId: string | null;
  purchaseType: string | null;
  creditPackId: string | null;
  claimedCredits: string | null;
}

export interface LegacyStripeCheckoutSettlement {
  organizationId: string;
  initiatedByUserId: string;
  purchaseType: StripeCheckoutPurchaseType;
  creditsToGrant: string;
  alreadyApplied: boolean;
  newBalance: number;
}

function validateCreate(input: CreateStripeCheckoutOrderInput): void {
  const credits = new Decimal(input.creditsToGrant);
  if (!credits.isFinite() || !credits.gt(0) || credits.gt(10_000) || credits.decimalPlaces() > 6) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_CREDITS",
      "Checkout credits must be a positive decimal with at most six places",
    );
  }
  if (!Number.isSafeInteger(input.chargeAmountCents) || input.chargeAmountCents <= 0) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_CHARGE",
      "Checkout charge must be positive integer cents",
    );
  }
  if (!/^[a-z]{3}$/.test(input.currency)) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_CURRENCY",
      "Checkout currency must be a lowercase ISO currency code",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.clientRequestKey)) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_REQUEST_KEY",
      "Checkout idempotency key is invalid",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestDigest)) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_REQUEST_DIGEST",
      "Checkout request digest is invalid",
    );
  }
  const packShapeMatches =
    (input.purchaseType === "credit_pack" && !!input.creditPackId) ||
    (input.purchaseType === "custom_amount" && !input.creditPackId);
  if (!packShapeMatches) {
    throw new StripeCheckoutAuthorityError(
      "STRIPE_CHECKOUT_INVALID_PACK_SHAPE",
      "Checkout credit-pack linkage does not match its purchase type",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertReceiptMatches(
  order: StripeCheckoutOrder,
  receipt: StripeCheckoutReceipt,
  options: SettleStripeCheckoutOptions,
): void {
  const mismatch = (code: string, field: string): never => {
    throw new StripeCheckoutAuthorityError(code, `Stripe Checkout ${field} does not match quote`, {
      checkoutOrderId: order.id,
      checkoutSessionId: receipt.checkoutSessionId,
      field,
    });
  };

  if (
    receipt.checkoutOrderId !== order.id ||
    receipt.clientReferenceId !== order.id ||
    receipt.metadataOrderId !== order.id
  ) {
    mismatch("STRIPE_CHECKOUT_ORDER_MISMATCH", "order receipt");
  }
  if (options.callerOrganizationId && options.callerOrganizationId !== order.organization_id) {
    mismatch("STRIPE_CHECKOUT_ORGANIZATION_MISMATCH", "organization");
  }
  if (options.callerUserId && options.callerUserId !== order.initiated_by_user_id) {
    mismatch("STRIPE_CHECKOUT_USER_MISMATCH", "user");
  }
  if (receipt.paymentStatus !== "paid") mismatch("STRIPE_CHECKOUT_NOT_PAID", "payment status");
  const chargeAmountCents = Number(order.charge_amount_cents);
  if (!Number.isSafeInteger(chargeAmountCents) || receipt.amountTotal !== chargeAmountCents) {
    mismatch("STRIPE_CHECKOUT_AMOUNT_MISMATCH", "amount");
  }
  if (receipt.currency?.toLowerCase() !== order.currency) {
    mismatch("STRIPE_CHECKOUT_CURRENCY_MISMATCH", "currency");
  }
  if (!order.stripe_customer_id || receipt.customerId !== order.stripe_customer_id) {
    mismatch("STRIPE_CHECKOUT_CUSTOMER_MISMATCH", "customer");
  }
  if (
    order.stripe_checkout_session_id &&
    order.stripe_checkout_session_id !== receipt.checkoutSessionId
  ) {
    mismatch("STRIPE_CHECKOUT_SESSION_MISMATCH", "session");
  }
  if (
    order.stripe_payment_intent_id &&
    order.stripe_payment_intent_id !== receipt.paymentIntentId
  ) {
    mismatch("STRIPE_CHECKOUT_PAYMENT_INTENT_MISMATCH", "payment intent");
  }
}

export class StripeCheckoutOrdersService {
  async create(input: CreateStripeCheckoutOrderInput): Promise<StripeCheckoutOrder> {
    validateCreate(input);
    const [order] = await dbWrite
      .insert(stripeCheckoutOrders)
      .values({
        organization_id: input.organizationId,
        initiated_by_user_id: input.initiatedByUserId,
        client_request_key: input.clientRequestKey,
        request_digest: input.requestDigest,
        purchase_type: input.purchaseType,
        credit_pack_id: input.creditPackId ?? null,
        credits_to_grant: new Decimal(input.creditsToGrant).toFixed(6),
        charge_amount_cents: BigInt(input.chargeAmountCents),
        currency: input.currency,
        stripe_customer_id: input.stripeCustomerId ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoNothing({
        target: [stripeCheckoutOrders.organization_id, stripeCheckoutOrders.client_request_key],
      })
      .returning();
    if (order) return order;
    const [existing] = await dbWrite
      .select()
      .from(stripeCheckoutOrders)
      .where(
        and(
          eq(stripeCheckoutOrders.organization_id, input.organizationId),
          eq(stripeCheckoutOrders.client_request_key, input.clientRequestKey),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new StripeCheckoutAuthorityError(
        "STRIPE_CHECKOUT_IDEMPOTENCY_RACE",
        "Checkout idempotency winner could not be loaded",
      );
    }
    if (
      existing.request_digest !== input.requestDigest ||
      existing.initiated_by_user_id !== input.initiatedByUserId
    ) {
      throw new StripeCheckoutAuthorityError(
        "STRIPE_CHECKOUT_IDEMPOTENCY_CONFLICT",
        "Checkout idempotency key was reused with a different request",
        { checkoutOrderId: existing.id },
      );
    }
    return existing;
  }

  /** Pins the customer on the idempotency winner before any Session request. */
  async bindCustomer(orderId: string, candidateCustomerId: string): Promise<StripeCheckoutOrder> {
    return await writeTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(stripeCheckoutOrders)
        .where(eq(stripeCheckoutOrders.id, orderId))
        .for("update")
        .limit(1);
      if (!order) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_ORDER_NOT_FOUND",
          "Checkout order was not found while pinning its customer",
          { checkoutOrderId: orderId },
        );
      }
      if (order.stripe_customer_id) return order;
      if (order.status !== "quoted") {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_CUSTOMER_BIND_CONFLICT",
          "Checkout customer cannot change after provider creation starts",
          { checkoutOrderId: orderId, status: order.status },
        );
      }
      const [organization] = await tx
        .select({ stripeCustomerId: organizations.stripe_customer_id })
        .from(organizations)
        .where(eq(organizations.id, order.organization_id))
        .for("update")
        .limit(1);
      if (!organization) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_ORGANIZATION_NOT_FOUND",
          "Checkout organization was not found while pinning its customer",
          { checkoutOrderId: orderId },
        );
      }
      if (organization.stripeCustomerId !== candidateCustomerId) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_CUSTOMER_NOT_AUTHORITATIVE",
          "Checkout customer must already be published by Stripe Customer authority",
          { checkoutOrderId: order.id },
        );
      }
      const [bound] = await tx
        .update(stripeCheckoutOrders)
        .set({ stripe_customer_id: candidateCustomerId, updated_at: new Date() })
        .where(
          and(
            eq(stripeCheckoutOrders.id, order.id),
            eq(stripeCheckoutOrders.status, "quoted"),
            isNull(stripeCheckoutOrders.stripe_customer_id),
          ),
        )
        .returning();
      if (!bound) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_CUSTOMER_BIND_CONFLICT",
          "Checkout customer lost its compare-and-set",
          { checkoutOrderId: order.id },
        );
      }
      return bound;
    });
  }

  async markProviderStarted(orderId: string): Promise<void> {
    const [row] = await dbWrite
      .update(stripeCheckoutOrders)
      .set({ status: "provider_started", updated_at: new Date() })
      .where(
        and(
          eq(stripeCheckoutOrders.id, orderId),
          inArray(stripeCheckoutOrders.status, ["quoted", "provider_ambiguous"]),
        ),
      )
      .returning({ id: stripeCheckoutOrders.id });
    if (!row) {
      const existing = await this.get(orderId);
      if (existing?.status === "provider_started") return;
      throw new StripeCheckoutAuthorityError(
        "STRIPE_CHECKOUT_PROVIDER_START_CONFLICT",
        "Checkout order is not available for provider creation",
        { checkoutOrderId: orderId },
      );
    }
  }

  async bindSession(orderId: string, checkoutSessionId: string): Promise<void> {
    const [row] = await dbWrite
      .update(stripeCheckoutOrders)
      .set({
        status: "delivered",
        stripe_checkout_session_id: checkoutSessionId,
        provider_error_code: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(stripeCheckoutOrders.id, orderId),
          inArray(stripeCheckoutOrders.status, ["provider_started", "provider_ambiguous"]),
        ),
      )
      .returning({ id: stripeCheckoutOrders.id });
    if (!row) {
      const existing = await this.get(orderId);
      if (
        existing?.status === "delivered" &&
        existing.stripe_checkout_session_id === checkoutSessionId
      ) {
        return;
      }
      throw new StripeCheckoutAuthorityError(
        "STRIPE_CHECKOUT_SESSION_BIND_CONFLICT",
        "Checkout Session cannot be bound to this order",
        { checkoutOrderId: orderId, checkoutSessionId },
      );
    }
  }

  async markProviderAmbiguous(orderId: string, errorCode: string): Promise<void> {
    await dbWrite
      .update(stripeCheckoutOrders)
      .set({ status: "provider_ambiguous", provider_error_code: errorCode, updated_at: new Date() })
      .where(
        and(
          eq(stripeCheckoutOrders.id, orderId),
          eq(stripeCheckoutOrders.status, "provider_started"),
        ),
      );
  }

  async get(orderId: string): Promise<StripeCheckoutOrder | null> {
    const [row] = await dbWrite
      .select()
      .from(stripeCheckoutOrders)
      .where(eq(stripeCheckoutOrders.id, orderId))
      .limit(1);
    return row ?? null;
  }

  /** Finds the immutable fulfillment authority used for a refund or dispute PaymentIntent. */
  async getByPaymentIntent(paymentIntentId: string): Promise<StripeCheckoutOrder | null> {
    const [row] = await dbWrite
      .select()
      .from(stripeCheckoutOrders)
      .where(eq(stripeCheckoutOrders.stripe_payment_intent_id, paymentIntentId))
      .limit(1);
    return row ?? null;
  }

  async settle(
    receipt: StripeCheckoutReceipt,
    options: SettleStripeCheckoutOptions = {},
  ): Promise<StripeCheckoutSettlement> {
    const result = await writeTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(stripeCheckoutOrders)
        .where(eq(stripeCheckoutOrders.id, receipt.checkoutOrderId))
        .for("update")
        .limit(1);
      if (!order) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_ORDER_NOT_FOUND",
          "Stripe Checkout order was not found",
          { checkoutOrderId: receipt.checkoutOrderId },
        );
      }

      let authoritativeOrder = order;
      if (
        !order.stripe_checkout_session_id &&
        (order.status === "provider_started" || order.status === "provider_ambiguous")
      ) {
        // The signed webhook or an authenticated provider retrieval is a
        // trusted receipt after every immutable field below matches. Binding
        // under the row lock closes Session-create ACK loss without allowing
        // metadata alone to select or mutate the order.
        assertReceiptMatches(order, receipt, options);
        const [bound] = await tx
          .update(stripeCheckoutOrders)
          .set({
            status: "delivered",
            stripe_checkout_session_id: receipt.checkoutSessionId,
            provider_error_code: null,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(stripeCheckoutOrders.id, order.id),
              inArray(stripeCheckoutOrders.status, ["provider_started", "provider_ambiguous"]),
              isNull(stripeCheckoutOrders.stripe_checkout_session_id),
            ),
          )
          .returning();
        if (!bound) {
          throw new StripeCheckoutAuthorityError(
            "STRIPE_CHECKOUT_SESSION_BIND_CONFLICT",
            "Trusted Checkout receipt lost its session bind race",
            { checkoutOrderId: order.id, checkoutSessionId: receipt.checkoutSessionId },
          );
        }
        authoritativeOrder = bound;
      }

      assertReceiptMatches(authoritativeOrder, receipt, options);
      if (authoritativeOrder.status === "settled") {
        const [organization] = await tx
          .select({ creditBalance: organizations.credit_balance })
          .from(organizations)
          .where(eq(organizations.id, authoritativeOrder.organization_id))
          .limit(1);
        if (!organization) {
          throw new StripeCheckoutAuthorityError(
            "STRIPE_CHECKOUT_ORGANIZATION_NOT_FOUND",
            "Settled Checkout organization no longer exists",
            { checkoutOrderId: authoritativeOrder.id },
          );
        }
        return {
          order: authoritativeOrder,
          alreadyApplied: true,
          newBalance: Number(organization.creditBalance),
        };
      }
      if (!FULFILLABLE_STATUSES.includes(authoritativeOrder.status as "delivered")) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_NOT_FULFILLABLE",
          "Stripe Checkout order is not in a fulfillable state",
          { checkoutOrderId: authoritativeOrder.id, status: authoritativeOrder.status },
        );
      }

      const credits = Number(authoritativeOrder.credits_to_grant);
      if (!Number.isFinite(credits) || credits <= 0) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_CORRUPT_CREDITS",
          "Stored Checkout credits are invalid",
          { checkoutOrderId: authoritativeOrder.id },
        );
      }
      const grant = await creditsService.addCredits({
        organizationId: authoritativeOrder.organization_id,
        amount: credits,
        description: `Stripe ${authoritativeOrder.purchase_type === "credit_pack" ? "credit pack" : "balance top-up"}`,
        metadata: {
          type: authoritativeOrder.purchase_type,
          checkout_order_id: authoritativeOrder.id,
          session_id: receipt.checkoutSessionId,
          payment_intent_id: receipt.paymentIntentId,
          initiated_by_user_id: authoritativeOrder.initiated_by_user_id,
        },
        stripePaymentIntentId: receipt.paymentIntentId,
        db: tx,
        deferCacheInvalidation: true,
      });
      const [settled] = await tx
        .update(stripeCheckoutOrders)
        .set({
          status: "settled",
          stripe_payment_intent_id: receipt.paymentIntentId,
          credit_transaction_id: grant.transaction.id,
          settled_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(stripeCheckoutOrders.id, authoritativeOrder.id),
            eq(stripeCheckoutOrders.status, "delivered"),
          ),
        )
        .returning();
      if (!settled) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_SETTLEMENT_CONFLICT",
          "Stripe Checkout order changed during settlement",
          { checkoutOrderId: authoritativeOrder.id },
        );
      }
      return { order: settled, alreadyApplied: false, newBalance: grant.newBalance };
    });

    await creditsService.invalidateCreditCaches(result.order.organization_id);
    return result;
  }

  /**
   * Settles a pre-authority Checkout Session created by the retired routes.
   * This compatibility path derives custom credits from Stripe's paid cents.
   * Pre-authority packs have no immutable historical grant quote, so they are
   * durably quarantined for operator reconciliation instead of consulting a
   * mutable current catalog or trusting metadata.
   */
  async settleLegacy(
    receipt: LegacyStripeCheckoutReceipt,
    options: SettleStripeCheckoutOptions = {},
  ): Promise<LegacyStripeCheckoutSettlement> {
    const mismatch = (code: string, field: string): never => {
      throw new StripeCheckoutAuthorityError(
        code,
        `Legacy Stripe Checkout ${field} could not be verified`,
        { checkoutSessionId: receipt.checkoutSessionId, field },
      );
    };
    if (receipt.paymentStatus !== "paid") mismatch("STRIPE_LEGACY_CHECKOUT_NOT_PAID", "status");
    if (receipt.currency?.toLowerCase() !== "usd") {
      mismatch("STRIPE_LEGACY_CHECKOUT_CURRENCY_MISMATCH", "currency");
    }
    const organizationId = receipt.organizationId;
    const initiatedByUserId = receipt.initiatedByUserId;
    if (!organizationId || !initiatedByUserId) {
      mismatch("STRIPE_LEGACY_CHECKOUT_TENANT_MISSING", "tenant");
    }
    const verifiedOrganizationId = organizationId as string;
    const verifiedInitiatedByUserId = initiatedByUserId as string;
    if (options.callerOrganizationId && options.callerOrganizationId !== organizationId) {
      mismatch("STRIPE_CHECKOUT_ORGANIZATION_MISMATCH", "organization");
    }
    if (options.callerUserId && options.callerUserId !== initiatedByUserId) {
      mismatch("STRIPE_CHECKOUT_USER_MISMATCH", "user");
    }
    const amountTotal = receipt.amountTotal;
    if (!Number.isSafeInteger(amountTotal) || !amountTotal || amountTotal <= 0) {
      mismatch("STRIPE_LEGACY_CHECKOUT_AMOUNT_MISMATCH", "amount");
    }
    const verifiedAmountTotal = amountTotal as number;

    const isLegacyPack = receipt.purchaseType === "credit_pack";
    if (!isLegacyPack && receipt.purchaseType !== "custom_amount") {
      mismatch("STRIPE_LEGACY_CHECKOUT_TYPE_MISMATCH", "purchase type");
    }
    const credits = isLegacyPack ? null : new Decimal(verifiedAmountTotal).div(100);
    if (
      credits &&
      (!credits.isFinite() || !credits.gt(0) || credits.gt(10_000) || credits.decimalPlaces() > 6)
    ) {
      mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "credits");
    }
    if (credits) {
      let claimedCredits: Decimal;
      try {
        claimedCredits = new Decimal(receipt.claimedCredits ?? "invalid");
      } catch {
        // error-policy:J3 Provider receipt parsing rejects malformed claimed credits explicitly.
        return mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "claimed credits");
      }
      if (!claimedCredits.eq(credits)) {
        mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "claimed credits");
      }
    }

    const result = await writeTransaction<
      | { kind: "quarantined" }
      | { kind: "settled"; alreadyApplied: boolean; grant: { newBalance: number } }
    >(async (tx) => {
      const [organization] = await tx
        .select({ stripeCustomerId: organizations.stripe_customer_id })
        .from(organizations)
        .where(eq(organizations.id, verifiedOrganizationId))
        .limit(1)
        .for("update");
      if (!organization) mismatch("STRIPE_CHECKOUT_ORGANIZATION_NOT_FOUND", "organization");
      if (!organization.stripeCustomerId || organization.stripeCustomerId !== receipt.customerId) {
        mismatch("STRIPE_LEGACY_CHECKOUT_CUSTOMER_MISMATCH", "customer");
      }
      const [member] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, verifiedInitiatedByUserId),
            eq(users.organization_id, verifiedOrganizationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!member) mismatch("STRIPE_LEGACY_CHECKOUT_USER_TENANT_MISMATCH", "user tenant");

      if (isLegacyPack) {
        const reason = "missing_immutable_pre_authority_pack_quote";
        const normalizedCurrency = receipt.currency!.toLowerCase();
        const providerReceipt = {
          checkout_session_id: receipt.checkoutSessionId,
          payment_intent_id: receipt.paymentIntentId,
          payment_status: receipt.paymentStatus,
          amount_total: receipt.amountTotal,
          currency: normalizedCurrency,
          customer_id: receipt.customerId,
          credit_pack_id: receipt.creditPackId,
          claimed_credits: receipt.claimedCredits,
        };
        const [inserted] = await tx
          .insert(stripeCheckoutLegacyQuarantine)
          .values({
            checkout_session_id: receipt.checkoutSessionId,
            stripe_payment_intent_id: receipt.paymentIntentId,
            organization_id: verifiedOrganizationId,
            initiated_by_user_id: verifiedInitiatedByUserId,
            stripe_customer_id: receipt.customerId,
            credit_pack_id: receipt.creditPackId,
            claimed_credits: receipt.claimedCredits,
            charge_amount_cents: BigInt(verifiedAmountTotal),
            currency: normalizedCurrency,
            reason,
            provider_receipt: providerReceipt,
            updated_at: new Date(),
          })
          .onConflictDoNothing()
          .returning({ checkoutSessionId: stripeCheckoutLegacyQuarantine.checkout_session_id });
        if (!inserted) {
          const [existingQuarantine] = await tx
            .select()
            .from(stripeCheckoutLegacyQuarantine)
            .where(
              eq(stripeCheckoutLegacyQuarantine.checkout_session_id, receipt.checkoutSessionId),
            )
            .limit(1)
            .for("update");
          const exactReplay =
            existingQuarantine?.stripe_payment_intent_id === receipt.paymentIntentId &&
            existingQuarantine.organization_id === verifiedOrganizationId &&
            existingQuarantine.initiated_by_user_id === verifiedInitiatedByUserId &&
            existingQuarantine.stripe_customer_id === receipt.customerId &&
            existingQuarantine.credit_pack_id === receipt.creditPackId &&
            existingQuarantine.claimed_credits === receipt.claimedCredits &&
            existingQuarantine.charge_amount_cents === BigInt(verifiedAmountTotal) &&
            existingQuarantine.currency === normalizedCurrency &&
            existingQuarantine.reason === reason &&
            canonicalJson(existingQuarantine.provider_receipt) === canonicalJson(providerReceipt);
          if (!exactReplay) {
            mismatch("STRIPE_LEGACY_CHECKOUT_QUARANTINE_REPLAY_CONFLICT", "quarantine replay");
          }
        }
        return { kind: "quarantined" as const };
      }

      const [existing] = await tx
        .select({ organizationId: creditTransactions.organization_id })
        .from(creditTransactions)
        .where(eq(creditTransactions.stripe_payment_intent_id, receipt.paymentIntentId))
        .limit(1)
        .for("update");
      if (existing && existing.organizationId !== verifiedOrganizationId) {
        mismatch("STRIPE_CHECKOUT_ORGANIZATION_MISMATCH", "ledger organization");
      }
      const grant = await creditsService.addCredits({
        organizationId: verifiedOrganizationId,
        amount: credits!.toFixed(6),
        description: "Stripe legacy balance top-up",
        metadata: {
          type: "custom_amount",
          session_id: receipt.checkoutSessionId,
          payment_intent_id: receipt.paymentIntentId,
          initiated_by_user_id: verifiedInitiatedByUserId,
          source: "legacy_checkout_cutover",
        },
        stripePaymentIntentId: receipt.paymentIntentId,
        db: tx,
        deferCacheInvalidation: true,
      });
      return { kind: "settled" as const, alreadyApplied: !!existing, grant };
    });

    if (result.kind !== "settled") {
      return mismatch("STRIPE_LEGACY_CHECKOUT_PACK_QUARANTINED", "immutable pack authority");
    }
    await creditsService.invalidateCreditCaches(verifiedOrganizationId);
    return {
      organizationId: verifiedOrganizationId,
      initiatedByUserId: verifiedInitiatedByUserId,
      purchaseType: "custom_amount",
      creditsToGrant: credits!.toFixed(6),
      alreadyApplied: result.alreadyApplied,
      newBalance: result.grant.newBalance,
    };
  }
}

export const stripeCheckoutOrdersService = new StripeCheckoutOrdersService();
