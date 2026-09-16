import { randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import type { RequestOptions } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { logger } from "@elizaos/logger";
import {
  redactedThrownDiagnostics,
  type WebhookEvent,
} from "../../shared/src/index.ts";

import type {
  WebhookConfig,
  WebhookDeliveryResult,
  WebhookDispatcherOptions,
} from "./types";

// Signature scheme version. v2 binds timestamp + deliveryId + event type into the HMAC.
const SIGNATURE_SCHEME = "v2";

// Canonical signed material. deliveryId and eventType are length-prefixed
// (`<len>:<value>`) so field boundaries cannot be shifted — event types and
// bodies contain '.', and a plain `.`-join would let an attacker re-split a
// captured signature (e.g. eventType "a.b"+body "c" vs "a"+body "b.c") to forge
// a colliding-but-valid message. body is last/unbounded so needs no prefix.
// Exported so receivers (verifyWebhookSignature) sign the identical material.
export function canonicalSignedPayload(
  timestamp: string,
  deliveryId: string,
  eventType: string,
  body: string,
): string {
  return `${SIGNATURE_SCHEME}:${timestamp}.${deliveryId.length}:${deliveryId}.${eventType.length}:${eventType}.${body}`;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOW_PRIVATE_WEBHOOK_NETWORKS =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.STEWARD_ALLOW_PRIVATE_WEBHOOK_NETWORKS === "true";

// Once-per-process latch for the SEC-102 escape-hatch warning below.
let warnedPrivateWebhookNetworks = false;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(
      secretBytes.byteOffset,
      secretBytes.byteOffset + secretBytes.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payloadBytes = encoder.encode(payload);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    payloadBytes.buffer.slice(
      payloadBytes.byteOffset,
      payloadBytes.byteOffset + payloadBytes.byteLength,
    ) as ArrayBuffer,
  );

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

function isNonPublicIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (a === 192 && b === 31 && octets[2] === 196) ||
    (a === 192 && b === 52 && octets[2] === 193) ||
    (a === 192 && b === 88 && octets[2] === 99) ||
    (a === 192 && b === 175 && octets[2] === 48) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(address: string): string | null {
  const normalized = address.toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];

  const hex = normalized.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function expandIpv6Words(address: string): number[] | null {
  const normalized = address.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseWords = (part: string): number[] | null => {
    if (!part) return [];
    const words = part.split(":");
    const parsed = words.map((word) => {
      if (!/^[0-9a-f]{1,4}$/.test(word)) return Number.NaN;
      return Number.parseInt(word, 16);
    });
    return parsed.some(
      (word) => !Number.isInteger(word) || word < 0 || word > 0xffff,
    )
      ? null
      : parsed;
  };

  const left = parseWords(halves[0]);
  const right = parseWords(halves[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function embeddedIpv4FromIpv6(address: string): string | null {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return null;

  const fromWords = (high: number, low: number) =>
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");

  const isNat64WellKnown =
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0;
  if (isNat64WellKnown) return fromWords(words[6], words[7]);

  const isNat64LocalUse =
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 1 &&
    words[3] === 0;
  if (isNat64LocalUse) return fromWords(words[6], words[7]);

  // RFC 8215 IPv4-translated ::ffff:0:0/96 — distinct from the IPv4-mapped form
  // (handled by mappedIpv4FromIpv6, which has words[5] === 0xffff). The IPv4 is
  // embedded in the low 32 bits and is reachable through NAT64/SIIT paths, so it
  // must face the same non-public checks (SEC-178).
  const isIpv4Translated =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0xffff &&
    words[5] === 0;
  if (isIpv4Translated) return fromWords(words[6], words[7]);

  if (words[0] === 0x2002) return fromWords(words[1], words[2]);
  return null;
}

function isNonPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const words = expandIpv6Words(normalized);
  // RFC 8215's 64:ff9b:1::/48 is explicitly a local-use translation prefix.
  // Block the whole prefix: allowing an address merely because its embedded
  // IPv4 happens to be public still lets a webhook traverse an operator-local
  // translator and defeats the public-destination boundary.
  if (words?.[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001)
    return true;
  // Deprecated IPv4-compatible ::/96 space is special-use, not a public IPv6
  // webhook destination. This also closes parser-dependent forms such as
  // `[::127.0.0.1]` / `[::7f00:1]`.
  if (
    words &&
    words.slice(0, 6).every((word) => word === 0) &&
    (words[6] !== 0 || words[7] !== 0)
  )
    return true;
  const ipv4Mapped = mappedIpv4FromIpv6(normalized);
  if (ipv4Mapped) return isNonPublicIpv4(ipv4Mapped);
  const ipv4Embedded = embeddedIpv4FromIpv6(normalized);
  if (ipv4Embedded) return isNonPublicIpv4(ipv4Embedded);
  // Public IPv4 embeddings return above. Other literals must be ordinary
  // global-unicast addresses; reserved/local/unallocated space is fail-closed.
  if (words?.[0] !== undefined && (words[0] & 0xe000) !== 0x2000) return true;
  if (words?.[0] === 0x2001 && words[1] <= 0x01ff) return true;
  if (words?.[0] === 0x2001 && words[1] === 0xdb8) return true;
  // 2001:2::/48 benchmarking (RFC 5180) — documentation/special-use, never a
  // public webhook target (SEC-178).
  if (words?.[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0)
    return true;
  // 100::/64 discard-only (RFC 6666) (SEC-178).
  if (
    words?.[0] === 0x0100 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0
  )
    return true;
  if (words?.[0] !== undefined && (words[0] & 0xffc0) === 0xfe80) return true;
  if (words?.[0] !== undefined && (words[0] & 0xffc0) === 0xfec0) return true;
  if (words?.[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000)
    return true;
  if (words?.[0] === 0x3fff && (words[1] & 0xf000) === 0) return true;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  );
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
  if (literalVersion === 4 && isNonPublicIpv4(hostname)) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }
  if (literalVersion === 6 && isNonPublicIpv6(hostname)) {
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
    (detectedFamily === 4 && isNonPublicIpv4(address)) ||
    (detectedFamily === 6 && isNonPublicIpv6(address))
  ) {
    throw new WebhookValidationError(
      "Webhook host must resolve to a public address",
    );
  }
}

function createPublicLookup(baseLookup?: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    void (async () => {
      try {
        const normalizedHostname = hostname
          .replace(/^\[|\]$/g, "")
          .toLowerCase();
        assertPublicWebhookHostname(normalizedHostname);
        if (baseLookup) {
          baseLookup(hostname, options, (error, address, family) => {
            if (error) {
              callback(error, address as never, family as never);
              return;
            }
            try {
              if (Array.isArray(address)) {
                for (const entry of address as LookupAddress[]) {
                  assertPublicAddress(entry.address, entry.family);
                }
                callback(null, address as never, family as never);
                return;
              }
              assertPublicAddress(address, family);
              callback(null, address, family);
            } catch (lookupError) {
              callback(
                lookupError as NodeJS.ErrnoException,
                "" as never,
                0 as never,
              );
            }
          });
          return;
        }
        const { lookup } = await import("node:dns/promises");
        const family =
          typeof options === "object" && options.family
            ? options.family
            : undefined;
        const addresses = await lookup(hostname, {
          all: true,
          family,
          verbatim: true,
        });
        if (addresses.length === 0)
          throw new Error("Webhook host did not resolve");
        for (const entry of addresses as LookupAddress[]) {
          assertPublicAddress(entry.address, entry.family);
        }
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      } catch (error) {
        callback(error as NodeJS.ErrnoException, "" as never, 0 as never);
      }
    })();
  };
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

  const transport =
    parsed.protocol === "https:"
      ? await import("node:https")
      : await import("node:http");
  const options: RequestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: "POST",
    headers: {
      ...init.headers,
      "Content-Length": new TextEncoder().encode(init.body).length.toString(),
    },
  };
  if (!init.allowPrivateNetwork) {
    // Node's http/https client skips `options.lookup` entirely when the URL
    // host is already an IP literal, so the guarded lookup alone never runs
    // for `http://127.0.0.1/…`-style targets (WHATWG parsing canonicalizes
    // decimal/hex/shorthand IPv4 forms to dotted-quad first). Check the
    // literal hostname up front, before any socket is opened.
    assertPublicWebhookHostname(
      parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    );
    options.lookup = createPublicLookup(init.lookup);
  } else if (init.lookup) {
    options.lookup = init.lookup;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(value);
    };
    const fail = (error: Error) => {
      finish(reject, error);
      request.destroy(error);
    };
    const request = transport.request(options, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        responseBytes +=
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk).length
            : chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          fail(new Error("Webhook response exceeded maximum size"));
        }
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        finish(resolve, { status, ok: status >= 200 && status < 300 });
      });
      response.on("error", (error) => finish(reject, error));
      response.on("aborted", () =>
        finish(reject, new Error("Webhook response aborted")),
      );
    });

    request.setTimeout(init.timeoutMs, () => {
      fail(new Error("Webhook delivery timed out"));
    });
    request.on("error", (error) => finish(reject, error));
    deadline = setTimeout(() => {
      fail(new Error("Webhook delivery timed out"));
    }, init.timeoutMs);
    request.write(init.body);
    request.end();
  });
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
      const signature = `${SIGNATURE_SCHEME}=${await signPayload(
        canonicalSignedPayload(sentAt, deliveryId, event.type, body),
        config.secret,
      )}`;

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
