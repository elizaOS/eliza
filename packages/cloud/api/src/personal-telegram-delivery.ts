/**
 * Strongly ordered Telegram delivery ledger for Personal Shared edge turns.
 * Every transition is fenced by a renewable owner claim; durable records keep
 * only plan metadata, chunk cursors, and provider receipts, never reply text.
 */

import type { TelegramDeliveryProgress } from "@elizaos/cloud-services-common/telegram-delivery";
import { sha256Hex } from "@/lib/oidc/crypto";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

export const PERSONAL_TELEGRAM_DELIVERY_PATH = "/v1/delivery";
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60_000;
const MESSAGE_ID_RE = /^\d{1,32}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const TELEGRAM_ID_RE = /^[1-9]\d{0,31}$/;
const TOKEN_RE = /^[0-9a-f-]{36}$/i;

type DeliveryOperation =
  | "read"
  | "claim_processing"
  | "renew_processing"
  | "release_processing"
  | "prepare_plan"
  | "claim_chunk"
  | "record_accepted"
  | "record_explicit_rejection"
  | "mark_delivered";

interface ExpiringState<T> {
  value: T;
  expiresAt: number;
}
interface ProcessingClaim {
  ownerToken: string;
  expiresAt: number;
}
interface DeliveryRequest {
  messageId: string;
  operation: DeliveryOperation;
  ownerToken?: string;
  leaseMs?: number;
  contentDigest?: string;
  totalChunks?: number;
  chunkIndex?: number;
  providerMessageId?: string;
}

export interface PersonalTelegramDeliveryScope {
  project: string;
  accountFingerprint: string;
  senderId: string;
}

export class InvalidPersonalTelegramDeliveryScopeError extends Error {
  override readonly name = "InvalidPersonalTelegramDeliveryScopeError";
}

export async function personalTelegramDeliveryObjectName(
  scope: PersonalTelegramDeliveryScope,
): Promise<string> {
  if (
    !PROJECT_RE.test(scope.project) ||
    !ACCOUNT_FINGERPRINT_RE.test(scope.accountFingerprint) ||
    !TELEGRAM_ID_RE.test(scope.senderId)
  ) {
    throw new InvalidPersonalTelegramDeliveryScopeError(
      "Invalid Personal Telegram delivery scope",
    );
  }
  const senderFingerprint = await sha256Hex(scope.senderId);
  return `telegram:${scope.project}:${scope.accountFingerprint}:${senderFingerprint}`;
}

export async function personalTelegramDeliveryStub(
  env: AppEnv["Bindings"],
  scope: PersonalTelegramDeliveryScope,
): Promise<{
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}> {
  const namespace = env.PERSONAL_TELEGRAM_DELIVERIES;
  if (!namespace) {
    throw new Error("Personal Telegram delivery binding is missing");
  }
  return namespace.getByName(await personalTelegramDeliveryObjectName(scope));
}

function isDeliveryRequest(value: unknown): value is DeliveryRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.messageId === "string" &&
    MESSAGE_ID_RE.test(input.messageId) &&
    typeof input.operation === "string" &&
    [
      "read",
      "claim_processing",
      "renew_processing",
      "release_processing",
      "prepare_plan",
      "claim_chunk",
      "record_accepted",
      "record_explicit_rejection",
      "mark_delivered",
    ].includes(input.operation)
  );
}

function processingKey(id: string): string {
  return `processing:${id}`;
}
function deliveryKey(id: string): string {
  return `delivery:${id}`;
}

export class PersonalTelegramDelivery {
  private operationQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly state: DurableObjectState,
    _env: AppEnv["Bindings"],
  ) {}

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
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
    if (existing === null || expiresAt < existing)
      await this.state.storage.setAlarm(expiresAt);
  }

  private validOwner(
    input: DeliveryRequest,
  ): input is DeliveryRequest & { ownerToken: string } {
    return (
      typeof input.ownerToken === "string" && TOKEN_RE.test(input.ownerToken)
    );
  }

  private async ownsClaim(input: DeliveryRequest): Promise<boolean> {
    if (!this.validOwner(input)) return false;
    const claim = await this.readExpiring<ProcessingClaim>(
      processingKey(input.messageId),
    );
    return claim?.ownerToken === input.ownerToken;
  }

  private async operate(input: DeliveryRequest): Promise<Response> {
    const deliveryStorageKey = deliveryKey(input.messageId);
    const processingStorageKey = processingKey(input.messageId);
    if (input.operation === "read") {
      return Response.json({
        progress:
          await this.readExpiring<TelegramDeliveryProgress>(deliveryStorageKey),
      });
    }
    if (input.operation === "claim_processing") {
      if (
        !this.validOwner(input) ||
        !Number.isInteger(input.leaseMs) ||
        (input.leaseMs ?? 0) < 1_000
      )
        return Response.json({ error: "Invalid claim" }, { status: 400 });
      if (await this.readExpiring<ProcessingClaim>(processingStorageKey))
        return Response.json({ claimed: false });
      const expiresAt = Date.now() + (input.leaseMs as number);
      await this.state.storage.put(processingStorageKey, {
        value: { ownerToken: input.ownerToken, expiresAt },
        expiresAt,
      } satisfies ExpiringState<ProcessingClaim>);
      await this.scheduleCleanup(expiresAt);
      return Response.json({ claimed: true });
    }
    if (input.operation === "renew_processing") {
      if (
        !(await this.ownsClaim(input)) ||
        !Number.isInteger(input.leaseMs) ||
        (input.leaseMs ?? 0) < 1_000
      )
        return Response.json({ renewed: false });
      const expiresAt = Date.now() + (input.leaseMs as number);
      await this.state.storage.put(processingStorageKey, {
        value: { ownerToken: input.ownerToken as string, expiresAt },
        expiresAt,
      } satisfies ExpiringState<ProcessingClaim>);
      await this.scheduleCleanup(expiresAt);
      return Response.json({ renewed: true });
    }
    if (input.operation === "release_processing") {
      if (await this.ownsClaim(input))
        await this.state.storage.delete(processingStorageKey);
      return Response.json({ released: true });
    }
    if (!(await this.ownsClaim(input)))
      return Response.json({ error: "Processing claim lost" }, { status: 409 });

    let progress =
      await this.readExpiring<TelegramDeliveryProgress>(deliveryStorageKey);
    if (input.operation === "prepare_plan") {
      if (
        typeof input.contentDigest !== "string" ||
        !/^[0-9a-f]{64}$|^$/.test(input.contentDigest) ||
        !Number.isInteger(input.totalChunks) ||
        (input.totalChunks ?? -1) < 0
      )
        return Response.json({ error: "Invalid plan" }, { status: 400 });
      progress ??= {
        state: "pending",
        contentDigest: input.contentDigest,
        totalChunks: input.totalChunks as number,
        nextChunkIndex: 0,
        providerMessageIds: [],
      };
      if (
        progress.contentDigest !== input.contentDigest ||
        progress.totalChunks !== input.totalChunks
      )
        return Response.json({ error: "Plan conflict" }, { status: 409 });
    } else if (!progress) {
      return Response.json({ error: "Plan missing" }, { status: 409 });
    } else if (input.operation === "claim_chunk") {
      if (
        progress.state !== "pending" ||
        input.chunkIndex !== progress.nextChunkIndex ||
        input.chunkIndex >= progress.totalChunks
      )
        return Response.json({ claimed: false });
      progress = {
        ...progress,
        state: "egress_started",
        activeChunkIndex: input.chunkIndex,
      };
    } else if (input.operation === "record_accepted") {
      if (
        progress.state !== "egress_started" ||
        input.chunkIndex !== progress.activeChunkIndex ||
        typeof input.providerMessageId !== "string" ||
        !input.providerMessageId
      )
        return Response.json({ error: "Invalid acceptance" }, { status: 409 });
      progress = {
        ...progress,
        state: "pending",
        nextChunkIndex: progress.nextChunkIndex + 1,
        providerMessageIds: [
          ...progress.providerMessageIds,
          input.providerMessageId,
        ],
      };
      delete progress.activeChunkIndex;
    } else if (input.operation === "record_explicit_rejection") {
      if (
        progress.state !== "egress_started" ||
        input.chunkIndex !== progress.activeChunkIndex
      )
        return Response.json({ error: "Invalid rejection" }, { status: 409 });
      progress = { ...progress, state: "pending" };
      delete progress.activeChunkIndex;
    } else {
      if (
        progress.state !== "pending" ||
        progress.nextChunkIndex !== progress.totalChunks
      )
        return Response.json({ error: "Delivery incomplete" }, { status: 409 });
      progress = { ...progress, state: "delivered" };
    }
    const expiresAt = Date.now() + DELIVERY_TTL_MS;
    await this.state.storage.put(deliveryStorageKey, {
      value: progress,
      expiresAt,
    } satisfies ExpiringState<TelegramDeliveryProgress>);
    await this.scheduleCleanup(expiresAt);
    return Response.json({
      progress,
      claimed: input.operation === "claim_chunk",
    });
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const now = Date.now();
      const entries = await this.state.storage.list<ExpiringState<unknown>>();
      const expired: string[] = [];
      let nextExpiration: number | null = null;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) expired.push(key);
        else if (nextExpiration === null || entry.expiresAt < nextExpiration)
          nextExpiration = entry.expiresAt;
      }
      if (expired.length > 0) await this.state.storage.delete(expired);
      if (nextExpiration !== null)
        await this.state.storage.setAlarm(nextExpiration);
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== PERSONAL_TELEGRAM_DELIVERY_PATH
        )
          return Response.json({ error: "Not found" }, { status: 404 });
        const body: unknown = await request.json();
        if (!isDeliveryRequest(body))
          return Response.json(
            { error: "Invalid Telegram delivery operation" },
            { status: 400 },
          );
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
