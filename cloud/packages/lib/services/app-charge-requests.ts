import { randomUUID } from "crypto";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import { type App, appsRepository } from "@/db/repositories/apps";
import { type CryptoPayment, cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { cryptoPayments } from "@/db/schemas/crypto-payments";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
} from "@/lib/security/redirect-validation";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import { sanitizeAppChargeMetadata } from "./app-charge-callbacks";
import { cryptoPaymentsService } from "./crypto-payments";
import type { OxaPayNetwork } from "./oxapay";

const DEFAULT_CHARGE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MAX_CHARGE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export type AppChargeProvider = "stripe" | "oxapay";

interface ChargeRequestMetadata {
  kind?: string;
  app_id?: string;
  amount_usd?: number;
  description?: string;
  providers?: AppChargeProvider[];
  payment_url?: string;
  success_url?: string;
  cancel_url?: string;
  creator_user_id?: string;
  creator_organization_id?: string;
  created_by?: string;
  paid_at?: string;
  paid_provider?: AppChargeProvider;
  paid_provider_payment_id?: string;
  payer_user_id?: string;
  payer_organization_id?: string;
  callback_url?: string;
  callback_secret?: string;
  callback_channel?: Record<string, unknown>;
  callback_metadata?: Record<string, unknown>;
}

export interface CreateAppChargeRequestParams {
  appId: string;
  creatorUserId: string;
  creatorOrganizationId: string;
  amountUsd: number;
  description?: string;
  providers?: AppChargeProvider[];
  successUrl?: string;
  cancelUrl?: string;
  callbackUrl?: string;
  callbackSecret?: string;
  callbackChannel?: Record<string, unknown>;
  callbackMetadata?: Record<string, unknown>;
  lifetimeSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface AppChargeRequest {
  id: string;
  appId: string;
  amountUsd: number;
  description: string | null;
  providers: AppChargeProvider[];
  paymentUrl: string;
  status: string;
  paidAt: Date | null;
  paidProvider?: AppChargeProvider;
  providerPaymentId?: string;
  payerUserId?: string;
  payerOrganizationId?: string;
  expiresAt: Date;
  createdAt: Date;
  successUrl?: string;
  cancelUrl?: string;
  metadata: Record<string, unknown>;
}

function chargeMetadata(payment: CryptoPayment): ChargeRequestMetadata & Record<string, unknown> {
  return (payment.metadata ?? {}) as ChargeRequestMetadata & Record<string, unknown>;
}

function appChargePaymentPath(appId: string, chargeRequestId: string): string {
  return `/payment/app-charge/${encodeURIComponent(appId)}/${encodeURIComponent(chargeRequestId)}`;
}

function chargePaymentUrl(appId: string, chargeRequestId: string): string {
  return defaultRedirectUrl(appChargePaymentPath(appId, chargeRequestId));
}

function toChargeRequest(payment: CryptoPayment): AppChargeRequest | null {
  const metadata = chargeMetadata(payment);
  if (metadata.kind !== "app_charge_request" || typeof metadata.app_id !== "string") {
    return null;
  }

  const providers = Array.isArray(metadata.providers)
    ? metadata.providers.filter(
        (provider): provider is AppChargeProvider => provider === "stripe" || provider === "oxapay",
      )
    : (["stripe", "oxapay"] satisfies AppChargeProvider[]);

  return {
    id: payment.id,
    appId: metadata.app_id,
    amountUsd: Number(payment.expected_amount),
    description: typeof metadata.description === "string" ? metadata.description : null,
    providers,
    paymentUrl:
      typeof metadata.payment_url === "string"
        ? metadata.payment_url
        : chargePaymentUrl(metadata.app_id, payment.id),
    status: payment.status,
    paidAt: payment.confirmed_at ?? (metadata.paid_at ? new Date(metadata.paid_at) : null),
    paidProvider:
      metadata.paid_provider === "stripe" || metadata.paid_provider === "oxapay"
        ? metadata.paid_provider
        : undefined,
    providerPaymentId:
      typeof metadata.paid_provider_payment_id === "string"
        ? metadata.paid_provider_payment_id
        : undefined,
    payerUserId: typeof metadata.payer_user_id === "string" ? metadata.payer_user_id : undefined,
    payerOrganizationId:
      typeof metadata.payer_organization_id === "string"
        ? metadata.payer_organization_id
        : undefined,
    expiresAt: payment.expires_at,
    createdAt: payment.created_at,
    successUrl: typeof metadata.success_url === "string" ? metadata.success_url : undefined,
    cancelUrl: typeof metadata.cancel_url === "string" ? metadata.cancel_url : undefined,
    metadata: sanitizeAppChargeMetadata(metadata),
  };
}

function normalizeAmount(amountUsd: number): Decimal {
  const amount = new Decimal(amountUsd);
  if (!amount.isFinite() || amount.lt(1) || amount.gt(10000)) {
    throw new Error("Charge amount must be between $1 and $10,000");
  }
  return amount.toDecimalPlaces(2);
}

function normalizeLifetime(seconds?: number): number {
  if (!seconds) return DEFAULT_CHARGE_LIFETIME_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), 60), MAX_CHARGE_LIFETIME_SECONDS);
}

function assertChargePayable(request: AppChargeRequest): void {
  if (request.status !== "requested") {
    throw new Error("Charge request is not payable");
  }

  if (request.expiresAt.getTime() <= Date.now()) {
    throw new Error("Charge request has expired");
  }
}

function defaultRedirectUrl(path: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return new URL(path, baseUrl).toString();
}

function allowedRedirectOrigins(app: App): string[] {
  return [
    ...getDefaultPlatformRedirectOrigins(),
    app.app_url,
    ...(app.allowed_origins ?? []),
  ].filter((origin): origin is string => Boolean(origin));
}

function validateRedirects(params: {
  app: App;
  successUrl?: string;
  cancelUrl?: string;
  defaultCancelUrl?: string;
}): {
  successUrl: string;
  cancelUrl: string;
} {
  const origins = allowedRedirectOrigins(params.app);
  const rawSuccessUrl = params.successUrl || defaultRedirectUrl("/payment/success");
  const rawCancelUrl =
    params.cancelUrl || params.defaultCancelUrl || defaultRedirectUrl("/payment/cancel");

  return {
    successUrl: assertAllowedAbsoluteRedirectUrl(rawSuccessUrl, origins, "success_url").toString(),
    cancelUrl: assertAllowedAbsoluteRedirectUrl(rawCancelUrl, origins, "cancel_url").toString(),
  };
}

function validateCallbackUrl(app: App, callbackUrl?: string): string | undefined {
  if (!callbackUrl) return undefined;
  return assertAllowedAbsoluteRedirectUrl(
    callbackUrl,
    allowedRedirectOrigins(app),
    "callback_url",
  ).toString();
}

export class AppChargeRequestsService {
  async create(params: CreateAppChargeRequestParams): Promise<AppChargeRequest> {
    const app = await appsRepository.findById(params.appId);
    if (!app) {
      throw new Error("App not found");
    }

    if (app.organization_id !== params.creatorOrganizationId) {
      throw new Error("Access denied");
    }

    const amount = normalizeAmount(params.amountUsd);
    const chargeRequestId = randomUUID();
    const paymentUrl = chargePaymentUrl(params.appId, chargeRequestId);
    const redirects = validateRedirects({
      app,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      defaultCancelUrl: paymentUrl,
    });
    const callbackUrl = validateCallbackUrl(app, params.callbackUrl);
    const providers = params.providers?.length ? params.providers : ["stripe", "oxapay"];
    const expiresAt = new Date(Date.now() + normalizeLifetime(params.lifetimeSeconds) * 1000);

    const payment = await cryptoPaymentsRepository.create({
      id: chargeRequestId,
      organization_id: params.creatorOrganizationId,
      user_id: params.creatorUserId,
      payment_address: `app_charge:${chargeRequestId}`,
      expected_amount: amount.toFixed(2),
      credits_to_add: amount.toFixed(2),
      network: "APP_CHARGE",
      token: "USD",
      token_address: null,
      status: "requested",
      expires_at: expiresAt,
      metadata: {
        ...(params.metadata ?? {}),
        kind: "app_charge_request",
        app_id: params.appId,
        amount_usd: amount.toNumber(),
        description: params.description,
        providers,
        payment_url: paymentUrl,
        success_url: redirects.successUrl,
        cancel_url: redirects.cancelUrl,
        callback_url: callbackUrl,
        callback_secret: params.callbackSecret,
        callback_channel: params.callbackChannel,
        callback_metadata: params.callbackMetadata,
        creator_user_id: params.creatorUserId,
        creator_organization_id: params.creatorOrganizationId,
        created_by: "app_charge_requests",
      },
    });

    const request = toChargeRequest(payment);
    if (!request) {
      throw new Error("Failed to create charge request");
    }

    logger.info("[AppCharges] Created charge request", {
      chargeRequestId: request.id,
      appId: params.appId,
      creatorUserId: params.creatorUserId,
      amountUsd: request.amountUsd,
      providers,
    });

    return request;
  }

  async listForApp(appId: string, organizationId: string, limit = 50): Promise<AppChargeRequest[]> {
    const rows = await dbRead
      .select()
      .from(cryptoPayments)
      .where(
        and(
          eq(cryptoPayments.organization_id, organizationId),
          sql`${cryptoPayments.metadata}->>'kind' = 'app_charge_request'`,
          sql`${cryptoPayments.metadata}->>'app_id' = ${appId}`,
        ),
      )
      .orderBy(desc(cryptoPayments.created_at))
      .limit(Math.min(limit, 100));

    return rows
      .map((row) => toChargeRequest(row))
      .filter((request): request is AppChargeRequest => Boolean(request));
  }

  async getForApp(appId: string, chargeRequestId: string): Promise<AppChargeRequest | null> {
    const payment = await dbWrite.query.cryptoPayments.findFirst({
      where: eq(cryptoPayments.id, chargeRequestId),
    });
    if (!payment) return null;

    const request = toChargeRequest(payment);
    if (!request || request.appId !== appId) return null;
    return request;
  }

  async createStripeCheckout(params: {
    appId: string;
    chargeRequestId: string;
    payerUserId: string;
    payerOrganizationId: string;
    payerEmail?: string | null;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{ provider: "stripe"; url: string | null; sessionId: string }> {
    const [app, request] = await Promise.all([
      appsRepository.findById(params.appId),
      this.getForApp(params.appId, params.chargeRequestId),
    ]);

    if (!app || !request) {
      throw new Error("Charge request not found");
    }

    assertChargePayable(request);

    if (!request.providers.includes("stripe")) {
      throw new Error("Stripe is not enabled for this charge request");
    }

    const redirects = validateRedirects({
      app,
      successUrl: params.successUrl ?? request.successUrl,
      cancelUrl: params.cancelUrl ?? request.cancelUrl,
      defaultCancelUrl: request.paymentUrl,
    });
    const successUrl = new URL(redirects.successUrl);
    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    successUrl.searchParams.set("charge_request_id", request.id);

    const checkoutMetadata = {
      type: "app_credit_purchase",
      source: "miniapp_app",
      app_id: params.appId,
      charge_request_id: params.chargeRequestId,
      user_id: params.payerUserId,
      organization_id: params.payerOrganizationId,
      credits: request.amountUsd.toFixed(2),
      amount: request.amountUsd.toFixed(2),
    };

    const session = await requireStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${app.name} Credits`,
              description: request.description ?? `$${request.amountUsd} credits for ${app.name}`,
            },
            unit_amount: Math.round(request.amountUsd * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl.toString(),
      cancel_url: redirects.cancelUrl,
      customer_email: params.payerEmail || undefined,
      metadata: checkoutMetadata,
      payment_intent_data: {
        metadata: checkoutMetadata,
      },
    });

    logger.info("[AppCharges] Created Stripe checkout", {
      chargeRequestId: params.chargeRequestId,
      appId: params.appId,
      payerUserId: params.payerUserId,
      sessionId: session.id,
      amountUsd: request.amountUsd,
    });

    return { provider: "stripe", url: session.url, sessionId: session.id };
  }

  async createOxaPayCheckout(params: {
    appId: string;
    chargeRequestId: string;
    payerUserId: string;
    payerOrganizationId: string;
    payCurrency?: string;
    network?: OxaPayNetwork;
    returnUrl?: string;
  }): Promise<{
    provider: "oxapay";
    paymentId: string;
    trackId: string;
    payLink: string;
    expiresAt: Date;
  }> {
    const [app, request] = await Promise.all([
      appsRepository.findById(params.appId),
      this.getForApp(params.appId, params.chargeRequestId),
    ]);

    if (!app || !request) {
      throw new Error("Charge request not found");
    }

    assertChargePayable(request);

    if (!request.providers.includes("oxapay")) {
      throw new Error("OxaPay is not enabled for this charge request");
    }

    const redirects = validateRedirects({
      app,
      successUrl: params.returnUrl ?? request.successUrl,
      cancelUrl: request.cancelUrl,
      defaultCancelUrl: request.paymentUrl,
    });
    const returnUrl = new URL(redirects.successUrl);
    returnUrl.searchParams.set("charge_request_id", request.id);

    const payment = await cryptoPaymentsService.createPayment({
      organizationId: params.payerOrganizationId,
      userId: params.payerUserId,
      amount: request.amountUsd,
      currency: "USD",
      payCurrency: params.payCurrency,
      network: params.network,
      description: request.description ?? `App credit purchase - ${app.name}`,
      returnUrl: returnUrl.toString(),
      metadata: {
        kind: "app_credit_purchase",
        type: "app_credit_purchase",
        source: "miniapp_app",
        app_id: params.appId,
        charge_request_id: params.chargeRequestId,
        payer_user_id: params.payerUserId,
        payer_organization_id: params.payerOrganizationId,
      },
    });

    logger.info("[AppCharges] Created OxaPay checkout", {
      chargeRequestId: params.chargeRequestId,
      appId: params.appId,
      payerUserId: params.payerUserId,
      paymentId: payment.payment.id,
      amountUsd: request.amountUsd,
    });

    return {
      provider: "oxapay",
      paymentId: payment.payment.id,
      trackId: payment.trackId,
      payLink: payment.payLink,
      expiresAt: payment.expiresAt,
    };
  }
}

export const appChargeRequestsService = new AppChargeRequestsService();
