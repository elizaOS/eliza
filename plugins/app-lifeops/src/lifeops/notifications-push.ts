import { createIntegrationTelemetrySpan } from "@elizaos/agent";
import { logger } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export class NtfyConfigError extends Error {
  readonly code = "NTFY_NOT_CONFIGURED" as const;
  constructor(message: string) {
    super(message);
    this.name = "NtfyConfigError";
  }
}

export interface NtfyConfig {
  baseUrl: string;
  defaultTopic: string;
}

export function readNtfyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NtfyConfig {
  const baseUrl = env.NTFY_BASE_URL?.trim();
  const defaultTopic = env.NTFY_DEFAULT_TOPIC?.trim();
  if (!baseUrl) {
    throw new NtfyConfigError(
      "Ntfy push is not configured. Set NTFY_BASE_URL (and optionally NTFY_DEFAULT_TOPIC).",
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    defaultTopic: defaultTopic ?? "eliza",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Ntfy message priority. 1 = min, 3 = default, 5 = max. */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

export interface SendPushRequest {
  /** Topic to publish to. Falls back to NTFY_DEFAULT_TOPIC. */
  topic?: string;
  /** Notification title (shown as header). */
  title: string;
  /** Notification body. */
  message: string;
  /** Priority 1–5. Defaults to 3 (default). */
  priority?: NtfyPriority;
  /** Optional tags (emoji shortcuts or descriptive labels). */
  tags?: string[];
  /** URL to open when notification is clicked. */
  click?: string;
}

export interface SendPushResult {
  messageId: string | null;
  deliveredAt: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Validates and coerces priority to the 1–5 range. */
function normalizePriority(value: number | undefined): NtfyPriority {
  if (value === undefined) return 3;
  const clamped = Math.round(Math.max(1, Math.min(5, value)));
  return clamped as NtfyPriority;
}

/**
 * Publish a push notification via Ntfy.
 *
 * Throws `NtfyConfigError` when NTFY_BASE_URL is absent.
 * All other failures throw standard `Error`.
 */
export async function sendPush(
  request: SendPushRequest,
  config?: NtfyConfig,
): Promise<SendPushResult> {
  const resolvedConfig = config ?? readNtfyConfigFromEnv();
  const topic = request.topic?.trim() || resolvedConfig.defaultTopic;
  const url = `${resolvedConfig.baseUrl}/${encodeURIComponent(topic)}`;

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: request.title,
    Priority: String(normalizePriority(request.priority)),
  };
  if (request.tags && request.tags.length > 0) {
    headers.Tags = request.tags.join(",");
  }
  if (request.click) {
    headers.Click = request.click;
  }

  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation: "ntfy_publish",
    timeoutMs: 10_000,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: request.message,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        boundary: "lifeops",
        integration: "ntfy",
        err: error instanceof Error ? error : undefined,
      },
      `[lifeops-push] Ntfy publish failed: ${msg}`,
    );
    span.failure({ error, errorKind: "network_error" });
    throw new Error(`Ntfy publish failed: ${msg}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const errorMsg = body || `HTTP ${response.status}`;
    logger.warn(
      { boundary: "lifeops", integration: "ntfy", statusCode: response.status },
      `[lifeops-push] Ntfy publish HTTP error: ${errorMsg}`,
    );
    span.failure({ statusCode: response.status, errorKind: "http_error" });
    throw new Error(`Ntfy publish failed (${response.status}): ${errorMsg}`);
  }

  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    time?: number;
  };
  const messageId =
    typeof data.id === "string" && data.id.length > 0 ? data.id : null;
  const deliveredAt = data.time
    ? new Date(data.time * 1000).toISOString()
    : new Date().toISOString();

  span.success({ statusCode: response.status });
  logger.info(
    { boundary: "lifeops", integration: "ntfy", topic, messageId },
    `[lifeops-push] Push notification delivered to topic '${topic}'`,
  );

  return { messageId, deliveredAt };
}
