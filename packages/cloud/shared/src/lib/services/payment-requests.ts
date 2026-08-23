/** Coordinates payment-request state, provider intents, and transport projections. */
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import { MAX_PAYMENT_REQUEST_LEDGER_CENTS } from "../../db/schemas/payment-requests";
import type { PaymentRequestDto } from "../types/cloud-api";

export { IgnoredWebhookEvent } from "./payment-webhook-errors";

import { logger } from "../utils/logger";

export type { PaymentRequestRow } from "../../db/repositories/payment-requests";

export type PaymentProvider = PaymentRequestRow["provider"];
export type PaymentRequestStatus = PaymentRequestRow["status"];
export type PaymentRequestContext = PaymentRequestRow["paymentContext"];
export type PublicPaymentRequest = Pick<
  PaymentRequestRow,
  "id" | "provider" | "amountCents" | "currency" | "reason" | "status" | "hostedUrl" | "expiresAt"
>;

const DEFAULT_EXPIRES_IN_MS = 30 * 60 * 1000; // 30 minutes
const TERMINAL_STATUSES: ReadonlySet<PaymentRequestStatus> = new Set([
  "settled",
  "failed",
  "expired",
  "canceled",
]);

const SUPPORTED_PROVIDERS: ReadonlyArray<PaymentProvider> = [
  "stripe",
  "oxapay",
  "x402",
  "wallet_native",
];

export interface CreatePaymentRequestInput {
  organizationId: string;
  agentId?: string | null;
  appId?: string | null;
  provider: PaymentProvider;
  amountCents: number;
  currency?: string;
  reason?: string;
  paymentContext: PaymentRequestContext;
  callbackUrl?: string;
  callbackSecret?: string;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
  payerIdentityId?: string;
  payerUserId?: string;
}

export interface ListPaymentRequestsFilter {
  status?: PaymentRequestStatus;
  agentId?: string;
  provider?: PaymentProvider;
  limit?: number;
  offset?: number;
}

export interface PaymentProviderAdapter {
  provider: PaymentProvider;
  /**
   * Creates the provider-side intent (Stripe Checkout session, OxaPay invoice,
   * x402 request). Returns hostedUrl and providerIntent JSON to persist on the
   * payment_requests row.
   */
  createIntent(args: {
    request: PaymentRequestRow;
  }): Promise<{ hostedUrl?: string; providerIntent: Record<string, unknown> }>;
  /**
   * Optional: verify a webhook payload signature. Returns parsed payload or throws.
   */
  parseWebhook?(args: { rawBody: string; signature: string | null }): Promise<{
    paymentRequestId: string;
    status: "settled" | "failed";
    providerEventId: string;
    txRef?: string;
    amountCents?: number;
    currency?: string;
    proof: Record<string, unknown>;
  }>;
}

export interface PaymentRequestsService {
  create(
    input: CreatePaymentRequestInput,
  ): Promise<{ paymentRequest: PaymentRequestRow; hostedUrl?: string }>;
  get(id: string, organizationId: string): Promise<PaymentRequestRow | null>;
  getPublic(id: string): Promise<PaymentRequestRow | null>;
  list(organizationId: string, filter?: ListPaymentRequestsFilter): Promise<PaymentRequestRow[]>;
  cancel(id: string, organizationId: string, reason?: string): Promise<PaymentRequestRow>;
  expirePast(now?: Date): Promise<string[]>;
  /**
   * Org-scoped expire sweep for tenant-local janitor flows. The unscoped
   * {@link expirePast} is reserved for the system cron janitor.
   */
  expirePastForOrg(organizationId: string, now?: Date): Promise<string[]>;
  /**
   * Expire a single payment request the caller's org owns (scoped). Use this
   * from request handlers; `expirePast` is the unscoped system/cron sweep.
   */
  expire(
    id: string,
    organizationId: string,
    now?: Date,
  ): Promise<{ paymentRequest: PaymentRequestRow; expired: boolean }>;
  /**
   * Settlement is provider-driven and called by provider webhook routes before
   * they fan out notifications on PaymentCallbackBus.
   */
  markSettled(
    id: string,
    settlementTxRef: string,
    settlementProof: Record<string, unknown>,
  ): Promise<PaymentRequestRow>;
  markInitialized(
    id: string,
    providerIntent: Record<string, unknown>,
    hostedUrl?: string | null,
  ): Promise<PaymentRequestRow>;
  markFailed(id: string, error: string): Promise<PaymentRequestRow>;
}

interface PaymentRequestsServiceDeps {
  repository: PaymentRequestsRepository;
  adapters: PaymentProviderAdapter[];
}

function validateCreateInput(input: CreatePaymentRequestInput): void {
  if (!input.organizationId) {
    throw new Error("organizationId is required");
  }
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
    throw new Error(`Unsupported provider: ${input.provider}`);
  }
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > MAX_PAYMENT_REQUEST_LEDGER_CENTS
  ) {
    throw new Error("amountCents must be a positive safe integer within the credit ledger range");
  }
  if ((input.currency ?? "USD").trim().toUpperCase() !== "USD") {
    throw new Error("Credit top-up payment requests require USD currency");
  }
  if (!input.paymentContext || typeof input.paymentContext.kind !== "string") {
    throw new Error("paymentContext is required");
  }
  if (input.paymentContext.kind !== "any_payer") {
    throw new Error("Only any_payer payment requests are supported until payer verification lands");
  }
  if (input.callbackSecret && !input.callbackUrl) {
    throw new Error("callbackSecret requires callbackUrl");
  }
  if (
    input.expiresInMs !== undefined &&
    (!Number.isFinite(input.expiresInMs) || input.expiresInMs <= 0)
  ) {
    throw new Error("expiresInMs must be a finite positive number");
  }
}

function assertNotTerminal(row: PaymentRequestRow, action: string): void {
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new Error(
      `Cannot ${action} payment request ${row.id}: already in terminal status "${row.status}"`,
    );
  }
}

function assertCancelable(row: PaymentRequestRow): void {
  if (row.status !== "pending" && row.status !== "delivered") {
    throw new Error(
      `Cannot cancel payment request ${row.id}: status "${row.status}" is not cancelable`,
    );
  }
}

function requireRow(
  row: PaymentRequestRow | null | undefined,
  id: string,
  context: string,
): PaymentRequestRow {
  if (!row) {
    throw new Error(`Payment request ${id} not found (${context})`);
  }
  return row;
}

class PaymentRequestsServiceImpl implements PaymentRequestsService {
  private readonly repository: PaymentRequestsRepository;
  private readonly adapters: Map<PaymentProvider, PaymentProviderAdapter>;

  constructor(deps: PaymentRequestsServiceDeps) {
    this.repository = deps.repository;
    this.adapters = new Map();
    for (const adapter of deps.adapters) {
      if (this.adapters.has(adapter.provider)) {
        throw new Error(`Duplicate adapter registered for provider: ${adapter.provider}`);
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  private getAdapter(provider: PaymentProvider): PaymentProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  async create(
    input: CreatePaymentRequestInput,
  ): Promise<{ paymentRequest: PaymentRequestRow; hostedUrl?: string }> {
    validateCreateInput(input);
    const adapter = this.getAdapter(input.provider);

    const expiresInMs = input.expiresInMs ?? DEFAULT_EXPIRES_IN_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMs);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("expiresInMs must produce a valid expiration date");
    }

    const created = await this.repository.createPaymentRequest({
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      appId: input.appId ?? null,
      provider: input.provider,
      amountCents: input.amountCents,
      currency: (input.currency ?? "USD").trim().toUpperCase(),
      reason: input.reason ?? null,
      paymentContext: input.paymentContext,
      payerIdentityId: input.payerIdentityId ?? null,
      payerUserId: input.payerUserId ?? null,
      callbackUrl: input.callbackUrl ?? null,
      callbackSecret: input.callbackSecret ?? null,
      expiresAt,
      metadata: input.metadata ?? {},
    });

    const intent = await adapter.createIntent({ request: created });
    const row = await this.markInitialized(
      created.id,
      intent.providerIntent,
      intent.hostedUrl ?? null,
    );

    logger.info("[PaymentRequests] Created payment request", {
      paymentRequestId: row.id,
      organizationId: row.organizationId,
      provider: row.provider,
      amountCents: row.amountCents,
      currency: row.currency,
    });

    return { paymentRequest: row, hostedUrl: row.hostedUrl ?? undefined };
  }

  async get(id: string, organizationId: string): Promise<PaymentRequestRow | null> {
    const row = await this.repository.getPaymentRequest(id);
    if (!row || row.organizationId !== organizationId) return null;
    return row;
  }

  async getPublic(id: string): Promise<PaymentRequestRow | null> {
    return this.repository.getPaymentRequest(id);
  }

  async list(
    organizationId: string,
    filter: ListPaymentRequestsFilter = {},
  ): Promise<PaymentRequestRow[]> {
    return this.repository.listPaymentRequests({
      organizationId,
      status: filter.status,
      agentId: filter.agentId,
      provider: filter.provider,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  async cancel(id: string, organizationId: string, reason?: string): Promise<PaymentRequestRow> {
    const canceledAt = new Date();
    const updated = await this.repository.cancelPaymentRequest(
      id,
      organizationId,
      reason,
      canceledAt,
    );
    if (!updated) {
      const existing = requireRow(
        await this.repository.getPaymentRequest(id),
        id,
        "cancel compare-and-set",
      );
      if (existing.organizationId !== organizationId) {
        throw new Error(`Payment request ${id} does not belong to organization ${organizationId}`);
      }
      if (existing.status === "canceled") return existing;
      if (
        (existing.status === "pending" || existing.status === "delivered") &&
        existing.expiresAt.getTime() <= canceledAt.getTime()
      ) {
        throw new Error(
          `Cannot cancel payment request ${id}: expired at ${existing.expiresAt.toISOString()}`,
        );
      }
      assertCancelable(existing);
      throw new Error(`Cannot cancel payment request ${id}: state changed concurrently`);
    }

    logger.info("[PaymentRequests] Canceled payment request", {
      paymentRequestId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expire(
    id: string,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<{ paymentRequest: PaymentRequestRow; expired: boolean }> {
    const existing = requireRow(await this.repository.getPaymentRequest(id), id, "expire lookup");
    if (existing.organizationId !== organizationId) {
      throw new Error(`Payment request ${id} does not belong to organization ${organizationId}`);
    }

    const expired = await this.repository.expirePastPaymentRequest(id, now);
    if (expired) {
      logger.info("[PaymentRequests] Expired payment request", {
        paymentRequestId: id,
        organizationId,
      });
    }

    const after = requireRow(await this.repository.getPaymentRequest(id), id, "expire after");
    return { paymentRequest: after, expired };
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastPaymentRequests(now);
    if (expiredIds.length > 0) {
      logger.info("[PaymentRequests] Expired payment requests", {
        count: expiredIds.length,
      });
    }
    return expiredIds;
  }

  async expirePastForOrg(organizationId: string, now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastPaymentRequestsForOrg(organizationId, now);
    if (expiredIds.length > 0) {
      logger.info("[PaymentRequests] Expired payment requests", {
        organizationId,
        count: expiredIds.length,
      });
    }
    return expiredIds;
  }

  async markSettled(
    id: string,
    settlementTxRef: string,
    settlementProof: Record<string, unknown>,
  ): Promise<PaymentRequestRow> {
    const settledAt = new Date();
    const updated = await this.repository.settlePaymentRequest(
      id,
      settledAt,
      settlementTxRef,
      settlementProof,
    );
    if (!updated) {
      const existing = requireRow(
        await this.repository.getPaymentRequest(id),
        id,
        "markSettled compare-and-set",
      );
      if (existing.status === "settled" && existing.settlementTxRef === settlementTxRef) {
        return existing;
      }
      assertNotTerminal(existing, "settle");
      throw new Error(`Cannot settle payment request ${id}: state changed concurrently`);
    }

    logger.info("[PaymentRequests] Settled payment request", {
      paymentRequestId: id,
      provider: updated.provider,
      amountCents: updated.amountCents,
      txRef: settlementTxRef,
    });

    return updated;
  }

  async markInitialized(
    id: string,
    providerIntent: Record<string, unknown>,
    hostedUrl?: string | null,
  ): Promise<PaymentRequestRow> {
    const initializedAt = new Date();
    const updated = await this.repository.initializePaymentRequest(
      id,
      providerIntent,
      hostedUrl ?? null,
      initializedAt,
    );
    if (updated) return updated;

    const existing = requireRow(
      await this.repository.getPaymentRequest(id),
      id,
      "markInitialized compare-and-set",
    );
    if (
      existing.status === "delivered" &&
      existing.hostedUrl === (hostedUrl ?? null) &&
      JSON.stringify(existing.providerIntent) === JSON.stringify(providerIntent)
    ) {
      return existing;
    }
    if (existing.status === "pending" && existing.expiresAt.getTime() <= initializedAt.getTime()) {
      throw new Error(
        `Cannot initialize payment request ${id}: expired at ${existing.expiresAt.toISOString()}`,
      );
    }
    assertNotTerminal(existing, "initialize");
    throw new Error(
      `Cannot initialize payment request ${id}: state changed concurrently to "${existing.status}"`,
    );
  }

  async markFailed(id: string, error: string): Promise<PaymentRequestRow> {
    const updated = await this.repository.failPaymentRequest(id, error, new Date());
    if (!updated) {
      const existing = requireRow(
        await this.repository.getPaymentRequest(id),
        id,
        "markFailed compare-and-set",
      );
      if (existing.status === "failed") return existing;
      assertNotTerminal(existing, "fail");
      throw new Error(`Cannot fail payment request ${id}: state changed concurrently`);
    }

    logger.warn("[PaymentRequests] Failed payment request", {
      paymentRequestId: id,
      provider: updated.provider,
      error,
    });

    return updated;
  }
}

export function createPaymentRequestsService(
  deps: PaymentRequestsServiceDeps,
): PaymentRequestsService {
  return new PaymentRequestsServiceImpl(deps);
}

/** Constructs the allowlisted creator-facing representation of an internal row. */
export function toPaymentRequestDto(row: PaymentRequestRow): PaymentRequestDto {
  return {
    id: row.id,
    agentId: row.agentId,
    appId: row.appId,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    hostedUrl: row.hostedUrl,
    settledAt: row.settledAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublicPaymentRequest(
  row: PaymentRequestRow,
  now: Date = new Date(),
): PublicPaymentRequest {
  const status =
    (row.status === "pending" || row.status === "delivered") &&
    row.expiresAt.getTime() <= now.getTime()
      ? "expired"
      : row.status;
  return {
    id: row.id,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason,
    status,
    hostedUrl: status === "expired" ? null : row.hostedUrl,
    expiresAt: row.expiresAt,
  };
}
