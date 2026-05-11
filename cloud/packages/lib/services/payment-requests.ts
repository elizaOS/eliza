import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "@/db/repositories/payment-requests";

export { IgnoredWebhookEvent } from "@/lib/services/payment-webhook-errors";

import { logger } from "@/lib/utils/logger";

export type { PaymentRequestRow } from "@/db/repositories/payment-requests";

export type PaymentProvider = PaymentRequestRow["provider"];
export type PaymentRequestStatus = PaymentRequestRow["status"];
export type PaymentRequestContext = PaymentRequestRow["paymentContext"];

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
    txRef?: string;
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
   * Settlement is provider-driven and arrives via PaymentCallbackBus
   * (sibling B-cloud-bus worktree). The bus subscriber calls these.
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
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("amountCents must be a positive integer");
  }
  if (!input.paymentContext || typeof input.paymentContext.kind !== "string") {
    throw new Error("paymentContext is required");
  }
  if (input.paymentContext.kind === "specific_payer" && !input.paymentContext.payerIdentityId) {
    throw new Error("paymentContext.payerIdentityId is required for specific_payer");
  }
  if (input.callbackSecret && !input.callbackUrl) {
    throw new Error("callbackSecret requires callbackUrl");
  }
  if (input.expiresInMs !== undefined && input.expiresInMs <= 0) {
    throw new Error("expiresInMs must be positive");
  }
}

function redactSettlementPayload(args: {
  paymentRequest: PaymentRequestRow;
  status: PaymentRequestStatus;
  txRef?: string | null;
  error?: string;
}): Record<string, unknown> {
  return {
    paymentRequestId: args.paymentRequest.id,
    organizationId: args.paymentRequest.organizationId,
    provider: args.paymentRequest.provider,
    amountCents: args.paymentRequest.amountCents,
    currency: args.paymentRequest.currency,
    status: args.status,
    txRef: args.txRef ?? null,
    error: args.error,
  };
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

    const created = await this.repository.createPaymentRequest({
      organizationId: input.organizationId,
      agentId: input.agentId ?? null,
      appId: input.appId ?? null,
      provider: input.provider,
      amountCents: input.amountCents,
      currency: input.currency ?? "USD",
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

    const persisted = await this.repository.updatePaymentRequestStatus(created.id, null, {
      hostedUrl: intent.hostedUrl ?? null,
      providerIntent: intent.providerIntent,
    });
    const row = requireRow(persisted, created.id, "post-intent persist");

    await this.repository.recordPaymentRequestEvent({
      paymentRequestId: row.id,
      eventName: "payment.created",
      redactedPayload: redactSettlementPayload({
        paymentRequest: row,
        status: row.status,
      }),
    });

    logger.info("[PaymentRequests] Created payment request", {
      paymentRequestId: row.id,
      organizationId: row.organizationId,
      provider: row.provider,
      amountCents: row.amountCents,
      currency: row.currency,
    });

    return { paymentRequest: row, hostedUrl: intent.hostedUrl };
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
    const existing = requireRow(await this.repository.getPaymentRequest(id), id, "cancel lookup");
    if (existing.organizationId !== organizationId) {
      throw new Error(`Payment request ${id} does not belong to organization ${organizationId}`);
    }
    assertCancelable(existing);

    const updated = requireRow(
      await this.repository.updatePaymentRequestStatus(id, "canceled"),
      id,
      "cancel update",
    );

    await this.repository.recordPaymentRequestEvent({
      paymentRequestId: id,
      eventName: "payment.canceled",
      redactedPayload: redactSettlementPayload({
        paymentRequest: updated,
        status: "canceled",
        error: reason,
      }),
    });

    logger.info("[PaymentRequests] Canceled payment request", {
      paymentRequestId: id,
      organizationId,
      reason,
    });

    return updated;
  }

  async expirePast(now: Date = new Date()): Promise<string[]> {
    const expiredIds = await this.repository.expirePastPaymentRequests(now);
    for (const id of expiredIds) {
      const row = await this.repository.getPaymentRequest(id);
      if (!row) continue;
      await this.repository.recordPaymentRequestEvent({
        paymentRequestId: id,
        eventName: "payment.expired",
        redactedPayload: redactSettlementPayload({
          paymentRequest: row,
          status: "expired",
        }),
      });
    }
    if (expiredIds.length > 0) {
      logger.info("[PaymentRequests] Expired payment requests", {
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
    const existing = requireRow(
      await this.repository.getPaymentRequest(id),
      id,
      "markSettled lookup",
    );
    assertNotTerminal(existing, "settle");

    const settledAt = new Date();
    const updated = requireRow(
      await this.repository.updatePaymentRequestStatus(id, "settled", {
        settledAt,
        settlementTxRef,
        settlementProof,
      }),
      id,
      "markSettled update",
    );

    await this.repository.recordPaymentRequestEvent({
      paymentRequestId: id,
      eventName: "payment.settled",
      redactedPayload: redactSettlementPayload({
        paymentRequest: updated,
        status: "settled",
        txRef: settlementTxRef,
      }),
    });

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
    const updated = requireRow(
      await this.repository.updatePaymentRequestStatus(id, "delivered", {
        providerIntent,
        hostedUrl,
      }),
      id,
      "markInitialized update",
    );

    await this.repository.recordPaymentRequestEvent({
      paymentRequestId: id,
      eventName: "payment.delivered",
      redactedPayload: redactSettlementPayload({
        paymentRequest: updated,
        status: updated.status,
      }),
    });

    return updated;
  }

  async markFailed(id: string, error: string): Promise<PaymentRequestRow> {
    const existing = requireRow(
      await this.repository.getPaymentRequest(id),
      id,
      "markFailed lookup",
    );
    assertNotTerminal(existing, "fail");

    const updated = requireRow(
      await this.repository.updatePaymentRequestStatus(id, "failed"),
      id,
      "markFailed update",
    );

    await this.repository.recordPaymentRequestEvent({
      paymentRequestId: id,
      eventName: "payment.failed",
      redactedPayload: redactSettlementPayload({
        paymentRequest: updated,
        status: "failed",
        error,
      }),
    });

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

export function redactPaymentRequestForPublic(
  row: PaymentRequestRow,
): Omit<PaymentRequestRow, "callbackSecret" | "settlementProof"> {
  const { callbackSecret: _callbackSecret, settlementProof: _settlementProof, ...publicRow } = row;
  return {
    ...publicRow,
    payerIdentityId: row.paymentContext.kind === "any_payer" ? null : row.payerIdentityId,
  };
}
