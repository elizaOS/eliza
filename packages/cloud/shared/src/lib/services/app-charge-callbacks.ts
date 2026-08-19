/** Coordinates app-charge callback delivery and authorized room-message projection. */
import { MemoryType } from "@elizaos/core";
import { randomUUID } from "crypto";
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
    amountUsd: number;
    status: AppChargeCallbackStatus;
    paymentContext: "verified_payer" | "any_payer";
    description?: string;
    paymentUrl?: string;
  };
  payment: {
    provider: AppChargeCallbackProvider;
    providerPaymentId: string;
    amountUsd: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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

function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
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
): AppChargeCallbackPayload {
  const amount = numberValue(params.amountUsd ?? expectedAmount);
  const channel = callbackChannel(chargeMetadata);
  const metadata = {
    ...callbackMetadata(chargeMetadata),
    ...sanitizeAppChargeMetadata(params.metadata ?? {}),
  };

  return {
    event: params.status === "paid" ? "app_charge.paid" : "app_charge.failed",
    createdAt: new Date().toISOString(),
    charge: {
      id: params.chargeRequestId,
      appId: params.appId,
      amountUsd: numberValue(chargeMetadata.amount_usd, amount),
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
  async enqueue(
    params: AppChargeCallbackDispatchParams,
    transaction: DbTransaction,
  ): Promise<void> {
    const deliveryKey = callbackDeliveryKey(params);
    const digest = settlementDigest(params);
    const [inserted] = await transaction
      .insert(appChargeCallbackOutbox)
      .values({
        delivery_key: deliveryKey,
        charge_request_id: params.chargeRequestId,
        payload: { ...params },
        payload_digest: digest,
      })
      .onConflictDoNothing({ target: appChargeCallbackOutbox.delivery_key })
      .returning();
    if (inserted) return;

    const [existing] = await transaction
      .select()
      .from(appChargeCallbackOutbox)
      .where(eq(appChargeCallbackOutbox.delivery_key, deliveryKey))
      .limit(1);
    if (!existing || existing.payload_digest !== digest) {
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

      try {
        const params = parseAppChargeCallbackDispatchParams(claimed.payload);
        if (settlementDigest(params) !== claimed.payload_digest) {
          throw new Error("App callback outbox payload digest mismatch");
        }
        const result = await this.dispatch({ ...params, deliveryId: claimed.delivery_key });
        if (result.errors.length > 0) throw new Error(result.errors.join("; "));
        await dbWrite
          .update(appChargeCallbackOutbox)
          .set({
            state: "delivered",
            delivered_at: new Date(),
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
            updated_at: new Date(),
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

  async dispatch(params: AppChargeCallbackDispatchParams): Promise<CallbackDispatchResult> {
    const result: CallbackDispatchResult = {
      httpPosted: false,
      roomMessageCreated: false,
      errors: [],
    };

    const chargeRequest = await dbRead.query.cryptoPayments.findFirst({
      where: eq(cryptoPayments.id, params.chargeRequestId),
    });

    if (!chargeRequest) {
      logger.warn("[AppChargeCallbacks] Charge request not found", {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
      });
      return result;
    }

    const metadata = isRecord(chargeRequest.metadata) ? chargeRequest.metadata : {};
    if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
      logger.warn("[AppChargeCallbacks] Charge request metadata mismatch", {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
      });
      return result;
    }

    const payload = createAppChargeCallbackPayload(params, metadata, chargeRequest.expected_amount);

    const channel = callbackChannel(metadata);
    if (channel) {
      try {
        result.roomMessageCreated = await this.createRoomMessage(
          payload,
          channel,
          chargeRequest.organization_id,
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

    const callbackUrl = stringValue(metadata, "callback_url");
    if (callbackUrl) {
      try {
        await this.postHttpCallback(
          callbackUrl,
          stringValue(metadata, "callback_secret"),
          payload,
          params.deliveryId,
        );
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

    await memoriesRepository.create({
      id: randomUUID(),
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
