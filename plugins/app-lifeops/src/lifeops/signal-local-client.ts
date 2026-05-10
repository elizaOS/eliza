import { randomUUID } from "node:crypto";
import type { LifeOpsSignalInboundMessage } from "@elizaos/shared";

export interface SignalLocalClientConfig {
  httpUrl: string;
  accountNumber: string;
}

const DEFAULT_SIGNAL_HTTP_URL = "http://127.0.0.1:8080";
const DEFAULT_RECEIVE_LIMIT = 25;
const MAX_RECEIVE_LIMIT = 100;

interface SignalCliEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    groupInfo?: {
      groupId?: string;
      type?: string;
    } | null;
  } | null;
}

interface SignalCliReceiveResponse {
  envelope?: SignalCliEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSignalCliReceiveResponse(
  value: unknown,
): value is SignalCliReceiveResponse {
  return isRecord(value);
}

export function readSignalLocalClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SignalLocalClientConfig | null {
  const accountNumber = env.SIGNAL_ACCOUNT_NUMBER?.trim();
  if (!accountNumber) return null;
  return {
    httpUrl: env.SIGNAL_HTTP_URL?.trim() || DEFAULT_SIGNAL_HTTP_URL,
    accountNumber,
  };
}

export async function readSignalInboundMessages(
  config: SignalLocalClientConfig,
  limit = DEFAULT_RECEIVE_LIMIT,
): Promise<LifeOpsSignalInboundMessage[]> {
  const receiveLimit = Math.min(
    Math.max(1, Math.floor(limit)),
    MAX_RECEIVE_LIMIT,
  );
  const baseUrl = config.httpUrl.replace(/\/$/, "");
  const account = encodeURIComponent(config.accountNumber);
  const response = await fetch(`${baseUrl}/v1/receive/${account}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Signal local receive failed with HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Signal local receive returned an unexpected payload");
  }

  const messages: LifeOpsSignalInboundMessage[] = [];
  for (const item of body.filter(isSignalCliReceiveResponse)) {
    if (messages.length >= receiveLimit) break;

    const envelope = item.envelope;
    const dataMessage = envelope?.dataMessage;
    const text = dataMessage?.message?.trim();
    if (!envelope || !text) continue;

    const senderNumber = envelope.sourceNumber ?? envelope.source ?? null;
    const senderUuid = envelope.sourceUuid ?? null;
    const sourceDevice =
      typeof envelope.sourceDevice === "number" ? envelope.sourceDevice : null;
    const groupId = dataMessage.groupInfo?.groupId ?? null;
    const groupType = dataMessage.groupInfo?.type ?? null;
    const isGroup = Boolean(groupId);
    const channelId = groupId ?? senderNumber ?? senderUuid;
    if (!channelId) continue;

    const speakerName =
      envelope.sourceName ?? senderNumber ?? senderUuid ?? "Signal";
    const createdAt =
      dataMessage.timestamp ?? envelope.timestamp ?? Date.now();
    const threadId = `signal:${channelId}`;

    messages.push({
      id: `${threadId}:${createdAt}:${randomUUID()}`,
      roomId: threadId,
      channelId,
      threadId,
      roomName: isGroup ? `Signal group ${channelId}` : speakerName,
      speakerName,
      senderNumber,
      senderUuid,
      sourceDevice,
      groupId,
      groupType,
      text,
      createdAt,
      isInbound: senderNumber !== config.accountNumber,
      isGroup,
    });
  }

  return messages;
}
