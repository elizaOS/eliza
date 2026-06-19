/**
 * Runtime configuration resolver for the waifu swap AppView.
 *
 * The PancakeSwap v3 swap/quote capability lives on the waifu.fun API (a
 * different origin from the ElizaOS agent server this view renders inside),
 * keyed by the agent's id/token. This module resolves, at view-mount time, in
 * priority order:
 *
 *   1. waifu API base   — where to POST the capability action
 *   2. agent token addr — which agent's capability to invoke
 *   3. auth credential  — a Steward JWT bearer OR an agent-app invoke key
 *   4. token universe   — the swap-eligible tokens to populate the selectors
 *
 * Resolution sources (first non-empty wins):
 *   - a host-injected global `window.__WAIFU_SWAP__` (the ElizaOS shell can
 *     populate this per-agent when it mounts the view)
 *   - Vite-style `import.meta.env` (VITE_WAIFU_*) baked at bundle build
 *   - a sane production default for the API base
 *
 * Nothing here imports from the waifu monorepo; the contract is the injected
 * global / env shape only. Mirrors `plugin-waifu-imagegen-app`'s config module.
 */

import type { Address, SwapToken } from "./swap-contracts";
import { PANCAKE_V3_WBNB } from "./swap-contracts";

export interface WaifuSwapRuntimeConfig {
  /** Base URL of the waifu API, e.g. "https://waifu.fun". No trailing slash. */
  apiBase: string;
  /** The agent's id/token address whose swap capability is invoked. */
  agentTokenAddress: Address | null;
  /** Steward JWT bearer, when the viewer is signed in. */
  stewardJwt: string | null;
  /**
   * Agent-app invoke key (x-waifu-app-invoke-key). Server/runtime contexts only.
   * Present when the host injects it for a trusted same-process surface.
   */
  appInvokeKey: string | null;
  /** Swap-eligible tokens for the selectors. Always includes native BNB. */
  tokens: readonly SwapToken[];
}

interface InjectedToken {
  address?: string;
  symbol?: string;
  decimals?: number;
  priceBnb?: number;
  logoUrl?: string;
  isNative?: boolean;
}

interface InjectedConfig {
  apiBase?: string;
  agentTokenAddress?: string;
  stewardJwt?: string;
  appInvokeKey?: string;
  tokens?: InjectedToken[];
}

const DEFAULT_WAIFU_API_BASE = "https://waifu.fun";

/** Native BNB, always present so the user has at least one selectable side. */
export const NATIVE_BNB_TOKEN: SwapToken = {
  address: PANCAKE_V3_WBNB,
  symbol: "BNB",
  decimals: 18,
  priceBnb: 1,
  isNative: true,
};

function readInjectedGlobal(): InjectedConfig | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as Record<string, unknown>).__WAIFU_SWAP__;
  if (!raw || typeof raw !== "object") return null;
  return raw as InjectedConfig;
}

function readEnv(key: string): string | null {
  // import.meta.env is baked at bundle build; guard for non-Vite hosts.
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isAddress(value: string | null): value is Address {
  return value !== null && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Coerce a loosely-typed injected token into a validated {@link SwapToken}. */
function normaliseToken(raw: InjectedToken): SwapToken | null {
  if (!isAddress(raw.address ?? null)) return null;
  const symbol =
    typeof raw.symbol === "string" && raw.symbol.trim()
      ? raw.symbol.trim()
      : null;
  if (!symbol) return null;
  const decimals =
    typeof raw.decimals === "number" && Number.isInteger(raw.decimals)
      ? raw.decimals
      : 18;
  const priceBnb =
    typeof raw.priceBnb === "number" && Number.isFinite(raw.priceBnb)
      ? raw.priceBnb
      : 0;
  return {
    address: raw.address as Address,
    symbol,
    decimals,
    priceBnb,
    ...(typeof raw.logoUrl === "string" && raw.logoUrl.trim()
      ? { logoUrl: raw.logoUrl.trim() }
      : {}),
    ...(raw.isNative === true ? { isNative: true } : {}),
  };
}

/** Build the token universe, guaranteeing native BNB is present exactly once. */
function resolveTokens(
  override: readonly SwapToken[] | undefined,
  injected: InjectedToken[] | undefined,
): readonly SwapToken[] {
  const fromOverride = override ?? [];
  const fromInjected = (injected ?? [])
    .map(normaliseToken)
    .filter((t): t is SwapToken => t !== null);

  const merged: SwapToken[] = [];
  const seen = new Set<string>();
  for (const token of [NATIVE_BNB_TOKEN, ...fromOverride, ...fromInjected]) {
    const key = token.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(token);
  }
  return merged;
}

/**
 * Override inputs the AppView host can pass. `agentTokenAddress` is accepted as
 * a loose string (re-validated to an {@link Address} during resolution), so the
 * shell never has to assert the 0x-literal type at the call site.
 */
export interface WaifuSwapConfigOverride {
  apiBase?: string;
  agentTokenAddress?: string;
  stewardJwt?: string;
  appInvokeKey?: string;
  tokens?: readonly SwapToken[];
}

/**
 * Resolve the live swap runtime config. The optional `override` lets the
 * AppView's host props (token address, token list) win over ambient sources
 * when the shell passes them explicitly.
 */
export function resolveWaifuSwapConfig(
  override?: WaifuSwapConfigOverride,
): WaifuSwapRuntimeConfig {
  const injected = readInjectedGlobal();

  const apiBase = stripTrailingSlash(
    firstNonEmpty(
      override?.apiBase,
      injected?.apiBase,
      readEnv("VITE_WAIFU_API_BASE"),
      DEFAULT_WAIFU_API_BASE,
    ) ?? DEFAULT_WAIFU_API_BASE,
  );

  const agentTokenRaw = firstNonEmpty(
    override?.agentTokenAddress,
    injected?.agentTokenAddress,
    readEnv("VITE_WAIFU_AGENT_TOKEN"),
  );
  const agentTokenAddress = isAddress(agentTokenRaw) ? agentTokenRaw : null;

  const stewardJwt = firstNonEmpty(
    override?.stewardJwt,
    injected?.stewardJwt,
    readEnv("VITE_WAIFU_STEWARD_JWT"),
  );

  const appInvokeKey = firstNonEmpty(
    override?.appInvokeKey,
    injected?.appInvokeKey,
  );

  return {
    apiBase,
    agentTokenAddress,
    stewardJwt,
    appInvokeKey,
    tokens: resolveTokens(override?.tokens, injected?.tokens),
  };
}
