/**
 * Standard x402 **buyer → seller** payloads carried in `PAYMENT-SIGNATURE`, `X-Payment`,
 * or legacy `X-Payment` headers (often base64-wrapped JSON).
 *
 * **Why this file exists:** the agent historically verified “proof strings” (tx
 * hashes, legacy formats, facilitator payment IDs). Modern clients instead send
 * a structured **payment payload** plus expect the seller to validate it against
 * **payment requirements** through a facilitator (`POST /verify`, `POST /settle`).
 * Centralizing decode, requirement construction, and HTTP calls here keeps
 * `payment-wrapper.ts` readable and avoids duplicating facilitator contracts.
 *
 * **Why verify *and* settle:** authorization-like payloads are not settlement.
 * Unlocking paid HTTP work only after settle succeeds matches facilitator-centric
 * flows and closes the “valid signature, no transfer” gap.
 *
 * **Why URL helpers are flexible:** facilitator vendors mount `/verify` and
 * `/settle` under different prefixes; Eliza Cloud uses `/api/v1/x402/*` while
 * other stacks use a single base URL with trailing paths. Explicit override envs
 * exist so production does not depend on one hardcoded layout.
 */

import {
  atomicAmountForPriceInCents,
  getPaymentConfig,
  type PaymentConfigDefinition,
  toResourceUrl,
  toX402Network,
} from "./payment-config.js";
import type { X402Runtime } from "./types.js";

/** Decoded X-Payment body (x402-fetch / CDP-style clients). */
export type X402StandardPaymentPayload = {
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount?: string;
    maxAmountRequired?: string;
    payTo: string;
  };
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter?: string;
      validBefore: string;
      nonce: string;
    };
  };
};

export type FacilitatorPaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type StandardPaymentRequiredAccept = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type StandardPaymentRequired = {
  x402Version: 2;
  accepts: StandardPaymentRequiredAccept[];
  error?: string;
};

function looksMostlyPrintableAscii(s: string): boolean {
  if (!s || s.length > 100_000) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code < 127)
    ) {
      ok++;
    }
  }
  return ok / s.length > 0.85;
}

function tryBase64Utf8Json(raw: string): unknown | null {
  const t = raw.trim();
  if (t.length < 8 || !/^[A-Za-z0-9+/=_-]+$/.test(t.replace(/\s/g, ""))) {
    return null;
  }
  const buf = Buffer.from(t, "base64");
  if (buf.length === 0) return null;
  const decoded = buf.toString("utf8");
  if (!decoded || decoded.includes("\0")) return null;
  if (!looksMostlyPrintableAscii(decoded)) return null;
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
}

/**
 * Decode `X-Payment` / `X-PAYMENT` value: base64(JSON) first, then raw JSON.
 */
export function decodeXPaymentHeader(raw: string): unknown | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  return tryBase64Utf8Json(t);
}

export function isX402StandardPaymentPayload(
  v: unknown,
): v is X402StandardPaymentPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.x402Version !== "number") return false;
  const acc = o.accepted;
  if (typeof acc !== "object" || acc === null) return false;
  const a = acc as Record<string, unknown>;
  if (typeof a.scheme !== "string") return false;
  if (typeof a.network !== "string") return false;
  if (typeof a.asset !== "string") return false;
  if (typeof a.amount !== "string" && typeof a.maxAmountRequired !== "string") {
    return false;
  }
  if (typeof a.payTo !== "string") return false;
  const pl = o.payload;
  if (typeof pl !== "object" || pl === null) return false;
  const p = pl as Record<string, unknown>;
  if (typeof p.signature !== "string") return false;
  const auth = p.authorization;
  if (typeof auth !== "object" || auth === null) return false;
  const u = auth as Record<string, unknown>;
  return (
    typeof u.from === "string" &&
    typeof u.to === "string" &&
    typeof u.value === "string" &&
    typeof u.nonce === "string" &&
    typeof u.validBefore === "string"
  );
}

export function toStandardNetwork(
  network: PaymentConfigDefinition["network"],
): string {
  if (network === "BASE") return "eip155:8453";
  if (network === "POLYGON") return "eip155:137";
  if (network === "BSC") return "eip155:56";
  return "solana:mainnet";
}

function acceptedNetworkMatches(
  acceptedNetwork: string,
  cfg: PaymentConfigDefinition,
): boolean {
  const n = acceptedNetwork.trim();
  if (cfg.network === "SOLANA") {
    return (
      n === "solana" ||
      n === "solana:mainnet" ||
      n === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" ||
      n.toLowerCase().includes("solana")
    );
  }
  const caip = toStandardNetwork(cfg.network);
  const short = toX402Network(cfg.network);
  return n === caip || n.toLowerCase() === short || n === `caip2:${caip}`;
}

function assetMatchesAccepted(
  acceptedAsset: string,
  cfg: PaymentConfigDefinition,
): boolean {
  const a = acceptedAsset.trim().toLowerCase();
  const ref = cfg.assetReference.trim().toLowerCase();
  if (a === ref) return true;
  if (a.includes(ref)) return true;
  if (ref.includes(a) && a.startsWith("0x")) return true;
  return false;
}

export function standardAssetForConfig(cfg: PaymentConfigDefinition): string {
  if (cfg.assetNamespace === "erc20") {
    return cfg.assetReference;
  }
  return cfg.assetReference;
}

export function buildStandardPaymentRequiredAccept(params: {
  routePath: string;
  description: string;
  priceInCents: number;
  configName: string;
  agentId?: string;
}): StandardPaymentRequiredAccept {
  const cfg = getPaymentConfig(params.configName, params.agentId);
  const maxAmountRequired = atomicAmountForPriceInCents(
    params.priceInCents,
    cfg,
  );
  const extra: Record<string, unknown> = {
    name:
      cfg.symbol?.toUpperCase() === "USDC" ? "USD Coin" : cfg.symbol || "Token",
    version: "2",
    paymentConfig: params.configName,
  };
  return {
    scheme: "exact",
    network: toStandardNetwork(cfg.network),
    maxAmountRequired,
    resource: toResourceUrl(params.routePath),
    description: params.description,
    mimeType: "application/json",
    payTo: cfg.paymentAddress,
    maxTimeoutSeconds: 300,
    asset: standardAssetForConfig(cfg),
    extra,
  };
}

export function buildStandardPaymentRequired(params: {
  routePath: string;
  description: string;
  priceInCents: number;
  paymentConfigNames: string[];
  agentId?: string;
  error?: string;
}): StandardPaymentRequired {
  return {
    x402Version: 2,
    error: params.error,
    accepts: params.paymentConfigNames.map((configName) =>
      buildStandardPaymentRequiredAccept({
        routePath: params.routePath,
        description: params.description,
        priceInCents: params.priceInCents,
        configName,
        agentId: params.agentId,
      }),
    ),
  };
}

/**
 * Build facilitator `paymentRequirements` for this route/config (must match what we advertise in `accepts`).
 */
export function buildFacilitatorPaymentRequirements(params: {
  routePath: string;
  priceInCents: number;
  configName: string;
  agentId?: string;
}): FacilitatorPaymentRequirements {
  const cfg = getPaymentConfig(params.configName, params.agentId);
  const amount = atomicAmountForPriceInCents(params.priceInCents, cfg);
  const network = toStandardNetwork(cfg.network);
  return {
    scheme: "exact",
    network,
    asset: standardAssetForConfig(cfg),
    amount,
    payTo: cfg.paymentAddress,
    maxTimeoutSeconds: 300,
    extra: {
      name:
        cfg.symbol?.toUpperCase() === "USDC"
          ? "USD Coin"
          : cfg.symbol || "Token",
      version: "2",
      resource: toResourceUrl(params.routePath),
    },
  };
}

export function findMatchingPaymentConfigForStandardPayload(
  payload: X402StandardPaymentPayload,
  paymentConfigNames: string[],
  priceInCents: number,
  agentId?: string,
): { name: string; cfg: PaymentConfigDefinition } | null {
  const { accepted } = payload;
  if (accepted.scheme !== "exact" && accepted.scheme !== "upto") {
    return null;
  }
  const acceptedAmount = accepted.amount ?? accepted.maxAmountRequired;
  if (!acceptedAmount) return null;
  let payAmount: bigint;
  try {
    payAmount = BigInt(acceptedAmount);
  } catch {
    return null;
  }

  for (const name of paymentConfigNames) {
    const cfg = getPaymentConfig(name, agentId);
    if (!acceptedNetworkMatches(accepted.network, cfg)) continue;
    if (!assetMatchesAccepted(accepted.asset, cfg)) continue;
    if (
      accepted.payTo.trim().toLowerCase() !==
      cfg.paymentAddress.trim().toLowerCase()
    ) {
      continue;
    }
    const required = BigInt(atomicAmountForPriceInCents(priceInCents, cfg));
    if (payAmount < required) continue;
    return { name, cfg };
  }
  return null;
}

/**
 * Resolve facilitator HTTP endpoints without assuming one vendor’s URL layout.
 *
 * **Why the branching:** Eliza Cloud historically exposed `/api/facilitator` while
 * verify/settle live under `/api/v1/x402/*`; other deployments use a single base
 * with `/verify` and `/settle`. The logic below preserves backwards compatibility
 * and still supports plain base URLs.
 */
function getFacilitatorEndpoint(
  runtime: X402Runtime,
  endpoint: "verify" | "settle",
): string | null {
  const explicit = runtime.getSetting(
    endpoint === "verify"
      ? "X402_FACILITATOR_VERIFY_URL"
      : "X402_FACILITATOR_SETTLE_URL",
  );
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().replace(/\/$/, "");
  }
  const fuSetting = runtime.getSetting("X402_FACILITATOR_URL");
  const fu =
    typeof fuSetting === "string" && fuSetting.trim()
      ? fuSetting.trim()
      : "https://x402.elizacloud.ai/api/v1/x402";
  try {
    const clean = fu.replace(/\/$/, "");
    const u = new URL(clean);
    if (u.pathname.endsWith("/api/facilitator")) {
      return `${u.origin}/api/v1/x402/${endpoint}`;
    }
    if (u.pathname.endsWith(`/${endpoint}`)) return clean;
    return `${clean}/${endpoint}`;
  } catch {
    return null;
  }
}

export function getFacilitatorVerifyPostUrl(
  runtime: X402Runtime,
): string | null {
  return getFacilitatorEndpoint(runtime, "verify");
}

export function getFacilitatorSettlePostUrl(
  runtime: X402Runtime,
): string | null {
  return getFacilitatorEndpoint(runtime, "settle");
}

export type FacilitatorVerifyPostResult =
  | { ok: true; payer?: string }
  | { ok: false; invalidReason?: string };

export type FacilitatorSettlePostResult =
  | { ok: true; paymentResponse: string; transaction?: string; payer?: string }
  | { ok: false; invalidReason?: string };

/**
 * POST `{ paymentPayload, paymentRequirements }` to facilitator verify (Eliza Cloud–compatible).
 */
export async function verifyPaymentPayloadViaFacilitatorPost(
  runtime: X402Runtime,
  paymentPayload: X402StandardPaymentPayload,
  paymentRequirements: FacilitatorPaymentRequirements,
): Promise<FacilitatorVerifyPostResult> {
  const url = getFacilitatorVerifyPostUrl(runtime);
  if (!url) {
    return { ok: false, invalidReason: "no_facilitator_verify_url" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ElizaOS-X402-Agent/1.0",
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: { isValid?: boolean; payer?: string; invalidReason?: string } =
      {};
    if (text) {
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        return { ok: false, invalidReason: "invalid_verify_response_json" };
      }
    }
    if (!res.ok && res.status !== 400) {
      return {
        ok: false,
        invalidReason: `verify_http_${res.status}`,
      };
    }
    if (body.isValid === true) {
      return { ok: true, payer: body.payer };
    }
    return {
      ok: false,
      invalidReason: body.invalidReason ?? "verify_rejected",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, invalidReason: `verify_fetch_error:${msg}` };
  }
}

export async function settlePaymentPayloadViaFacilitatorPost(
  runtime: X402Runtime,
  paymentPayload: X402StandardPaymentPayload,
  paymentRequirements: FacilitatorPaymentRequirements,
): Promise<FacilitatorSettlePostResult> {
  const url = getFacilitatorSettlePostUrl(runtime);
  if (!url) {
    return { ok: false, invalidReason: "no_facilitator_settle_url" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ElizaOS-X402-Agent/1.0",
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, invalidReason: "invalid_settle_response_json" };
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        invalidReason:
          typeof body.errorReason === "string"
            ? body.errorReason
            : typeof body.invalidReason === "string"
              ? body.invalidReason
              : `settle_http_${res.status}`,
      };
    }

    // Must match verify semantics: do not treat bare HTTP 200 or `{}` as
    // settlement. Require explicit `success: true` or `isValid: true` (some
    // facilitators return `{ success: false }` on 200 for business errors).
    const explicitFailure = body.success === false || body.isValid === false;
    const explicitSuccess = body.success === true || body.isValid === true;
    const success = !explicitFailure && explicitSuccess;
    if (!success) {
      return {
        ok: false,
        invalidReason:
          typeof body.errorReason === "string"
            ? body.errorReason
            : typeof body.invalidReason === "string"
              ? body.invalidReason
              : `settle_http_${res.status}`,
      };
    }

    const paymentResponse = Buffer.from(JSON.stringify(body), "utf8").toString(
      "base64",
    );
    return {
      ok: true,
      paymentResponse,
      transaction:
        typeof body.transaction === "string" ? body.transaction : undefined,
      payer: typeof body.payer === "string" ? body.payer : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, invalidReason: `settle_fetch_error:${msg}` };
  }
}
