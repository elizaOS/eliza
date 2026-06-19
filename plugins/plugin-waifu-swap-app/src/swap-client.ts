/**
 * Swap capability client. Reaches the waifu.fun generic capability-action route
 * from inside the ElizaOS web UI canvas:
 *
 *   POST /v2/agents/:token/capabilities/pancakeswap-v3/actions/:actionSlug
 *
 * Auth precedence (matches the backend's accepted credentials, same as the
 * image-gen client):
 *   1. agent-app invoke key  -> header `x-waifu-app-invoke-key`
 *   2. Steward JWT bearer    -> header `Authorization: Bearer <jwt>`
 *
 * Two operations:
 *
 *   fetchBackendQuote()  — calls the `quote` action (read mode). The handler is
 *     not wired on the backend yet (returns 501); callers treat a thrown
 *     `not-implemented` SwapError as "use the local estimate" rather than an
 *     error surface.
 *
 *   prepareSwap()        — calls the `swap` action. STUBBED at the contract
 *     level (see SWAP_EXECUTE_ENABLED): execution is gated off until the
 *     backend handler + agent signer land, so this only ever runs when the
 *     stub is flipped on, and otherwise the view never calls it.
 */

import type { WaifuSwapRuntimeConfig } from "./swap-config";
import {
  classifySwapStatus,
  PANCAKE_V3_CAPABILITY_SLUG,
  PANCAKE_V3_QUOTE_ACTION_SLUG,
  PANCAKE_V3_SWAP_ACTION_SLUG,
  type SwapActionInput,
  type SwapError,
  type SwapPrepareResponse,
  type SwapQuoteResponse,
  type UnsignedSwapTx,
} from "./swap-contracts";

function buildAuthHeaders(config: WaifuSwapRuntimeConfig): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.appInvokeKey) {
    headers["x-waifu-app-invoke-key"] = config.appInvokeKey;
  } else if (config.stewardJwt) {
    headers.Authorization = `Bearer ${config.stewardJwt}`;
  }
  return headers;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function actionUrl(config: WaifuSwapRuntimeConfig, actionSlug: string): string {
  const token = encodeURIComponent(config.agentTokenAddress ?? "");
  return `${config.apiBase}/v2/agents/${token}/capabilities/${PANCAKE_V3_CAPABILITY_SLUG}/actions/${actionSlug}`;
}

function assertReady(config: WaifuSwapRuntimeConfig): SwapError | null {
  if (!config.agentTokenAddress) {
    return {
      kind: "misconfigured",
      status: 503,
      message: "no agent configured for swapping",
    };
  }
  if (!config.appInvokeKey && !config.stewardJwt) {
    return { kind: "auth", status: 401, message: "sign in to swap" };
  }
  return null;
}

async function postAction(
  config: WaifuSwapRuntimeConfig,
  actionSlug: string,
  input: SwapActionInput,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(actionUrl(config, actionSlug), {
      method: "POST",
      headers: buildAuthHeaders(config),
      body: JSON.stringify(input),
    });
  } catch (caught) {
    throw {
      kind: "unknown",
      status: 0,
      message:
        caught instanceof Error ? caught.message : "could not reach swap api",
    } satisfies SwapError;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw classifySwapStatus(
      response.status,
      readErrorMessage(payload, "swap request failed"),
    );
  }
  return payload;
}

export interface BackendQuoteFields {
  amountOut: number;
  minAmountOut: number | null;
  priceImpactPct: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Call the backend `quote` (read mode) action. Resolves with the parsed quote
 * fields, or rejects with a typed {@link SwapError}. A 501 surfaces as
 * `kind: "not-implemented"` so the caller can fall back to a local estimate.
 */
export async function fetchBackendQuote(
  config: WaifuSwapRuntimeConfig,
  input: SwapActionInput,
): Promise<BackendQuoteFields> {
  const notReady = assertReady(config);
  if (notReady) throw notReady;

  const payload = (await postAction(
    config,
    PANCAKE_V3_QUOTE_ACTION_SLUG,
    input,
  )) as SwapQuoteResponse;

  const amountOut = toFiniteNumber(payload?.data?.amountOut);
  if (amountOut === null) {
    throw {
      kind: "unknown",
      status: 500,
      message: "quote returned no output amount",
    } satisfies SwapError;
  }
  return {
    amountOut,
    minAmountOut: toFiniteNumber(payload?.data?.minAmountOut),
    priceImpactPct: toFiniteNumber(payload?.data?.priceImpactPct),
  };
}

/**
 * Call the backend `swap` action to obtain an UNSIGNED tx for the patron to
 * sign in their own wallet. NOTE: only reachable when the execution stub is
 * flipped on (see SWAP_EXECUTE_ENABLED / executeSwap guard). Until then the
 * view never calls this; the function exists so the wiring is ready when the
 * backend handler lands. Rejects with a typed {@link SwapError} (incl. the
 * current 501 `not-implemented`).
 */
export async function prepareSwap(
  config: WaifuSwapRuntimeConfig,
  input: SwapActionInput,
): Promise<UnsignedSwapTx> {
  const notReady = assertReady(config);
  if (notReady) throw notReady;

  const payload = (await postAction(config, PANCAKE_V3_SWAP_ACTION_SLUG, {
    ...input,
    consent: true,
  })) as SwapPrepareResponse;

  const tx = payload?.data?.tx;
  if (!tx || typeof tx.to !== "string" || typeof tx.data !== "string") {
    throw {
      kind: "unknown",
      status: 500,
      message: "swap returned no transaction to sign",
    } satisfies SwapError;
  }
  return tx;
}
