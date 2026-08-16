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
const MESSAGE_ID_RE = /^\d{1,32}$/;

type DeliveryState = "egress_started" | "delivered";
type DeliveryOperation =
  | "read"
  | "claim_processing"
  | "release_processing"
  | "claim_egress"
  | "mark_delivered";

interface ExpiringState<T> {
  value: T;
  expiresAt: number;
}

interface DeliveryRequest {
  messageId: string;
  operation: DeliveryOperation;
}

function isDeliveryRequest(value: unknown): value is DeliveryRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.messageId === "string" &&
    MESSAGE_ID_RE.test(candidate.messageId) &&
    (candidate.operation === "read" ||
      candidate.operation === "claim_processing" ||
      candidate.operation === "release_processing" ||
      candidate.operation === "claim_egress" ||
      candidate.operation === "mark_delivered")
  );
}

function processingKey(messageId: string): string {
  return `processing:${messageId}`;
}

function deliveryKey(messageId: string): string {
  return `delivery:${messageId}`;
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
    if (input.operation === "claim_egress") {
      const existing =
        await this.readExpiring<DeliveryState>(deliveryStorageKey);
      if (existing) return Response.json({ claimed: false });
      const expiresAt = Date.now() + DELIVERY_TTL_MS;
      await this.state.storage.put(deliveryStorageKey, {
        value: "egress_started",
        expiresAt,
      } satisfies ExpiringState<DeliveryState>);
      await this.scheduleCleanup(expiresAt);
      return Response.json({ claimed: true });
    }
    const expiresAt = Date.now() + DELIVERY_TTL_MS;
    await this.state.storage.put(deliveryStorageKey, {
      value: "delivered",
      expiresAt,
    } satisfies ExpiringState<DeliveryState>);
    await this.state.storage.delete(processingStorageKey);
    await this.scheduleCleanup(expiresAt);
    return Response.json({ delivered: true });
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
