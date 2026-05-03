import type { WebhookEvent } from "@stwd/shared";

import type { WebhookConfig, WebhookDeliveryResult, WebhookDispatcherOptions } from "./types";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return toHex(signature);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(statusCode?: number): boolean {
  return statusCode === undefined || statusCode >= 500;
}

function normalizeWebhook(webhook: WebhookConfig | string): WebhookConfig {
  if (typeof webhook !== "string") {
    return webhook;
  }

  const secret = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.STEWARD_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "Webhook secret is required. Pass a WebhookConfig or set STEWARD_WEBHOOK_SECRET.",
    );
  }

  return { url: webhook, secret };
}

export class WebhookDispatcher {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: WebhookDispatcherOptions = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async dispatch(
    event: WebhookEvent,
    webhook: WebhookConfig | string,
  ): Promise<WebhookDeliveryResult> {
    const config = normalizeWebhook(webhook);

    if (config.events && !config.events.includes(event.type)) {
      return {
        success: true,
        attempts: 0,
      };
    }

    const body = JSON.stringify(event);
    const signature = await signPayload(body, config.secret);

    let attempts = 0;
    let lastStatusCode: number | undefined;
    let lastError: string | undefined;

    while (attempts <= this.maxRetries) {
      attempts += 1;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const response = await fetch(config.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Steward-Event": event.type,
              "X-Steward-Signature": signature,
            },
            body,
            signal: controller.signal,
          });

          lastStatusCode = response.status;

          if (response.ok) {
            return {
              success: true,
              statusCode: response.status,
              attempts,
              deliveredAt: new Date(),
            };
          }

          lastError = `Webhook responded with status ${response.status}`;
          if (!shouldRetry(response.status) || attempts > this.maxRetries) {
            break;
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown webhook delivery error";
        if (attempts > this.maxRetries) {
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
    };
  }
}
