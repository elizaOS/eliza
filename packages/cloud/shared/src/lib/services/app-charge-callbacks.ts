/** Coordinates app-charge callback delivery and authorized room-message projection. */
import { MemoryType, stringToUuid } from "@elizaos/core";
import { randomUUID } from "crypto";
import Decimal from "decimal.js";
import { and, eq, lte, or } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../../db/client";
import { dbRead } from "../../db/helpers";
import { memoriesRepository } from "../../db/repositories/agents/memories";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import { appChargeCallbackOutbox } from "../../db/schemas/crypto-settlement-outbox";
import { safeFetch } from "../security/safe-fetch";
import type { DialogueMetadata } from "../types/message-content";
import { logger } from "../utils/logger";
import { callbackRoomBelongsToOrganization } from "./callback-channel-authz";
import { settlementDigest } from "./settlement-digest";

export type AppChargeCallbackStatus = "paid" | "failed";
export type AppChargeCallbackProvider = "stripe" | "oxapay";

export interface AppChargeCallbackChannel extends Record<string, unknown> {
  source?: string;
  roomId?: string;
  room_id?: string;
  agentId?: string;
  agent_id?: string;
  channelId?: string;
  channel_id?: string;
  messageId?: string;
  message_id?: string;
  threadId?: string;
  thread_id?: string;
}

export interface AppChargeCallbackDispatchParams {
  appId: string;
  chargeRequestId: string;
  status: AppChargeCallbackStatus;
  provider: AppChargeCallbackProvider;
  providerPaymentId: string;
  amountUsd?: number | string | null;
  payerUserId?: string | null;
  payerOrganizationId?: string | null;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Stable durable-delivery identity reused across outbox retries. */
  deliveryId?: string;
}

export interface AppChargeCallbackPayload {
  event: "app_charge.paid" | "app_charge.failed";
  createdAt: string;
  charge: {
    id: string;
    appId: string;
    amountUsd: string;
    status: AppChargeCallbackStatus;
    paymentContext: "verified_payer" | "any_payer";
    description?: string;
    paymentUrl?: string;
  };
  payment: {
    provider: AppChargeCallbackProvider;
    providerPaymentId: string;
    amountUsd: string;
    payerUserId?: string;
    payerOrganizationId?: string;
    reason?: string;
  };
  channel?: AppChargeCallbackChannel;
  metadata?: Record<string, unknown>;
}

export interface CallbackDispatchResult {
  httpPosted: boolean;
  roomMessageCreated: boolean;
  errors: string[];
}

interface AppChargeCallbackOutboxPayload extends Record<string, unknown> {
  version: 1;
  params: AppChargeCallbackDispatchParams;
  envelope: AppChargeCallbackPayload;
  target: {
    organizationId: string;
    channel?: AppChargeCallbackChannel;
    callbackUrl?: string;
    callbackSecret?: string;
  };
}

const CALLBACK_MAX_ATTEMPTS = 12;
const CALLBACK_LEASE_MS = 60_000;

function callbackDeliveryKey(params: AppChargeCallbackDispatchParams): string {
  return `${params.provider}:${params.providerPaymentId}:${params.chargeRequestId}:${params.status}`;
}

export function parseAppChargeCallbackDispatchParams(
  value: unknown,
): AppChargeCallbackDispatchParams {
  if (!isRecord(value)) throw new Error("App callback outbox payload is not an object");
  const required = ["appId", "chargeRequestId", "status", "provider", "providerPaymentId"];
  if (required.some((key) => typeof value[key] !== "string" || value[key] === "")) {
    throw new Error("App callback outbox payload is missing required identity fields");
  }
  if (value.status !== "paid" && value.status !== "failed") {
    throw new Error("App callback outbox status is invalid");
  }
  if (value.provider !== "stripe" && value.provider !== "oxapay") {
    throw new Error("App callback outbox provider is invalid");
  }
  const optionalStrings = ["payerUserId", "payerOrganizationId", "reason", "deliveryId"];
  if (
    optionalStrings.some(
      (key) => value[key] !== undefined && value[key] !== null && typeof value[key] !== "string",
    ) ||
    (value.amountUsd !== undefined &&
      value.amountUsd !== null &&
      typeof value.amountUsd !== "string" &&
      typeof value.amountUsd !== "number") ||
    (value.metadata !== undefined && !isRecord(value.metadata))
  ) {
    throw new Error("App callback outbox payload has invalid optional fields");
  }
  return {
    appId: value.appId as string,
    chargeRequestId: value.chargeRequestId as string,
    status: value.status,
    provider: value.provider,
    providerPaymentId: value.providerPaymentId as string,
    amountUsd: value.amountUsd as string | number | null | undefined,
    payerUserId: value.payerUserId as string | null | undefined,
    payerOrganizationId: value.payerOrganizationId as string | null | undefined,
    reason: value.reason as string | undefined,
    metadata: value.metadata as Record<string, unknown> | undefined,
    deliveryId: value.deliveryId as string | undefined,
  };
}

function parseAppChargeCallbackOutboxPayload(value: unknown): AppChargeCallbackOutboxPayload {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.target)) {
    throw new Error("App callback outbox snapshot is invalid");
  }
  const params = parseAppChargeCallbackDispatchParams(value.params);
  const envelope = value.envelope;
  const target = value.target;
  if (
    !isRecord(envelope) ||
    !isRecord(envelope.charge) ||
    !isRecord(envelope.payment) ||
    typeof target.organizationId !== "string" ||
    (target.channel !== undefined && !isRecord(target.channel)) ||
    (target.callbackUrl !== undefined && typeof target.callbackUrl !== "string") ||
    (target.callbackSecret !== undefined && typeof target.callbackSecret !== "string") ||
    envelope.event !== (params.status === "paid" ? "app_charge.paid" : "app_charge.failed") ||
    envelope.charge.id !== params.chargeRequestId ||
    envelope.charge.appId !== params.appId ||
    envelope.charge.status !== params.status ||
    envelope.payment.provider !== params.provider ||
    envelope.payment.providerPaymentId !== params.providerPaymentId
  ) {
    throw new Error("App callback outbox snapshot binding is invalid");
  }
  return {
    version: 1,
    params,
    envelope: envelope as unknown as AppChargeCallbackPayload,
    target: {
      organizationId: target.organizationId,
      channel: target.channel as AppChargeCallbackChannel | undefined,
      callbackUrl: target.callbackUrl as string | undefined,
      callbackSecret: target.callbackSecret as string | undefined,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decimalStringValue(value: unknown, fallback?: string): string {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" && typeof candidate !== "number") {
    throw new Error("App callback amount is missing");
  }
  const amount = new Decimal(candidate);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new Error("App callback amount is invalid");
  }
  return amount.toFixed();
}

function recordValue(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function callbackChannel(metadata: Record<string, unknown>): AppChargeCallbackChannel | undefined {
  const channel = recordValue(metadata, "callback_channel");
  return channel ? (channel as AppChargeCallbackChannel) : undefined;
}

function callbackMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = recordValue(metadata, "callback_metadata");
  return value ? sanitizeAppChargeMetadata(value) : undefined;
}

function roomIdFromChannel(channel: AppChargeCallbackChannel): string | undefined {
  return stringValue(channel, "roomId") ?? stringValue(channel, "room_id");
}

function agentIdFromChannel(channel: AppChargeCallbackChannel): string | undefined {
  return stringValue(channel, "agentId") ?? stringValue(channel, "agent_id");
}

function formatUsd(amount: string): string {
  return `$${new Decimal(amount).toDecimalPlaces(2).toFixed(2)}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sanitizeAppChargeMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...metadata };
  if (typeof sanitized.callback_secret === "string") {
    delete sanitized.callback_secret;
    sanitized.callback_secret_set = true;
  }
  return sanitized;
}

export async function createAppChargeCallbackSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

export function createAppChargeCallbackPayload(
  params: AppChargeCallbackDispatchParams,
  chargeMetadata: Record<string, unknown>,
  expectedAmount: string | number,
  createdAt = new Date().toISOString(),
): AppChargeCallbackPayload {
  const amount = decimalStringValue(params.amountUsd ?? expectedAmount);
  const channel = callbackChannel(chargeMetadata);
  const metadata = {
    ...callbackMetadata(chargeMetadata),
    ...sanitizeAppChargeMetadata(params.metadata ?? {}),
  };

  return {
    event: params.status === "paid" ? "app_charge.paid" : "app_charge.failed",
    createdAt,
    charge: {
      id: params.chargeRequestId,
      appId: params.appId,
      amountUsd: decimalStringValue(chargeMetadata.amount_usd, amount),
      status: params.status,
      paymentContext:
        chargeMetadata.payment_context === "any_payer" ? "any_payer" : "verified_payer",
      description: stringValue(chargeMetadata, "description"),
      paymentUrl: stringValue(chargeMetadata, "payment_url"),
    },
    payment: {
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountUsd: amount,
      payerUserId: params.payerUserId ?? undefined,
      payerOrganizationId: params.payerOrganizationId ?? undefined,
      reason: params.reason,
    },
    channel,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export class AppChargeCallbacksService {
  async failChargeAndEnqueue(params: AppChargeCallbackDispatchParams): Promise<boolean> {
    return dbWrite.transaction(async (tx) => {
      const [charge] = await tx
        .select({ status: cryptoPayments.status })
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, params.chargeRequestId))
        .for("update")
        .limit(1);
      if (!charge || charge.status === "confirmed") return false;
      await tx
        .update(cryptoPayments)
        .set({ status: "failed", updated_at: new Date() })
        .where(eq(cryptoPayments.id, params.chargeRequestId));
      await this.enqueue(params, tx);
      return true;
    });
  }

  async enqueue(
    params: AppChargeCallbackDispatchParams,
    transaction: DbTransaction,
  ): Promise<void> {
    const deliveryKey = callbackDeliveryKey(params);
    const [chargeRequest] = await transaction
      .select()
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, params.chargeRequestId))
      .for("update")
      .limit(1);
    if (!chargeRequest) throw new Error("App callback charge request not found");
    const metadata = isRecord(chargeRequest.metadata) ? chargeRequest.metadata : {};
    if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
      throw new Error("App callback charge request metadata mismatch");
    }
    const createdAt = new Date();
    const snapshot: AppChargeCallbackOutboxPayload = {
      version: 1,
      params: { ...params, deliveryId: undefined },
      envelope: createAppChargeCallbackPayload(
        params,
        metadata,
        chargeRequest.expected_amount,
        createdAt.toISOString(),
      ),
      target: {
        organizationId: chargeRequest.organization_id,
        channel: callbackChannel(metadata),
        callbackUrl: stringValue(metadata, "callback_url"),
        callbackSecret: stringValue(metadata, "callback_secret"),
      },
    };
    const digest = settlementDigest(snapshot);
    const [inserted] = await transaction
      .insert(appChargeCallbackOutbox)
      .values({
        delivery_key: deliveryKey,
        charge_request_id: params.chargeRequestId,
        payload: snapshot,
        payload_digest: digest,
        created_at: createdAt,
      })
      .onConflictDoNothing({ target: appChargeCallbackOutbox.delivery_key })
      .returning();
    if (inserted) return;

    const [existing] = await transaction
      .select()
      .from(appChargeCallbackOutbox)
      .where(eq(appChargeCallbackOutbox.delivery_key, deliveryKey))
      .limit(1);
    if (!existing) {
      throw new Error("App callback outbox replay does not match the committed delivery");
    }
    if (existing.payload_digest !== settlementDigest(existing.payload)) {
      throw new Error("App callback outbox stored payload digest is invalid");
    }
    const existingSnapshot = parseAppChargeCallbackOutboxPayload(existing.payload);
    if (settlementDigest(existingSnapshot.params) !== settlementDigest(snapshot.params)) {
      throw new Error("App callback outbox replay does not match the committed delivery");
    }
  }

  async drain(
    limit = 25,
  ): Promise<{ processed: number; delivered: number; retried: number; terminal: number }> {
    const stats = { processed: 0, delivered: 0, retried: 0, terminal: 0 };
    for (let index = 0; index < limit; index += 1) {
      const claimToken = randomUUID();
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + CALLBACK_LEASE_MS);
      const claimed = await dbWrite.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(appChargeCallbackOutbox)
          .where(
            and(
              lte(appChargeCallbackOutbox.next_attempt_at, now),
              or(
                eq(appChargeCallbackOutbox.state, "pending"),
                and(
                  eq(appChargeCallbackOutbox.state, "processing"),
                  lte(appChargeCallbackOutbox.lease_expires_at, now),
                ),
              ),
            ),
          )
          .orderBy(appChargeCallbackOutbox.next_attempt_at, appChargeCallbackOutbox.created_at)
          .for("update", { skipLocked: true })
          .limit(1);
        if (!candidate) return null;
        const [row] = await tx
          .update(appChargeCallbackOutbox)
          .set({
            state: "processing",
            claim_token: claimToken,
            lease_expires_at: leaseExpiresAt,
            attempts: candidate.attempts + 1,
            updated_at: now,
          })
          .where(eq(appChargeCallbackOutbox.id, candidate.id))
          .returning();
        return row ?? null;
      });
      if (!claimed) break;
      stats.processed += 1;
      let deliveryResult: CallbackDispatchResult | null = null;

      try {
        if (settlementDigest(claimed.payload) !== claimed.payload_digest) {
          throw new Error("App callback outbox payload digest mismatch");
        }
        const snapshot = parseAppChargeCallbackOutboxPayload(claimed.payload);
        deliveryResult = await this.dispatchSnapshot(
          {
            ...snapshot,
            params: { ...snapshot.params, deliveryId: claimed.delivery_key },
          },
          {
            skipRoom: claimed.room_delivered_at !== null,
            skipHttp: claimed.http_delivered_at !== null,
          },
        );
        if (deliveryResult.errors.length > 0) {
          throw new Error(deliveryResult.errors.join("; "));
        }
        const deliveredAt = new Date();
        await dbWrite
          .update(appChargeCallbackOutbox)
          .set({
            state: "delivered",
            room_delivered_at:
              claimed.room_delivered_at ?? (deliveryResult.roomMessageCreated ? deliveredAt : null),
            http_delivered_at:
              claimed.http_delivered_at ?? (deliveryResult.httpPosted ? deliveredAt : null),
            delivered_at: deliveredAt,
            claim_token: null,
            lease_expires_at: null,
            last_error: null,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(appChargeCallbackOutbox.id, claimed.id),
              eq(appChargeCallbackOutbox.claim_token, claimToken),
            ),
          );
        stats.delivered += 1;
      } catch (error) {
        // error-policy:J4 an expected delivery failure remains visibly pending
        // for bounded durable retry; exhausted or corrupt rows become terminal.
        const terminal = claimed.attempts >= CALLBACK_MAX_ATTEMPTS;
        const attemptAt = new Date();
        const delayMs = Math.min(3_600_000, 1_000 * 2 ** Math.min(claimed.attempts, 10));
        await dbWrite
          .update(appChargeCallbackOutbox)
          .set({
            state: terminal ? "terminal" : "pending",
            terminal_at: terminal ? new Date() : null,
            next_attempt_at: new Date(Date.now() + delayMs),
            claim_token: null,
            lease_expires_at: null,
            last_error: error instanceof Error ? error.message : String(error),
            room_delivered_at:
              claimed.room_delivered_at ?? (deliveryResult?.roomMessageCreated ? attemptAt : null),
            http_delivered_at:
              claimed.http_delivered_at ?? (deliveryResult?.httpPosted ? attemptAt : null),
            updated_at: attemptAt,
          })
          .where(
            and(
              eq(appChargeCallbackOutbox.id, claimed.id),
              eq(appChargeCallbackOutbox.claim_token, claimToken),
            ),
          );
        if (terminal) stats.terminal += 1;
        else stats.retried += 1;
      }
    }
    return stats;
  }

  async dispatch(
    params: AppChargeCallbackDispatchParams,
    options: { skipRoom?: boolean; skipHttp?: boolean } = {},
  ): Promise<CallbackDispatchResult> {
    const chargeRequest = await dbRead.query.cryptoPayments.findFirst({
      where: eq(cryptoPayments.id, params.chargeRequestId),
    });

    if (!chargeRequest) {
      logger.warn("[AppChargeCallbacks] Charge request not found", {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
      });
      return { httpPosted: false, roomMessageCreated: false, errors: [] };
    }

    const metadata = isRecord(chargeRequest.metadata) ? chargeRequest.metadata : {};
    if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
      logger.warn("[AppChargeCallbacks] Charge request metadata mismatch", {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
      });
      return { httpPosted: false, roomMessageCreated: false, errors: [] };
    }
    const snapshot: AppChargeCallbackOutboxPayload = {
      version: 1,
      params,
      envelope: createAppChargeCallbackPayload(
        params,
        metadata,
        chargeRequest.expected_amount,
        chargeRequest.created_at instanceof Date
          ? chargeRequest.created_at.toISOString()
          : new Date(0).toISOString(),
      ),
      target: {
        organizationId: chargeRequest.organization_id,
        channel: callbackChannel(metadata),
        callbackUrl: stringValue(metadata, "callback_url"),
        callbackSecret: stringValue(metadata, "callback_secret"),
      },
    };
    return this.dispatchSnapshot(snapshot, options);
  }

  private async dispatchSnapshot(
    snapshot: AppChargeCallbackOutboxPayload,
    options: { skipRoom?: boolean; skipHttp?: boolean },
  ): Promise<CallbackDispatchResult> {
    const { params, envelope: payload, target } = snapshot;
    const result: CallbackDispatchResult = {
      httpPosted: false,
      roomMessageCreated: false,
      errors: [],
    };
    const channel = target.channel;
    if (channel && !options.skipRoom) {
      try {
        result.roomMessageCreated = await this.createRoomMessage(
          payload,
          channel,
          target.organizationId,
        );
      } catch (error) {
        // error-policy:J4 durable delivery records the explicit failed room channel.
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        logger.warn("[AppChargeCallbacks] Failed to create room callback message", {
          appId: params.appId,
          chargeRequestId: params.chargeRequestId,
          error: message,
        });
      }
    }

    const callbackUrl = target.callbackUrl;
    if (callbackUrl && !options.skipHttp) {
      try {
        await this.postHttpCallback(callbackUrl, target.callbackSecret, payload, params.deliveryId);
        result.httpPosted = true;
      } catch (error) {
        // error-policy:J4 durable delivery records the explicit failed HTTP target.
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        logger.warn("[AppChargeCallbacks] Failed to post HTTP callback", {
          appId: params.appId,
          chargeRequestId: params.chargeRequestId,
          callbackUrl,
          error: message,
        });
      }
    }

    if (result.httpPosted || result.roomMessageCreated) {
      logger.info("[AppChargeCallbacks] Dispatched app charge callback", {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
        event: payload.event,
        httpPosted: result.httpPosted,
        roomMessageCreated: result.roomMessageCreated,
      });
    }

    return result;
  }

  private async postHttpCallback(
    callbackUrl: string,
    secret: string | undefined,
    payload: AppChargeCallbackPayload,
    deliveryId?: string,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Eliza-Event": payload.event,
      "X-Eliza-Timestamp": timestamp,
      "X-Eliza-Delivery": deliveryId ?? randomUUID(),
    };

    if (secret) {
      headers["X-Eliza-Signature"] = await createAppChargeCallbackSignature(
        secret,
        timestamp,
        body,
      );
    }

    // safeFetch re-resolves DNS and pins the connection (on Node) so a
    // developer-supplied callback host cannot point at private/reserved
    // addresses; every redirect hop is re-validated. A guard rejection throws
    // and is recorded as a dispatch error by the caller — the charge leg
    // itself is already settled, only the notification fails.
    const response = await safeFetch(callbackUrl, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Callback returned ${response.status}`);
    }
  }

  private async createRoomMessage(
    payload: AppChargeCallbackPayload,
    channel: AppChargeCallbackChannel,
    chargeOrganizationId: string,
  ): Promise<boolean> {
    const roomId = roomIdFromChannel(channel);
    const agentId = agentIdFromChannel(channel);
    if (!roomId || !agentId) {
      return false;
    }

    // The channel's roomId/agentId are attacker-controlled (set by the charge
    // creator). Only write into the room if it belongs to the creator's org —
    // otherwise a forged settlement message could be injected cross-tenant.
    const authorized = await callbackRoomBelongsToOrganization({
      roomId,
      agentId,
      chargeOrganizationId,
      logContext: "AppChargeCallbacks",
    });
    if (!authorized) {
      return false;
    }

    const source = stringValue(channel, "source") ?? "payment";
    const message =
      payload.event === "app_charge.paid"
        ? `Payment went through for ${formatUsd(payload.payment.amountUsd)}.`
        : `Payment did not go through for ${formatUsd(payload.payment.amountUsd)}.`;

    const memoryId = stringToUuid(
      `app-charge-callback:${payload.payment.provider}:${payload.payment.providerPaymentId}:${payload.charge.id}:${payload.charge.status}`,
    );
    const existing = await memoriesRepository.findById(memoryId);
    if (existing) {
      const metadata =
        existing.metadata && typeof existing.metadata === "object"
          ? (existing.metadata as Record<string, unknown>)
          : {};
      if (
        metadata.appChargeEvent !== payload.event ||
        metadata.appChargeId !== payload.charge.id ||
        metadata.providerPaymentId !== payload.payment.providerPaymentId
      ) {
        throw new Error("App callback deterministic room delivery identity is already bound");
      }
      return true;
    }

    await memoriesRepository.create({
      id: memoryId,
      roomId,
      entityId: agentId,
      agentId,
      type: "messages",
      content: {
        text: message,
        source: "agent",
        channelType: source,
        appChargeId: payload.charge.id,
        paymentStatus: payload.charge.status,
      },
      metadata: {
        type: MemoryType.MESSAGE,
        role: "agent",
        dialogueType: "message",
        visibility: "visible",
        appChargeEvent: payload.event,
        appChargeId: payload.charge.id,
        provider: payload.payment.provider,
        providerPaymentId: payload.payment.providerPaymentId,
        channel: sanitizeAppChargeMetadata(channel),
      } satisfies DialogueMetadata,
    });

    return true;
  }
}

export const appChargeCallbacksService = new AppChargeCallbacksService();
