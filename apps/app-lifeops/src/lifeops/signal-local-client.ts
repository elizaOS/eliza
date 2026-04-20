import { logger } from "@elizaos/core";
import type { LifeOpsSignalInboundMessage } from "@elizaos/shared/contracts/lifeops";

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

/**
 * Read env-based configuration for the signal-cli HTTP client.
 * Returns null if the required vars are absent.
 */
export function readSignalLocalClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SignalLocalClientConfig | null {
  const httpUrl = env.SIGNAL_HTTP_URL?.trim();
  const accountNumber = env.SIGNAL_ACCOUNT_NUMBER?.trim();
  if (!httpUrl || !accountNumber) return null;
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
 * Returns an empty array when:
 * - The daemon is unreachable (logged at warn, not thrown).
 * - No messages are pending.
 * - The envelope contains no user-visible text (receipts, syncs, calls).
 */
export async function readSignalInboundMessages(
  config: SignalLocalClientConfig,
  limit = DEFAULT_RECEIVE_LIMIT,
): Promise<LifeOpsSignalInboundMessage[]> {
  const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_RECEIVE_LIMIT);
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
    return [];
  }

  if (!response.ok) {
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_receive",
        statusCode: response.status,
      },
      `[lifeops] Signal local client HTTP ${response.status}`,
    );
    return [];
  }

  let body: SignalCliReceiveResponse[];
  try {
    body = (await response.json()) as SignalCliReceiveResponse[];
  } catch {
    logger.warn(
      {
        boundary: "lifeops",
        integration: "signal",
        operation: "signal_local_receive",
      },
      "[lifeops] Signal local client returned non-JSON body",
    );
    return [];
  }

  if (!Array.isArray(body)) return [];

  const messages: LifeOpsSignalInboundMessage[] = [];
  for (const item of body.slice(0, clampedLimit)) {
    const envelope = item.envelope;
    if (!envelope) continue;

    // Only surface user messages with text content.
    const dataMessage = envelope.dataMessage;
    if (!dataMessage?.message) continue;

    const senderNumber = envelope.sourceNumber ?? envelope.source ?? "";
    const speakerName = envelope.sourceName ?? senderNumber;
    const isGroup = Boolean(dataMessage.groupInfo?.groupId);
    const groupId = dataMessage.groupInfo?.groupId ?? null;
    const channelId = isGroup && groupId ? groupId : senderNumber;

    // Stable ID: timestamp + sender — signal-cli does not assign message IDs in
    // the receive response, so we derive one from the envelope timestamp.
    const timestampMs =
      typeof dataMessage.timestamp === "number"
        ? dataMessage.timestamp
        : typeof envelope.timestamp === "number"
          ? envelope.timestamp
          : Date.now();
    const id = `signal:${senderNumber}:${timestampMs}`;

    messages.push({
      id,
      roomId: channelId,
      channelId,
      speakerName,
      text: dataMessage.message,
      createdAt: timestampMs,
      isInbound: true,
      isGroup,
    });
  }

  return messages;
}
