/**
 * Owns durable Stripe Checkout quotes and atomically fulfills organization-credit purchases.
 * Stripe metadata is only a lookup hint; every money and tenant field is compared to this record.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { organizations } from "../../db/schemas/organizations";
import {
  type StripeCheckoutOrder,
  type StripeCheckoutPurchaseType,
  stripeCheckoutOrders,
} from "../../db/schemas/stripe-checkout-orders";
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
  stripeCustomerId: string;
  metadata?: Record<string, unknown>;
}

export interface StripeCheckoutReceipt {
  checkoutOrderId: string;
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

  if (receipt.checkoutOrderId !== order.id) mismatch("STRIPE_CHECKOUT_ORDER_MISMATCH", "order");
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
  if (receipt.customerId !== order.stripe_customer_id) {
    mismatch("STRIPE_CHECKOUT_CUSTOMER_MISMATCH", "customer");
  }
  if (order.stripe_checkout_session_id !== receipt.checkoutSessionId) {
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
        stripe_customer_id: input.stripeCustomerId,
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

      assertReceiptMatches(order, receipt, options);
      if (order.status === "settled") {
        const [organization] = await tx
          .select({ creditBalance: organizations.credit_balance })
          .from(organizations)
          .where(eq(organizations.id, order.organization_id))
          .limit(1);
        if (!organization) {
          throw new StripeCheckoutAuthorityError(
            "STRIPE_CHECKOUT_ORGANIZATION_NOT_FOUND",
            "Settled Checkout organization no longer exists",
            { checkoutOrderId: order.id },
          );
        }
        return {
          order,
          alreadyApplied: true,
          newBalance: Number(organization.creditBalance),
        };
      }
      if (!FULFILLABLE_STATUSES.includes(order.status as "delivered")) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_NOT_FULFILLABLE",
          "Stripe Checkout order is not in a fulfillable state",
          { checkoutOrderId: order.id, status: order.status },
        );
      }

      const credits = Number(order.credits_to_grant);
      if (!Number.isFinite(credits) || credits <= 0) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_CORRUPT_CREDITS",
          "Stored Checkout credits are invalid",
          { checkoutOrderId: order.id },
        );
      }
      const grant = await creditsService.addCredits({
        organizationId: order.organization_id,
        amount: credits,
        description: `Stripe ${order.purchase_type === "credit_pack" ? "credit pack" : "balance top-up"}`,
        metadata: {
          type: order.purchase_type,
          checkout_order_id: order.id,
          session_id: receipt.checkoutSessionId,
          payment_intent_id: receipt.paymentIntentId,
          initiated_by_user_id: order.initiated_by_user_id,
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
          and(eq(stripeCheckoutOrders.id, order.id), eq(stripeCheckoutOrders.status, "delivered")),
        )
        .returning();
      if (!settled) {
        throw new StripeCheckoutAuthorityError(
          "STRIPE_CHECKOUT_SETTLEMENT_CONFLICT",
          "Stripe Checkout order changed during settlement",
          { checkoutOrderId: order.id },
        );
      }
      return { order: settled, alreadyApplied: false, newBalance: grant.newBalance };
    });

    await creditsService.invalidateCreditCaches(result.order.organization_id);
    return result;
  }

  /**
   * Settles a pre-authority Checkout Session created by the retired routes.
   * This compatibility path derives custom credits from Stripe's paid cents and
   * pack credits from the current server catalog; metadata must agree but never
   * supplies either value.
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

    const [organization] = await dbWrite
      .select({ stripeCustomerId: organizations.stripe_customer_id })
      .from(organizations)
      .where(eq(organizations.id, verifiedOrganizationId))
      .limit(1);
    if (!organization) mismatch("STRIPE_CHECKOUT_ORGANIZATION_NOT_FOUND", "organization");
    if (!organization.stripeCustomerId || organization.stripeCustomerId !== receipt.customerId) {
      mismatch("STRIPE_LEGACY_CHECKOUT_CUSTOMER_MISMATCH", "customer");
    }

    const authority: { purchaseType: StripeCheckoutPurchaseType; credits: Decimal } =
      receipt.purchaseType === "custom_amount"
        ? { purchaseType: "custom_amount", credits: new Decimal(verifiedAmountTotal).div(100) }
        : await (async () => {
            if (receipt.purchaseType !== "credit_pack" || !receipt.creditPackId) {
              return mismatch("STRIPE_LEGACY_CHECKOUT_TYPE_MISMATCH", "purchase type");
            }
            const pack = await creditsService.getCreditPackById(receipt.creditPackId);
            if (!pack?.is_active) {
              return mismatch("STRIPE_LEGACY_CHECKOUT_PACK_MISMATCH", "credit pack");
            }
            if (pack.price_cents !== verifiedAmountTotal) {
              mismatch("STRIPE_LEGACY_CHECKOUT_PACK_PRICE_MISMATCH", "pack price");
            }
            return { purchaseType: "credit_pack" as const, credits: new Decimal(pack.credits) };
          })();
    const { purchaseType, credits } = authority;
    if (
      !credits.isFinite() ||
      !credits.gt(0) ||
      credits.gt(10_000) ||
      credits.decimalPlaces() > 6
    ) {
      mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "credits");
    }
    let claimedCredits: Decimal;
    try {
      claimedCredits = new Decimal(receipt.claimedCredits ?? "invalid");
    } catch {
      return mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "claimed credits");
    }
    if (!claimedCredits.eq(credits)) {
      mismatch("STRIPE_LEGACY_CHECKOUT_CREDITS_MISMATCH", "claimed credits");
    }

    const existing = await creditsService.getTransactionByStripePaymentIntent(
      receipt.paymentIntentId,
    );
    if (existing && existing.organization_id !== verifiedOrganizationId) {
      mismatch("STRIPE_CHECKOUT_ORGANIZATION_MISMATCH", "ledger organization");
    }
    const grant = await creditsService.addCredits({
      organizationId: verifiedOrganizationId,
      amount: credits.toNumber(),
      description: `Stripe legacy ${purchaseType === "credit_pack" ? "credit pack" : "balance top-up"}`,
      metadata: {
        type: purchaseType,
        session_id: receipt.checkoutSessionId,
        payment_intent_id: receipt.paymentIntentId,
        initiated_by_user_id: verifiedInitiatedByUserId,
        source: "legacy_checkout_cutover",
      },
      stripePaymentIntentId: receipt.paymentIntentId,
    });
    return {
      organizationId: verifiedOrganizationId,
      initiatedByUserId: verifiedInitiatedByUserId,
      purchaseType,
      creditsToGrant: credits.toFixed(6),
      alreadyApplied: !!existing,
      newBalance: grant.newBalance,
    };
  }
}

export const stripeCheckoutOrdersService = new StripeCheckoutOrdersService();
