// Deprecated LifeOps fallback shim. Canonical Signal messaging should go
// through @elizaos/plugin-signal runtime services; this direct signal-cli HTTP
// client remains for legacy owner-device receive/send fallback.
import { randomUUID } from "node:crypto";
import { logger } from "@elizaos/core";
import type { LifeOpsSignalInboundMessage } from "@elizaos/shared";

/**
 * signal-local-client.ts
 *
 * Direct HTTP reader for the signal-cli REST API.
 *
 * When `SIGNAL_HTTP_URL` is set and a Signal account is configured, this
 * client reads messages from the signal-cli daemon without requiring the full
 * `@elizaos/plugin-signal` service to be connected.  This mirrors the pattern
 * used by `telegram-local-client.ts` for Telegram.
 *
 * The signal-cli JSON-RPC HTTP server is documented at:
 * https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-rest-api.1.adoc
 *
 * Transport: GET `/v1/receive/{account}` returns an array of envelope objects.
 * The endpoint is consumed (destructive read) — messages are removed from the
 * signal-cli queue after delivery.
 *
 * Env vars:
 *   SIGNAL_HTTP_URL          Base URL of the signal-cli HTTP daemon (e.g. http://localhost:8080)
 *   SIGNAL_ACCOUNT_NUMBER    E.164 phone number of the linked account (e.g. +15551234567)
 */

export interface SignalLocalClientConfig {
  /**
   * Base URL of the signal-cli HTTP daemon.
   * Read from `SIGNAL_HTTP_URL` when not provided directly.
   */
  httpUrl: string;
  /**
   * E.164 phone number of the Signal account.
   * Read from `SIGNAL_ACCOUNT_NUMBER` when not provided directly.
   */
  accountNumber: string;
}

export interface SignalLocalSendRequest {
  recipient: string;
  text: string;
}

export class SignalLocalClientError extends Error {
  readonly status: number | null;
  readonly category: "auth" | "not_found" | "network" | "unknown";

  constructor(
    message: string,
    options: {
      status: number | null;
      category: SignalLocalClientError["category"];
    },
  ) {
    super(message);
    this.name = "SignalLocalClientError";
    this.status = options.status;
    this.category = options.category;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECEIVE_LIMIT = 100;
const DEFAULT_RECEIVE_LIMIT = 25;
const DEFAULT_SIGNAL_HTTP_URL = "http://127.0.0.1:8080";

/**
 * Read env-based configuration for the signal-cli HTTP client.
 * Returns null if the required vars are absent.
 */
export function readSignalLocalClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SignalLocalClientConfig | null {
  const httpUrl = env.SIGNAL_HTTP_URL?.trim() || DEFAULT_SIGNAL_HTTP_URL;
  const accountNumber = env.SIGNAL_ACCOUNT_NUMBER?.trim();
  if (!accountNumber) return null;
  return { httpUrl, accountNumber };
}

// ---------------------------------------------------------------------------
// signal-cli envelope shapes (subset we care about)
// ---------------------------------------------------------------------------

interface SignalCliEnvelopeDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: {
    groupId?: string;
    type?: string;
  } | null;
}

interface SignalCliEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: SignalCliEnvelopeDataMessage | null;
  syncMessage?: unknown;
  callMessage?: unknown;
  receiptMessage?: unknown;
  isUnidentifiedSender?: boolean;
}

interface SignalCliReceiveResponse {
  envelope?: SignalCliEnvelope;
  account?: string;
}

interface SignalCliRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: {
    code?: number | string;
    message?: string;
    data?: unknown;
  };
}

function isSignalCliReceiveResponse(
  value: unknown,
): value is SignalCliReceiveResponse {
  return Boolean(value && typeof value === "object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read pending inbound messages from the signal-cli HTTP daemon.
 *
 * This is a destructive read — signal-cli removes the messages from its queue
 * on delivery.  Callers are responsible for persisting returned messages before
 * calling again.
 *
 * Returns an empty array when no messages are pending or when envelopes contain
 * no user-visible text. Transport and protocol failures throw
 * `SignalLocalClientError` so callers do not confuse degraded Signal with an
 * empty inbox.
 */
export async function readSignalInboundMessages(
  config: SignalLocalClientConfig,
  limit = DEFAULT_RECEIVE_LIMIT,
): Promise<LifeOpsSignalInboundMessage[]> {
  const clampedLimit = Math.min(
    Math.max(1, Math.floor(limit)),
    MAX_RECEIVE_LIMIT,
  );
  const accountEncoded = encodeURIComponent(config.accountNumber);
  const url = `${config.httpUrl.replace(/\/$/, "")}/v1/receive/${accountEncoded}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_receive",
        httpUrl: config.httpUrl,
      },
      `[lifeops] Signal local client network failure: ${message}`,
    );
    throw new SignalLocalClientError(
      `Signal local receive failed: ${message}`,
      { status: null, category: "network" },
    );
  }

  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 404
          ? "not_found"
          : "unknown";
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_receive",
        statusCode: response.status,
      },
      `[lifeops] Signal local client HTTP ${response.status}`,
    );
    throw new SignalLocalClientError(
      `Signal local receive failed with HTTP ${response.status}`,
      { status: response.status, category },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_receive",
      },
      "[lifeops] Signal local client returned non-JSON body",
    );
    throw new SignalLocalClientError("Signal local receive returned non-JSON", {
      status: response.status,
      category: "unknown",
    });
  }

  if (!Array.isArray(body)) {
    throw new SignalLocalClientError(
      "Signal local receive returned an unexpected payload",
      { status: response.status, category: "unknown" },
    );
  }

  const messages: LifeOpsSignalInboundMessage[] = [];
  for (const item of body
    .filter(isSignalCliReceiveResponse)
    .slice(0, clampedLimit)) {
    const envelope = item.envelope;
    if (!envelope) continue;

    // Only surface user messages with text content.
    const dataMessage = envelope.dataMessage;
    if (!dataMessage?.message) continue;

    const senderNumber = envelope.sourceNumber ?? envelope.source ?? null;
    const senderUuid = envelope.sourceUuid ?? null;
    const speakerName =
      envelope.sourceName ?? senderNumber ?? "Unknown Signal sender";
    const isGroup = Boolean(dataMessage.groupInfo?.groupId);
    const groupId = dataMessage.groupInfo?.groupId ?? null;
    const groupType = dataMessage.groupInfo?.type ?? null;
    const channelId =
      isGroup && groupId ? groupId : (senderNumber ?? senderUuid ?? "");
    if (!channelId) continue;
    const senderKey = senderNumber ?? senderUuid ?? channelId;
    const roomName =
      isGroup && groupId ? `Signal group ${groupId}` : speakerName;

    // Stable ID: timestamp + sender — signal-cli does not assign message IDs in
    // the receive response, so we derive one from the envelope timestamp.
    const timestampMs =
      typeof dataMessage.timestamp === "number"
        ? dataMessage.timestamp
        : typeof envelope.timestamp === "number"
          ? envelope.timestamp
          : Date.now();
    const id = `signal:${senderKey}:${timestampMs}`;

    messages.push({
      id,
      roomId: channelId,
      channelId,
      threadId: channelId,
      roomName,
      speakerName,
      senderNumber,
      senderUuid,
      sourceDevice:
        typeof envelope.sourceDevice === "number"
          ? envelope.sourceDevice
          : null,
      groupId,
      groupType,
      text: dataMessage.message,
      createdAt: timestampMs,
      isInbound: true,
      isGroup,
    });
  }

  return messages;
}

export async function sendSignalLocalMessage(
  config: SignalLocalClientConfig,
  request: SignalLocalSendRequest,
): Promise<{ timestamp: number }> {
  const url = `${config.httpUrl.replace(/\/$/, "")}/api/v1/rpc`;
  const rpcId = randomUUID();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId,
        method: "send",
        params: {
          account: config.accountNumber,
          recipients: [request.recipient],
          message: request.text,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_send",
        httpUrl: config.httpUrl,
      },
      `[lifeops] Signal local client send network failure: ${message}`,
    );
    throw new SignalLocalClientError(`Signal local send failed: ${message}`, {
      status: null,
      category: "network",
    });
  }

  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 404
          ? "not_found"
          : "unknown";
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_send",
        statusCode: response.status,
      },
      `[lifeops] Signal local client send HTTP ${response.status}`,
    );
    throw new SignalLocalClientError(
      `Signal local send failed with HTTP ${response.status}`,
      { status: response.status, category },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_send",
      },
      "[lifeops] Signal local client send returned non-JSON body",
    );
    throw new SignalLocalClientError("Signal local send returned non-JSON", {
      status: response.status,
      category: "unknown",
    });
  }

  const rpcResponse = body as SignalCliRpcResponse<unknown>;
  if (isRecord(rpcResponse.error)) {
    const message =
      typeof rpcResponse.error.message === "string"
        ? rpcResponse.error.message
        : "Signal RPC send failed";
    throw new SignalLocalClientError(`Signal local send failed: ${message}`, {
      status: response.status,
      category: "unknown",
    });
  }

  const result = rpcResponse.result;
  if (!isRecord(result) || typeof result.timestamp !== "number") {
    throw new SignalLocalClientError(
      "Signal local send did not return a timestamp",
      { status: response.status, category: "unknown" },
    );
  }

  return { timestamp: result.timestamp };
}
