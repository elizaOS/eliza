import crypto from "node:crypto";

export type LocalPaymentProvider = "wallet_native" | "x402";

export type LocalPaymentStatus =
  | "pending"
  | "delivered"
  | "settled"
  | "failed"
  | "expired"
  | "canceled";

export type LocalPaymentContext =
  | { kind: "any_payer" }
  | { kind: "verified_payer"; scope?: string }
  | { kind: "specific_payer"; payerIdentityId: string };

export interface LocalPaymentRequest {
  id: string;
  provider: LocalPaymentProvider;
  amountCents: number;
  currency: string;
  reason?: string;
  paymentContext: LocalPaymentContext;
  status: LocalPaymentStatus;
  hostedUrl?: string;
  expiresAt: number;
  createdAt: number;
  settledAt?: number;
  txRef?: string;
  metadata: Record<string, unknown>;
}

export interface LocalPaymentStoreFilter {
  status?: LocalPaymentStatus;
  createdSince?: number;
}

export interface LocalPaymentStore {
  insert(req: LocalPaymentRequest): Promise<LocalPaymentRequest>;
  get(id: string): Promise<LocalPaymentRequest | null>;
  list(filter?: LocalPaymentStoreFilter): Promise<LocalPaymentRequest[]>;
  setStatus(
    id: string,
    status: LocalPaymentStatus,
    patch?: Partial<LocalPaymentRequest>,
  ): Promise<LocalPaymentRequest | null>;
  expirePast(now: number): Promise<string[]>;
}

export function newPaymentRequestId(): string {
  return crypto.randomUUID();
}

export function createInMemoryLocalPaymentStore(): LocalPaymentStore {
  const records = new Map<string, LocalPaymentRequest>();

  function clone(req: LocalPaymentRequest): LocalPaymentRequest {
    return {
      ...req,
      paymentContext: { ...req.paymentContext } as LocalPaymentContext,
      metadata: { ...req.metadata },
    };
  }

  return {
    async insert(req) {
      if (records.has(req.id)) {
        throw new Error(`payment_request_already_exists:${req.id}`);
      }
      records.set(req.id, clone(req));
      return clone(req);
    },
    async get(id) {
      const found = records.get(id);
      return found ? clone(found) : null;
    },
    async list(filter) {
      const out: LocalPaymentRequest[] = [];
      for (const record of records.values()) {
        if (filter?.status && record.status !== filter.status) continue;
        if (
          typeof filter?.createdSince === "number" &&
          record.createdAt < filter.createdSince
        ) {
          continue;
        }
        out.push(clone(record));
      }
      return out.sort((a, b) => a.createdAt - b.createdAt);
    },
    async setStatus(id, status, patch) {
      const existing = records.get(id);
      if (!existing) return null;
      const next: LocalPaymentRequest = {
        ...existing,
        ...(patch ?? {}),
        status,
        id: existing.id,
        metadata: { ...existing.metadata, ...(patch?.metadata ?? {}) },
        paymentContext: (patch?.paymentContext ??
          existing.paymentContext) as LocalPaymentContext,
      };
      records.set(id, next);
      return clone(next);
    },
    async expirePast(now) {
      const expired: string[] = [];
      for (const record of records.values()) {
        if (record.status !== "pending" && record.status !== "delivered") {
          continue;
        }
        if (record.expiresAt > now) continue;
        const next: LocalPaymentRequest = { ...record, status: "expired" };
        records.set(record.id, next);
        expired.push(record.id);
      }
      return expired;
    },
  };
}

export const localPaymentStore: LocalPaymentStore =
  createInMemoryLocalPaymentStore();
