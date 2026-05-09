import { MemoryType } from "@elizaos/core";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { cryptoPayments } from "@/db/schemas/crypto-payments";
import type { DialogueMetadata } from "@/lib/types/message-content";
import { logger } from "@/lib/utils/logger";

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
}

export interface AppChargeCallbackPayload {
  event: "app_charge.paid" | "app_charge.failed";
  createdAt: string;
  charge: {
    id: string;
    appId: string;
    amountUsd: number;
    status: AppChargeCallbackStatus;
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

interface CallbackDispatchResult {
  httpPosted: boolean;
  roomMessageCreated: boolean;
  errors: string[];
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
        result.roomMessageCreated = await this.createRoomMessage(payload, channel);
      } catch (error) {
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
        await this.postHttpCallback(callbackUrl, stringValue(metadata, "callback_secret"), payload);
        result.httpPosted = true;
      } catch (error) {
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
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Eliza-Event": payload.event,
      "X-Eliza-Timestamp": timestamp,
      "X-Eliza-Delivery": randomUUID(),
    };

    if (secret) {
      headers["X-Eliza-Signature"] = await createAppChargeCallbackSignature(
        secret,
        timestamp,
        body,
      );
    }

    const response = await fetch(callbackUrl, {
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
  ): Promise<boolean> {
    const roomId = roomIdFromChannel(channel);
    const agentId = agentIdFromChannel(channel);
    if (!roomId || !agentId) {
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
