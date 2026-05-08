import type { HandlerOptions, Memory, State } from "@elizaos/core";
import {
  TOKEN_INFO_SUBACTIONS,
  type TokenInfoParams,
  type TokenInfoSubaction,
} from "./types";

const SUBACTION_ALIASES: Record<string, TokenInfoSubaction> = {
  lookup: "token",
  info: "token",
  "token-info": "token",
  token_info: "token",
  pairs: "chain-pairs",
  "new pairs": "new-pairs",
  new_pairs: "new-pairs",
  chain_pairs: "chain-pairs",
  chainpairs: "chain-pairs",
  boosted_tokens: "boosted",
  boostedtokens: "boosted",
  token_profiles: "profiles",
  tokenprofiles: "profiles",
  wallet_address: "wallet",
  "wallet-address": "wallet",
  portfolio: "wallet",
};

export function readParams(options?: unknown): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

export function readStringParam(
  options: unknown,
  ...keys: string[]
): string | undefined {
  const params = readParams(options);
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function readNumberParam(
  options: unknown,
  key: string,
  fallback?: number,
): number | undefined {
  const value = readParams(options)[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readBooleanParam(
  options: unknown,
  key: string,
): boolean | undefined {
  const value = readParams(options)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return undefined;
}

export function normalizeTokenInfoSubaction(
  value: unknown,
): TokenInfoSubaction | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if ((TOKEN_INFO_SUBACTIONS as readonly string[]).includes(normalized)) {
    return normalized as TokenInfoSubaction;
  }
  return (
    SUBACTION_ALIASES[normalized] ?? SUBACTION_ALIASES[value.toLowerCase()]
  );
}

export function inferTokenInfoSubaction(
  message: Memory,
  state?: State,
): TokenInfoSubaction {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();

  if (/\b(wallet|portfolio|holdings)\b/.test(text)) return "wallet";
  if (/\b(boosted|promoted|sponsored)\b/.test(text)) return "boosted";
  if (/\b(profile|profiles)\b/.test(text)) return "profiles";
  if (
    /\b(new|latest|fresh)\b/.test(text) &&
    /\b(pair|pairs|tokens?)\b/.test(text)
  ) {
    return "new-pairs";
  }
  if (
    /\b(pair|pairs)\b/.test(text) &&
    /\b(chain|ethereum|solana|base|bsc|polygon|arbitrum|optimism|avalanche)\b/.test(
      text,
    )
  ) {
    return "chain-pairs";
  }
  if (/\b(trending|hot|popular|gainers)\b/.test(text)) return "trending";
  if (/\b(search|find|look for)\b/.test(text)) return "search";
  return "token";
}

export function parseTokenInfoParams(
  message: Memory,
  state?: State,
  options?: HandlerOptions | Record<string, unknown>,
): TokenInfoParams {
  const raw = readParams(options);
  const content =
    typeof message.content?.text === "string" ? message.content.text : "";
  const subaction =
    normalizeTokenInfoSubaction(
      raw.subaction ?? raw.action ?? raw.operation ?? raw.kind,
    ) ?? inferTokenInfoSubaction(message, state);
  const target = readStringParam(raw, "target", "provider", "source");
  const query =
    readStringParam(raw, "query", "token", "symbol") ??
    (subaction === "search" ? content : undefined);
  const address = readStringParam(raw, "address", "tokenAddress", "wallet");
  const timeframeRaw = readStringParam(raw, "timeframe");
  const timeframe =
    timeframeRaw === "1h" || timeframeRaw === "6h" || timeframeRaw === "24h"
      ? timeframeRaw
      : undefined;
  const sortByRaw = readStringParam(raw, "sortBy", "sort");
  const sortBy =
    sortByRaw === "volume" ||
    sortByRaw === "liquidity" ||
    sortByRaw === "priceChange" ||
    sortByRaw === "txns"
      ? sortByRaw
      : undefined;
  const kindRaw = readStringParam(raw, "kind", "mode");
  const kind =
    kindRaw === "wallet-address" ||
    kindRaw === "token-address" ||
    kindRaw === "token-symbol"
      ? kindRaw
      : undefined;

  return {
    target,
    subaction,
    query,
    address,
    tokenAddress: readStringParam(raw, "tokenAddress") ?? address,
    chain: readStringParam(raw, "chain", "network"),
    timeframe,
    limit: readNumberParam(raw, "limit"),
    offset: readNumberParam(raw, "offset"),
    sortBy,
    top: readBooleanParam(raw, "top"),
    kind,
    id: readStringParam(raw, "id", "coinId"),
  };
}

export function selectedContextMatches(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}
