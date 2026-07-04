/**
 * Per-spawn scoped model-token leases for gateway mode (#11536 E2 residual).
 *
 * E2 (#11651) points a spawned sub-agent at a model gateway and hands it the
 * ONE static `ELIZA_MODEL_GATEWAY_TOKEN` every child inherits. A single leaked
 * child env therefore holds a long-lived, unscoped token: it can spend without
 * bound and outlive the task that created it. This module replaces that static
 * token with a PER-SPAWN, TTL-bound, budget-scoped, revocable lease:
 *
 *   - minted at spawn with TTL = the task timeout, scoped to `model-invoke`;
 *   - checked against the org/agent budget BEFORE minting (credit-gate) — an
 *     out-of-budget spawn fails closed with no token at all;
 *   - revoked at task completion / failure / timeout, so a leaked child env is
 *     dead the moment its task ends.
 *
 * The broker is an INTERFACE. The reference shape is a POST to a gateway lease
 * endpoint returning `{ token, expiresAt, leaseId }` and a POST revoke endpoint
 * — any broker speaking that shape works. Config is vendor-neutral
 * (`ELIZA_MODEL_GATEWAY_*`). With no broker configured the behavior is
 * unchanged: the static gateway token is used (today's E2 behavior), fail-closed
 * ONLY under `ELIZA_MODEL_GATEWAY_STRICT=1`, which refuses to hand out a static
 * long-lived token when a broker is expected but absent.
 *
 * @module services/model-gateway-lease
 */

import { logger } from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";
import {
  type ModelGatewayConfig,
  resolveModelGatewayConfig,
} from "./model-gateway.js";
import { getSessionSpendUsd, readSpendCapUsd } from "./spend-allowance.js";
import { safeFetch } from "./ssrf-guard.js";

/** Base URL of the broker's lease mint/revoke endpoint. Presence of this key
 * (with gateway mode already on) turns per-spawn leasing on. */
export const MODEL_GATEWAY_LEASE_URL_KEY = "ELIZA_MODEL_GATEWAY_LEASE_URL";
/** Shared vendor-neutral strict flag (same name E1 uses at the model-client
 * layer). In the orchestrator it means: refuse to hand a sub-agent a static
 * long-lived gateway token — a broker lease is mandatory. */
export const MODEL_GATEWAY_STRICT_KEY = "ELIZA_MODEL_GATEWAY_STRICT";

/** A minted, scoped, short-lived model-invoke lease. */
export interface ModelGatewayLease {
  /** Bearer token the sub-agent presents to the gateway. Never logged. */
  token: string;
  /** Epoch milliseconds after which the gateway rejects the token. */
  expiresAt: number;
  /** Opaque handle used to revoke the lease. */
  leaseId: string;
}

/** Request the broker mints a lease against. */
export interface LeaseMintRequest {
  sessionId: string;
  agentType?: string;
  /** Requested TTL in ms — the broker's `expiresAt` is authoritative. */
  ttlMs: number;
  scope: "model-invoke";
  /** Per-session spend cap (USD) the lease is scoped to, when configured. */
  spendCapUsd?: number;
}

/**
 * The broker seam. `mint` returns a scoped lease; `revoke` kills it. Any
 * implementation speaking this shape (Steward is the reference broker, not a
 * dependency) satisfies the contract.
 */
export interface ModelGatewayLeaseBroker {
  mint(request: LeaseMintRequest): Promise<ModelGatewayLease>;
  revoke(leaseId: string): Promise<void>;
}

export interface LeaseCreditGateInput {
  sessionId: string;
  /** The per-session spend cap the lease would be scoped to, when configured. */
  spendCapUsd?: number;
}

/**
 * Credit-gate seam. Returns `null` to allow the mint, or a human-readable
 * refusal reason to FAIL CLOSED (no mint, spawn refused). Reuses the existing
 * per-session spend seam — it does not introduce a second budget ledger.
 */
export interface LeaseCreditGate {
  check(input: LeaseCreditGateInput): Promise<string | null> | string | null;
}

/** Parse an env truthy flag (`1`/`true`/`yes`/`on`, case-insensitive). */
export function isModelGatewayStrict(): boolean {
  const raw = readConfigEnvKey(MODEL_GATEWAY_STRICT_KEY)?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** True once the lease has reached (or passed) its expiry. */
export function isLeaseExpired(
  lease: ModelGatewayLease,
  now: number = Date.now(),
): boolean {
  return now >= lease.expiresAt;
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
    const asDate = Date.parse(value);
    return Number.isFinite(asDate) ? asDate : null;
  }
  return null;
}

/** Validate a broker mint response into a strongly-typed lease, or `null` when
 * the shape is wrong (missing token/leaseId/expiresAt). */
export function coerceLease(body: unknown): ModelGatewayLease | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const leaseId =
    typeof record.leaseId === "string" ? record.leaseId.trim() : "";
  const expiresAt = coerceEpochMs(record.expiresAt);
  if (!token || !leaseId || expiresAt === null) return null;
  return { token, leaseId, expiresAt };
}

/**
 * Reference broker over HTTP. `mint` POSTs the lease request to the configured
 * endpoint with the privileged gateway token as the bearer; `revoke` POSTs to
 * `<endpoint>/<leaseId>/revoke`. All requests go through the SSRF guard so a
 * misconfigured/hostile lease URL cannot pivot into internal infrastructure.
 */
export class HttpModelGatewayLeaseBroker implements ModelGatewayLeaseBroker {
  constructor(
    private readonly leaseUrl: string,
    private readonly authToken: string,
  ) {}

  async mint(request: LeaseMintRequest): Promise<ModelGatewayLease> {
    const res = await safeFetch(this.leaseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      // error-policy:J3 best-effort read of untrusted error body for context; failure → empty detail, error still thrown below
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `lease mint failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    // error-policy:J3 unparseable lease body → null → the explicit `if (!lease)
    // throw` below turns it into a structured "lease mint failed" failure.
    const lease = coerceLease(await res.json().catch(() => null));
    if (!lease) {
      throw new Error(
        "lease mint returned an invalid shape (expected { token, expiresAt, leaseId })",
      );
    }
    return lease;
  }

  async revoke(leaseId: string): Promise<void> {
    const base = this.leaseUrl.replace(/\/+$/, "");
    const res = await safeFetch(
      `${base}/${encodeURIComponent(leaseId)}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.authToken}` },
      },
    );
    // A 404 means the lease is already gone (expired/revoked) — the desired
    // end state, so treat it as success.
    if (!res.ok && res.status !== 404) {
      // error-policy:J3 best-effort read of untrusted error body for context; failure → empty detail, error still thrown below
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `lease revoke failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
  }
}

/**
 * Default credit-gate: reuse the existing per-session spend seam
 * (`spend-allowance`). When a spend cap is configured
 * (`ELIZA_AGENT_SPEND_CAP_USD > 0`), refuse to mint a fresh lease once the
 * session has already consumed its cap. With no cap configured the gate is a
 * no-op (unlimited), preserving today's behavior — it never invents a second
 * budget system.
 */
export function defaultSpendCapCreditGate(): LeaseCreditGate {
  return {
    check({ sessionId }) {
      const cap = readSpendCapUsd();
      if (!(cap > 0)) return null;
      const spent = getSessionSpendUsd(sessionId);
      if (spent >= cap) {
        return `session spend $${spent} has reached the cap $${cap}; refusing to mint a new model lease`;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Injectable broker + credit-gate (mirrors spend-allowance.configureSpendLedger).
// Tests inject a fake broker/gate; production resolves from env.
// ---------------------------------------------------------------------------

let injectedBroker: ModelGatewayLeaseBroker | null | undefined;
let injectedCreditGate: LeaseCreditGate | undefined;

/** Install a broker and/or credit-gate. Pass `broker: null` to force no-broker
 * mode regardless of env (tests). */
export function configureModelGatewayLease(config: {
  broker?: ModelGatewayLeaseBroker | null;
  creditGate?: LeaseCreditGate;
}): void {
  if ("broker" in config) injectedBroker = config.broker;
  if (config.creditGate) injectedCreditGate = config.creditGate;
}

/** Clear injected broker/gate (test cleanup). */
export function resetModelGatewayLease(): void {
  injectedBroker = undefined;
  injectedCreditGate = undefined;
}

/** The active broker: injected one wins; else the HTTP reference broker when a
 * lease URL is configured; else `null` (no-broker fallback). */
export function resolveLeaseBroker(
  gateway: ModelGatewayConfig,
): ModelGatewayLeaseBroker | null {
  if (injectedBroker !== undefined) return injectedBroker;
  const leaseUrl = readConfigEnvKey(MODEL_GATEWAY_LEASE_URL_KEY)?.trim();
  if (!leaseUrl) return null;
  return new HttpModelGatewayLeaseBroker(leaseUrl, gateway.token);
}

export function resolveLeaseCreditGate(): LeaseCreditGate {
  return injectedCreditGate ?? defaultSpendCapCreditGate();
}

export type LeaseOutcome =
  | { kind: "no-gateway" }
  | { kind: "static-fallback" }
  | { kind: "leased"; lease: ModelGatewayLease };

/**
 * Decide the model credential for a spawn. Fail-closed (throws) when:
 *  - strict mode is on and no broker is configured (a static long-lived token
 *    would otherwise be handed out);
 *  - the credit-gate refuses (ALWAYS fail-closed, regardless of strict — a
 *    static-token fallback would defeat the budget scope);
 *  - strict mode is on and the broker mint call fails.
 * In non-strict mode, absence of a broker or a mint failure falls back to the
 * static gateway token (unchanged E2 behavior).
 */
export async function mintSpawnLease(input: {
  sessionId: string;
  agentType?: string;
  ttlMs: number;
}): Promise<LeaseOutcome> {
  const gateway = resolveModelGatewayConfig();
  if (!gateway) return { kind: "no-gateway" };

  const strict = isModelGatewayStrict();
  const broker = resolveLeaseBroker(gateway);
  if (!broker) {
    if (strict) {
      throw new Error(
        `[model-gateway-lease] ${MODEL_GATEWAY_STRICT_KEY} is set but no lease broker is configured (${MODEL_GATEWAY_LEASE_URL_KEY} is unset); refusing to hand a static long-lived gateway token to sub-agent ${input.sessionId}`,
      );
    }
    return { kind: "static-fallback" };
  }

  const spendCapUsd = readSpendCapUsd() || undefined;
  const refusal = await resolveLeaseCreditGate().check({
    sessionId: input.sessionId,
    ...(spendCapUsd !== undefined ? { spendCapUsd } : {}),
  });
  if (refusal) {
    throw new Error(
      `[model-gateway-lease] credit-gate refused a model lease for ${input.sessionId}: ${refusal}`,
    );
  }

  try {
    const lease = await broker.mint({
      sessionId: input.sessionId,
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ttlMs: input.ttlMs,
      scope: "model-invoke",
      ...(spendCapUsd !== undefined ? { spendCapUsd } : {}),
    });
    return { kind: "leased", lease };
  } catch (err) {
    // error-policy:J4 broker mint failed → strict rethrows; non-strict warns + degrades to the documented static gateway token (unchanged E2 behavior)
    const message = err instanceof Error ? err.message : String(err);
    if (strict) {
      throw new Error(
        `[model-gateway-lease] lease mint failed for ${input.sessionId} (strict fail-closed): ${message}`,
      );
    }
    logger.warn(
      { src: "model-gateway-lease", sessionId: input.sessionId, err: message },
      "[model-gateway-lease] lease mint failed; falling back to static gateway token (non-strict)",
    );
    return { kind: "static-fallback" };
  }
}
