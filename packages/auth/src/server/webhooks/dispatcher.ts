import { randomUUID } from "node:crypto";
import { isIP, type LookupFunction } from "node:net";
import {
  createValidatedLookup,
  isPublicInternetAddress,
  logger,
} from "@elizaos/core";
import {
  canonicalSignedPayload,
  hmacSha256Hex,
  SIGNATURE_SCHEME,
} from "../../contracts/index";
import {
  redactedThrownDiagnostics,
  type WebhookEvent,
} from "../shared/index.ts";
import { fetchPinnedResponse } from "../shared/pinned-response";

import type {
  WebhookConfig,
  WebhookDeliveryResult,
  WebhookDispatcherOptions,
} from "./types";

// Signature scheme version. v2 binds timestamp + deliveryId + event type into the HMAC.

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOW_PRIVATE_WEBHOOK_NETWORKS =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS === "true";

// Once-per-process latch for the SEC-102 escape-hatch warning below.
let warnedPrivateWebhookNetworks = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(statusCode?: number): boolean {
  return statusCode === undefined || statusCode >= 500;
}

/**
 * Deterministic, non-transient rejection of a webhook delivery target (bad
 * scheme, non-public host/address). Distinct from network failures so callers
 * can classify it as non-retryable.
 */
export class WebhookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

function assertPublicWebhookHostname(hostname: string): void {
  if (!hostname)
    throw new WebhookValidationError("Webhook URL must include a host");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }

  const literalVersion = isIP(hostname);
  if (literalVersion === 4 && !isPublicInternetAddress(hostname, 4)) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }
  if (
    literalVersion === 6 &&
    !isPublicInternetAddress(hostname, 6, { allowTranslatedIpv4: true })
  ) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }
}

function assertPublicAddress(address: string, family?: number): void {
  const detectedFamily = isIP(address);
  if (
    detectedFamily === 0 ||
    (family !== undefined && family !== detectedFamily) ||
    (detectedFamily === 4 && !isPublicInternetAddress(address, 4)) ||
    (detectedFamily === 6 &&
      !isPublicInternetAddress(address, 6, { allowTranslatedIpv4: true }))
  ) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }
}

async function postWebhook(
  url: string,
  init: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    allowPrivateNetwork: boolean;
    allowInsecureHttp: boolean;
    lookup?: LookupFunction;
  },
): Promise<{ status: number; ok: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An unparseable URL can never succeed on retry (SEC-179).
    throw new WebhookValidationError("Webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebhookValidationError("Webhook URL must use https");
  }
  if (parsed.protocol === "http:" && !init.allowInsecureHttp) {
    throw new WebhookValidationError("Webhook URL must use https");
  }

  if (!init.allowPrivateNetwork) {
    // IP literals bypass lookup in Node, so screen them before opening a socket.
    assertPublicWebhookHostname(
      parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    );
  }
  const response = await fetchPinnedResponse(
    parsed,
    {
      method: "POST",
      headers: init.headers,
      body: init.body,
    },
    {
      lookup: init.allowPrivateNetwork
        ? init.lookup
        : createValidatedLookup(assertPublicAddress, init.lookup),
      timeoutMs: init.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
    },
  );
  return { status: response.status, ok: response.ok };
}

/** Fail closed on the retired bare-URL form, which cannot carry a receiver-known secret. */
function normalizeWebhook(webhook: WebhookConfig | string): WebhookConfig {
  if (typeof webhook !== "string") {
    if (typeof webhook.secret !== "string" || !webhook.secret.trim()) {
      throw new WebhookValidationError("Webhook secret must not be empty");
    }
    return webhook;
  }
  // A bare URL has no receiver-provisioned tenant secret. Server-side key
  // derivation silently produces a key the receiver cannot know, while the old
  // process-wide key lets one disclosure forge every tenant. Require the
  // persisted per-endpoint configuration instead.
  throw new WebhookValidationError(
    "Legacy string webhook configuration is not supported; pass a WebhookConfig with a per-endpoint secret",
  );
}

export class WebhookDispatcher {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowInsecureHttp: boolean;
  private readonly lookup?: LookupFunction;

  constructor(options: WebhookDispatcherOptions = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowPrivateNetwork =
      options.allowPrivateNetwork ?? ALLOW_PRIVATE_WEBHOOK_NETWORKS;
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.lookup = options.lookup;
    // SEC-102: the SSRF escape hatch disables the private-network guard for
    // every delivery this dispatcher makes (STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS
    // does it process-wide at module load). Announce it loudly once per process
    // instead of running unguarded in silence.
    if (this.allowPrivateNetwork && !warnedPrivateWebhookNetworks) {
      warnedPrivateWebhookNetworks = true;
      logger.warn(
        {
          details: [
            "[steward] WARNING: webhook SSRF guard is DISABLED (allowPrivateNetwork / STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS=true). Loopback, link-local, and private-range webhook targets will be fetched. Use only for local development or trusted test harnesses.",
          ],
        },
        "[Login:dispatcher] warn",
      );
    }
  }

  async dispatch(
    event: WebhookEvent,
    webhook: WebhookConfig | string,
  ): Promise<WebhookDeliveryResult> {
    const config = normalizeWebhook(webhook);

    // An empty events array means "subscribe to all" everywhere else
    // (acceptsConfiguredWebhookEvent, persistent-queue) — a truthy [] must
    // not silently drop every event while reporting success.
    if (config.events?.length && !config.events.includes(event.type)) {
      return {
        success: true,
        attempts: 0,
      };
    }

    // Stable delivery id is fixed here and reused across retries so a receiver
    // can dedup a retry vs. a fresh event.
    const eventWithMeta = event as WebhookEvent & {
      deliveryId?: unknown;
      signedAt?: unknown;
    };
    const deliveryId =
      typeof eventWithMeta.deliveryId === "string" &&
      eventWithMeta.deliveryId.trim()
        ? eventWithMeta.deliveryId
        : randomUUID();
    const timestamp = (
      typeof eventWithMeta.signedAt === "number" &&
      Number.isFinite(eventWithMeta.signedAt)
        ? Math.floor(eventWithMeta.signedAt)
        : Math.floor(Date.now() / 1000)
    ).toString();
    // Mutate the event so persistent-queue re-dispatch reuses the same id + timestamp.
    eventWithMeta.deliveryId = deliveryId;
    eventWithMeta.signedAt = Number(timestamp);

    const body = JSON.stringify(event);
    let attempts = 0;
    let lastStatusCode: number | undefined;
    let lastError: string | undefined;

    while (attempts <= this.maxRetries) {
      attempts += 1;

      // Sign the per-attempt freshness timestamp while keeping the delivery id
      // stable for idempotent receivers.
      const sentAt = Math.floor(Date.now() / 1000).toString();
      const signature = `${SIGNATURE_SCHEME}=${await hmacSha256Hex(config.secret, canonicalSignedPayload(sentAt, deliveryId, event.type, body))}`;

      try {
        const response = await postWebhook(config.url, {
          headers: {
            "Content-Type": "application/json",
            "X-Steward-Event": event.type,
            "X-Steward-Timestamp": sentAt,
            "X-Steward-Sent-At": sentAt,
            "X-Steward-Signature": signature,
            "X-Steward-Delivery-Id": deliveryId,
          },
          body,
          timeoutMs: this.timeoutMs,
          allowPrivateNetwork: this.allowPrivateNetwork,
          allowInsecureHttp: this.allowInsecureHttp,
          lookup: this.lookup,
        });

        lastStatusCode = response.status;

        if (response.ok) {
          return {
            success: true,
            statusCode: response.status,
            attempts,
            deliveredAt: new Date(),
            deliveryId,
          };
        }

        lastError = `Webhook responded with status ${response.status}`;
        if (!shouldRetry(response.status) || attempts > this.maxRetries) {
          break;
        }
      } catch (error) {
        lastError =
          error instanceof WebhookValidationError
            ? "Webhook validation failed"
            : "Webhook delivery failed";
        logger.warn(
          {
            details: [
              "[webhooks] delivery attempt failed",
              redactedThrownDiagnostics(error),
            ],
          },
          "[Login:dispatcher] warn",
        );
        // SEC-179: a deterministic validation rejection (bad scheme, non-public
        // host/address, unparseable URL) can never succeed on retry — stop
        // immediately instead of burning maxRetries+1 attempts with backoff and
        // repeated DNS lookups.
        if (
          error instanceof WebhookValidationError ||
          attempts > this.maxRetries
        ) {
          break;
        }
      }

      await sleep(this.retryDelayMs * 2 ** (attempts - 1));
    }

    return {
      success: false,
      statusCode: lastStatusCode,
      attempts,
      error: lastError,
      deliveryId,
    };
  }
}
