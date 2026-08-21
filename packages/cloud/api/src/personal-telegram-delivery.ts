/**
 * Strongly ordered Telegram egress ledger for Personal Shared edge turns.
 * One object serves one project, bot account, and sender; message text and
 * credentials never enter storage. Ambiguous provider sends remain tombstoned
 * so Telegram retries cannot duplicate a reply.
 */

import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const PERSONAL_TELEGRAM_DELIVERY_PATH = "/v1/delivery";
const PROCESSING_TTL_MS = 120_000;
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60_000;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const PROVIDER_MESSAGE_ID_RE = /^\d{1,32}$/;

type DeliveryState = "uncertain" | "delivered";
type DeliveryOperation =
  | "read"
  | "read_receipt"
  | "claim_processing"
  | "release_processing"
  | "prepare_plan"
  | "read_chunk"
  | "claim_chunk"
  | "release_chunk"
  | "mark_chunk_delivered"
  | "mark_uncertain"
  | "mark_delivered";

interface ExpiringState<T> {
  value: T;
  expiresAt: number;
}

interface DeliveryRequest {
  messageId: string;
  operation: DeliveryOperation;
  chunkDigests?: string[];
  chunkIndex?: number;
  chunkDigest?: string;
  providerMessageId?: string;
}

interface DeliveryReceipt {
  acceptedAt: string;
  providerMessageIds: string[];
}

const CHUNK_DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_REPLY_CHUNKS = 64;

function isDeliveryRequest(value: unknown): value is DeliveryRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.messageId !== "string" ||
    !MESSAGE_ID_RE.test(candidate.messageId)
  ) {
    return false;
  }
  const operation = candidate.operation;
  if (
    operation === "read" ||
    operation === "read_receipt" ||
    operation === "claim_processing" ||
    operation === "release_processing" ||
    operation === "mark_uncertain" ||
    operation === "mark_delivered"
  ) {
    return true;
  }
  if (operation === "prepare_plan") {
    return (
      Array.isArray(candidate.chunkDigests) &&
      candidate.chunkDigests.length <= MAX_REPLY_CHUNKS &&
      candidate.chunkDigests.every(
        (digest) => typeof digest === "string" && CHUNK_DIGEST_RE.test(digest),
      )
    );
  }
  const validChunkOperation =
    (operation === "read_chunk" ||
      operation === "claim_chunk" ||
      operation === "release_chunk" ||
      operation === "mark_chunk_delivered") &&
    typeof candidate.chunkIndex === "number" &&
    Number.isInteger(candidate.chunkIndex) &&
    candidate.chunkIndex >= 0 &&
    candidate.chunkIndex < MAX_REPLY_CHUNKS &&
    typeof candidate.chunkDigest === "string" &&
    CHUNK_DIGEST_RE.test(candidate.chunkDigest);
  if (!validChunkOperation) return false;
  return (
    operation !== "mark_chunk_delivered" ||
    candidate.providerMessageId === undefined ||
    (typeof candidate.providerMessageId === "string" &&
      PROVIDER_MESSAGE_ID_RE.test(candidate.providerMessageId))
  );
}

function processingKey(messageId: string): string {
  return `processing:${messageId}`;
}

function deliveryKey(messageId: string): string {
  return `delivery:${messageId}`;
}

function receiptKey(messageId: string): string {
  return `receipt:${messageId}`;
}

function planKey(messageId: string): string {
  return `plan:${messageId}`;
}

function chunkKey(messageId: string, chunkIndex: number): string {
  return `chunk:${messageId}:${chunkIndex}`;
}

function plansEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((digest, index) => digest === right[index])
  );
}

export class PersonalTelegramDelivery {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    _env: AppEnv["Bindings"],
  ) {}

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readExpiring<T>(key: string): Promise<T | null> {
    const entry = await this.state.storage.get<ExpiringState<T>>(key);
    if (!entry) return null;
    if (entry.expiresAt > Date.now()) return entry.value;
    await this.state.storage.delete(key);
    return null;
  }

  private async scheduleCleanup(expiresAt: number): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || expiresAt < existing) {
      await this.state.storage.setAlarm(expiresAt);
    }
  }

  private async operate(input: DeliveryRequest): Promise<Response> {
    const deliveryStorageKey = deliveryKey(input.messageId);
    const processingStorageKey = processingKey(input.messageId);
    if (input.operation === "read") {
      const state = await this.readExpiring<DeliveryState>(deliveryStorageKey);
      return Response.json({ state });
    }
    if (input.operation === "read_receipt") {
      const receipt = await this.readExpiring<DeliveryReceipt>(
        receiptKey(input.messageId),
      );
      return Response.json(
        receipt ?? { acceptedAt: null, providerMessageIds: [] },
      );
    }
    if (input.operation === "claim_processing") {
      const existing = await this.readExpiring<boolean>(processingStorageKey);
      if (existing) return Response.json({ claimed: false });
      const expiresAt = Date.now() + PROCESSING_TTL_MS;
      await this.state.storage.put(processingStorageKey, {
        value: true,
        expiresAt,
      } satisfies ExpiringState<boolean>);
      await this.scheduleCleanup(expiresAt);
      return Response.json({ claimed: true });
    }
    if (input.operation === "release_processing") {
      await this.state.storage.delete(processingStorageKey);
      return Response.json({ released: true });
    }
    if (input.operation === "prepare_plan") {
      const chunkDigests = input.chunkDigests ?? [];
      const storageKey = planKey(input.messageId);
      const existing = await this.readExpiring<string[]>(storageKey);
      if (existing) {
        return Response.json({
          plan: plansEqual(existing, chunkDigests) ? "prepared" : "conflict",
        });
      }
      const expiresAt = Date.now() + DELIVERY_TTL_MS;
      await this.state.storage.put(storageKey, {
        value: chunkDigests,
        expiresAt,
      } satisfies ExpiringState<string[]>);
      await this.scheduleCleanup(expiresAt);
      return Response.json({ plan: "prepared" });
    }
    if (
      input.operation === "read_chunk" ||
      input.operation === "claim_chunk" ||
      input.operation === "release_chunk" ||
      input.operation === "mark_chunk_delivered"
    ) {
      const chunkIndex = input.chunkIndex ?? -1;
      const chunkDigest = input.chunkDigest ?? "";
      const plan = await this.readExpiring<string[]>(planKey(input.messageId));
      if (!plan || plan[chunkIndex] !== chunkDigest) {
        return Response.json(
          { error: "Telegram chunk does not match plan" },
          { status: 409 },
        );
      }
      const storageKey = chunkKey(input.messageId, chunkIndex);
      if (input.operation === "read_chunk") {
        const state = await this.readExpiring<DeliveryState>(storageKey);
        return Response.json({ state });
      }
      if (input.operation === "release_chunk") {
        await this.state.storage.delete(storageKey);
        return Response.json({ released: true });
      }
      if (input.operation === "claim_chunk") {
        const existing = await this.readExpiring<DeliveryState>(storageKey);
        if (existing) return Response.json({ claimed: false });
        const expiresAt = Date.now() + DELIVERY_TTL_MS;
        await this.state.storage.put(storageKey, {
          value: "uncertain",
          expiresAt,
        } satisfies ExpiringState<DeliveryState>);
        await this.scheduleCleanup(expiresAt);
        return Response.json({ claimed: true });
      }
      const expiresAt = Date.now() + DELIVERY_TTL_MS;
      const delivered = {
        value: "delivered",
        expiresAt,
      } satisfies ExpiringState<DeliveryState>;
      if (input.providerMessageId) {
        const receiptStorageKey = receiptKey(input.messageId);
        const existingReceipt =
          await this.readExpiring<DeliveryReceipt>(receiptStorageKey);
        const receipt = {
          value: {
            acceptedAt: existingReceipt?.acceptedAt ?? new Date().toISOString(),
            providerMessageIds: Array.from(
              new Set([
                ...(existingReceipt?.providerMessageIds ?? []),
                input.providerMessageId,
              ]),
            ),
          },
          expiresAt,
        } satisfies ExpiringState<DeliveryReceipt>;
        await this.state.storage.put({
          [storageKey]: delivered,
          [receiptStorageKey]: receipt,
        });
      } else {
        await this.state.storage.put(storageKey, delivered);
      }
      await this.scheduleCleanup(expiresAt);
      return Response.json({ delivered: true });
    }
    const existing = await this.readExpiring<DeliveryState>(deliveryStorageKey);
    const requested =
      input.operation === "mark_uncertain" ? "uncertain" : "delivered";
    const value = existing === "delivered" ? "delivered" : requested;
    const expiresAt = Date.now() + DELIVERY_TTL_MS;
    await this.state.storage.put(deliveryStorageKey, {
      value,
      expiresAt,
    } satisfies ExpiringState<DeliveryState>);
    await this.state.storage.delete(processingStorageKey);
    await this.scheduleCleanup(expiresAt);
    return Response.json({ state: value });
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const now = Date.now();
      const entries = await this.state.storage.list<ExpiringState<unknown>>();
      const expired: string[] = [];
      let nextExpiration: number | null = null;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) {
          expired.push(key);
        } else if (
          nextExpiration === null ||
          entry.expiresAt < nextExpiration
        ) {
          nextExpiration = entry.expiresAt;
        }
      }
      if (expired.length > 0) await this.state.storage.delete(expired);
      if (nextExpiration !== null) {
        await this.state.storage.setAlarm(nextExpiration);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== PERSONAL_TELEGRAM_DELIVERY_PATH
        ) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const body: unknown = await request.json();
        if (!isDeliveryRequest(body)) {
          return Response.json(
            { error: "Invalid Telegram delivery operation" },
            { status: 400 },
          );
        }
        return this.operate(body);
      } catch (error) {
        // error-policy:J1 the durable transport boundary fails visibly.
        logger.error("[PersonalTelegramDelivery] operation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          { error: "Telegram delivery ledger failed" },
          { status: 502 },
        );
      }
    });
  }
}
