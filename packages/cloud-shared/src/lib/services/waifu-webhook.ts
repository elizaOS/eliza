/**
 * Waifu webhook emitter.
 *
 * Eliza Cloud is the metered inference and billing rail that sits under a
 * hosted waifu agent. When a hosted agent burns credits, runs low, or runs
 * out, waifu needs to react (downgrade the model tier, post last words, pause
 * the container, resurrect on top-up). Waifu exposes signed receivers for
 * these events:
 *
 *   POST /v2/webhooks/eliza-cloud/credits    (low / depleted / topped up)
 *   POST /v2/webhooks/eliza-cloud/inference  (inference.spent burn signal)
 *
 * Both receivers require an HMAC-SHA256 signature over `${timestamp}.${body}`
 * delivered in the `X-Waifu-Webhook-Signature: sha256=<hex>` header, plus a
 * stable `idempotencyKey` (or `eventId`) in the body so replays are dropped.
 *
 * Until this module existed the emit side was missing: waifu had the
 * receivers, Eliza Cloud had the credit-deduction path, but nothing actually
 * POSTed the credit signals back. This closes that seam.
 */

import { createHmac } from "node:crypto";

import { assertSafeOutboundUrl } from "../security/outbound-url";
import { logger } from "../utils/logger";

const SIGNATURE_PREFIX = "sha256=";
const DEFAULT_TIMEOUT_MS = 10_000;

export type WaifuWebhookKind = "credits" | "inference";

export interface WaifuWebhookTarget {
  /** Full receiver base, e.g. https://api.waifu.fun (no trailing path). */
  baseUrl: string;
  /** Shared HMAC secret matching waifu WEBHOOK_RECEIVER_SECRET. */
  secret: string;
}

export interface WaifuWebhookResult {
  delivered: boolean;
  status: number | null;
  skipped?: "not_configured";
  error?: string;
}

export interface EmitWaifuWebhookParams {
  kind: WaifuWebhookKind;
  /** Event body. `timestamp` and `idempotencyKey` are filled if absent. */
  payload: Record<string, unknown>;
  /** Stable id used for idempotency + replay protection. */
  idempotencyKey: string;
  /** Override the resolved target (tests / per-org routing). */
  target?: WaifuWebhookTarget;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override clock for tests. */
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Resolve the shared waifu webhook target from the environment. Returns null
 * when not configured so callers can no-op cleanly in environments that are
 * not wired to a waifu deployment (local dev, CI without secrets).
 */
export function resolveWaifuWebhookTarget(): WaifuWebhookTarget | null {
  const baseUrl = (
    process.env.WAIFU_WEBHOOK_URL ??
    process.env.WAIFU_API_BASE_URL ??
    process.env.WAIFU_CORE_URL ??
    ""
  ).trim();
  const secret = (
    process.env.WAIFU_WEBHOOK_SECRET ??
    process.env.WEBHOOK_RECEIVER_SECRET ??
    ""
  ).trim();
  if (!baseUrl || !secret) {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

/** Webhook receiver path prefix that identifies a waifu signed receiver. */
const WAIFU_WEBHOOK_PATH_PREFIX = "/v2/webhooks/";

/**
 * Resolve the receiver URL for a given event `kind`. Routing is driven BY KIND,
 * never by blindly trusting whatever path `WAIFU_WEBHOOK_URL` happens to carry.
 *
 * This is a money-path guard. The credits receiver maps unknown payloads to
 * `credits.topped_up`, so an inference event delivered to `/credits` would
 * corrupt credit state (and vice versa). We therefore:
 *
 *   - bare origin / base (no `/v2/webhooks/` segment): append the canonical
 *     `/v2/webhooks/eliza-cloud/{credits|inference}` for the requested kind.
 *   - full receiver path (contains `/v2/webhooks/`): re-derive the sibling path
 *     for the requested kind by swapping the trailing
 *     `/credits` <-> `/inference` segment, so a configured `/credits` URL with
 *     `kind: "inference"` routes to `/inference`, never `/credits`.
 *
 * Mirrors the deliberate safe derivation in
 * plugins/plugin-elizacloud/src/utils/waifu-metering.ts.
 */
function receiverPath(baseUrl: string, kind: WaifuWebhookKind): string {
  const other: WaifuWebhookKind = kind === "credits" ? "inference" : "credits";

  // Bare origin / base: build the canonical receiver path for this kind.
  if (!baseUrl.includes(WAIFU_WEBHOOK_PATH_PREFIX)) {
    return `${baseUrl}/v2/webhooks/eliza-cloud/${kind}`;
  }

  // Full receiver path: re-derive the sibling path that matches `kind` so we
  // never reuse, say, a `/credits` URL for an inference event.
  try {
    const url = new URL(baseUrl);
    const trailing = new RegExp(`/${other}(/?)$`);
    if (trailing.test(url.pathname)) {
      url.pathname = url.pathname.replace(trailing, `/${kind}$1`);
    } else if (!new RegExp(`/${kind}(/?)$`).test(url.pathname)) {
      // Path is under /v2/webhooks/ but does not end in either kind segment.
      // Normalize to the canonical eliza-cloud receiver for this kind.
      url.pathname = `/v2/webhooks/eliza-cloud/${kind}`;
    }
    return url.toString();
  } catch {
    // Non-absolute URL fallback: only swap an explicit trailing kind segment.
    const trailing = new RegExp(`/${other}(/?)$`);
    if (trailing.test(baseUrl)) {
      return baseUrl.replace(trailing, `/${kind}$1`);
    }
    if (new RegExp(`/${kind}(/?)$`).test(baseUrl)) {
      return baseUrl;
    }
    return `${baseUrl}/v2/webhooks/eliza-cloud/${kind}`;
  }
}

export function signWaifuWebhook(rawBody: string, timestamp: string, secret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/**
 * True when `candidateUrl` is a waifu signed-webhook receiver: it must share
 * the resolved target's origin AND sit under the known `/v2/webhooks/` path
 * prefix. Used to gate the signed waifu envelope so we only ever apply the
 * waifu shape (and the shared HMAC signature) to actual waifu receivers.
 *
 * Origin alone is not enough: a same-origin per-job callback URL that is not a
 * webhook receiver (for example `https://api.waifu.fun/internal/job-done`)
 * would otherwise be handed the signed waifu envelope, silently changing the
 * payload shape for that consumer. Requiring the `/v2/webhooks/` path prefix
 * keeps the signed envelope scoped to the receivers that actually verify it.
 */
export function isWaifuWebhookTargetUrl(
  candidateUrl: string | URL,
  target: WaifuWebhookTarget,
): boolean {
  try {
    const candidate = new URL(candidateUrl.toString());
    const expected = new URL(target.baseUrl);
    if (candidate.origin !== expected.origin) {
      return false;
    }
    return candidate.pathname.includes(WAIFU_WEBHOOK_PATH_PREFIX);
  } catch {
    return false;
  }
}

/**
 * POST a signed event to a waifu webhook receiver. Never throws; failures are
 * logged and returned so the caller (a billing path) is never blocked by a
 * webhook delivery problem.
 */
export async function emitWaifuWebhook(
  params: EmitWaifuWebhookParams,
): Promise<WaifuWebhookResult> {
  const target = params.target ?? resolveWaifuWebhookTarget();
  if (!target) {
    return { delivered: false, status: null, skipped: "not_configured" };
  }

  const now = (params.now ?? (() => new Date()))();
  const timestamp =
    typeof params.payload.timestamp === "string" ? params.payload.timestamp : now.toISOString();
  const body = {
    ...params.payload,
    timestamp,
    idempotencyKey: params.idempotencyKey,
    eventId: params.payload.eventId ?? params.idempotencyKey,
  };
  const rawBody = JSON.stringify(body);
  const fetchImpl = params.fetchImpl ?? fetch;

  let url: URL;
  try {
    url = await assertSafeOutboundUrl(receiverPath(target.baseUrl, params.kind));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[waifu-webhook] refusing unsafe outbound url", { error: message });
    return { delivered: false, status: null, error: message };
  }

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Waifu-Webhook-Signature": signWaifuWebhook(rawBody, timestamp, target.secret),
      },
      body: rawBody,
      signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("[waifu-webhook] delivery failed", {
        kind: params.kind,
        status: response.status,
        idempotencyKey: params.idempotencyKey,
      });
    }
    return { delivered: response.ok, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[waifu-webhook] delivery error", {
      kind: params.kind,
      idempotencyKey: params.idempotencyKey,
      error: message,
    });
    return { delivered: false, status: null, error: message };
  }
}

export type WaifuCreditStatus = "low" | "depleted";

/**
 * Pure threshold mapping shared by the credits billing path. A balance at or
 * below zero is depleted; at or below the configured low threshold (but above
 * zero) is low; anything above the threshold emits nothing. Kept pure so the
 * money-path decision is unit-testable without a database.
 */
export function classifyCreditBalance(
  newBalance: number,
  threshold: number,
): WaifuCreditStatus | null {
  if (newBalance <= 0) return "depleted";
  if (newBalance <= threshold) return "low";
  return null;
}

/**
 * Emit a credit-state transition to waifu so it can downgrade or pause a
 * hosted agent. `agentId` is the waifu agent id (carried through provisioning
 * as the cloud agent's third-party reference). The receiver resolves it back to a
 * waifu persona, so we send every id we have.
 */
export async function emitWaifuCreditWebhook(args: {
  status: WaifuCreditStatus;
  organizationId: string;
  newBalance: number;
  cloudAgentId?: string | null;
  agentId?: string | null;
  containerId?: string | null;
  threshold?: number;
  eventId?: string;
  target?: WaifuWebhookTarget;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<WaifuWebhookResult> {
  const idempotencyKey =
    args.eventId ??
    `credits:${args.organizationId}:${args.status}:${Math.floor((args.now ?? (() => new Date()))().getTime() / 60_000)}`;
  return emitWaifuWebhook({
    kind: "credits",
    idempotencyKey,
    ...(args.target ? { target: args.target } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.now ? { now: args.now } : {}),
    payload: {
      event: args.status === "depleted" ? "credits.depleted" : "credits.low",
      status: args.status,
      organizationId: args.organizationId,
      balance: args.newBalance,
      balanceUsd: args.newBalance,
      creditsRemaining: args.newBalance,
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      ...(args.cloudAgentId
        ? { elizaCloudAgentId: args.cloudAgentId, agentId: args.cloudAgentId }
        : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.containerId ? { containerId: args.containerId } : {}),
    },
  });
}

/**
 * Emit a metered inference burn signal so waifu can compute real burn rate
 * instead of the placeholder. Carries tokens + usd so the rollup is honest.
 */
export async function emitWaifuInferenceWebhook(args: {
  organizationId: string;
  usd: number;
  tokens?: number;
  model?: string;
  cloudAgentId?: string | null;
  agentId?: string | null;
  transactionId?: string;
  eventId?: string;
  target?: WaifuWebhookTarget;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<WaifuWebhookResult> {
  const idempotencyKey =
    args.eventId ?? args.transactionId ?? `inference:${args.organizationId}:${Date.now()}`;
  return emitWaifuWebhook({
    kind: "inference",
    idempotencyKey,
    ...(args.target ? { target: args.target } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.now ? { now: args.now } : {}),
    payload: {
      event: "inference.spent",
      organizationId: args.organizationId,
      usd: args.usd,
      amountUsd: args.usd,
      ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.cloudAgentId
        ? { elizaCloudAgentId: args.cloudAgentId, agentId: args.cloudAgentId }
        : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.transactionId ? { transactionId: args.transactionId } : {}),
    },
  });
}
