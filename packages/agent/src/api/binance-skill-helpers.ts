/**
 * Binance direct-skill request helpers.
 *
 * Extracted from server.ts. Handles direct dispatch of Binance DeFi skills
 * (meme-rush, trading-signal, token-info, etc.) and fallback action parsing.
 */

import {
  type Action,
  type ActionParameters,
  type AgentRuntime,
  type Content,
  type createMessageMemory,
  ModelType,
} from "@elizaos/core";
import { extractCompatTextContent } from "./compat-utils.js";

const EXPOSED_BINANCE_SKILL_IDS = new Set([
  "binance-crypto-market-rank",
  "binance-meme-rush",
  "binance-query-address-info",
  "binance-query-token-audit",
  "binance-query-token-info",
  "binance-trading-signal",
]);

function shouldExposeBinanceSkillId(skillId: string): boolean {
  const normalized = skillId.trim();
  if (!normalized.startsWith("binance-")) return true;
  return EXPOSED_BINANCE_SKILL_IDS.has(normalized);
}

export type FallbackParsedAction = {
  name: string;
  parameters?: ActionParameters;
};

type RuntimeActionLike = Pick<
  Action,
  "name" | "similes" | "validate" | "handler"
>;

const LIFEOPS_PUBLIC_MODULE: string = "@elizaos/app-lifeops/public";

let ownerWebsiteBlockFallbackPromise: Promise<RuntimeActionLike | null> | null =
  null;

async function resolveBuiltInFallbackAction(
  actionName: string,
): Promise<RuntimeActionLike | null> {
  if (actionName !== "OWNER_WEBSITE_BLOCK") {
    return null;
  }

  if (!ownerWebsiteBlockFallbackPromise) {
    ownerWebsiteBlockFallbackPromise = import(
      /* @vite-ignore */ LIFEOPS_PUBLIC_MODULE
    )
      .then((mod) => mod as Record<string, RuntimeActionLike | undefined>)
      .then((mod) => mod.ownerWebsiteBlockAction ?? null)
      .catch(() => null);
  }

  return ownerWebsiteBlockFallbackPromise;
}

export function inferBalanceChainFromText(
  input: string,
): "all" | "solana" | "bsc" | "base" | "ethereum" {
  const normalized = input.toLowerCase();
  if (/\bsol(?:ana)?\b/.test(normalized)) return "solana";
  if (/\b(bsc|bnb|binance)\b/.test(normalized)) return "bsc";
  if (/\bbase\b/.test(normalized)) return "base";
  if (/\b(eth|ethereum)\b/.test(normalized)) return "ethereum";
  return "all";
}

export function shouldForceCheckBalanceFallback(
  parsedActions: FallbackParsedAction[],
  userText: string,
  responseText: string,
): boolean {
  const nonReplyActions = parsedActions.filter(
    (a) => a.name !== "REPLY" && a.name !== "NONE" && a.name !== "IGNORE",
  );
  if (nonReplyActions.length > 0) return false;

  const combined = `${userText}\n${responseText}`.toLowerCase();
  const balanceIntent =
    /\b(balance|wallet|holdings|portfolio|funds|how much)\b/.test(combined) ||
    /\b(check(ing)?|look(ing)? up|fetch(ing)?)\b/.test(combined);
  return balanceIntent;
}

export function isBalanceIntent(input: string): boolean {
  const normalized = input.toLowerCase();
  return /\b(balance|wallet|holdings|portfolio|funds|how much)\b/.test(
    normalized,
  );
}

export function parseFallbackActionBlocks(
  value: unknown,
  _responseText?: string,
): FallbackParsedAction[] {
  const rawValues: string[] = [];
  if (typeof value === "string") {
    rawValues.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        rawValues.push(entry);
      }
    }
  }

  const parsed: FallbackParsedAction[] = [];
  for (const raw of rawValues) {
    const normalized = raw.trim().toUpperCase();
    if (/^[A-Z0-9_]+$/.test(normalized)) {
      parsed.push({ name: normalized, parameters: {} });
    }
  }

  return parsed;
}

export async function executeFallbackParsedActions(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  parsedActions: FallbackParsedAction[],
  appendIncomingText: (incoming: string) => void,
  onActionCallback: (actionTag: string, hasText: boolean) => void,
  options?: {
    getCurrentText?: () => string;
    onCallbackText?: (incoming: string) => void;
  },
): Promise<void> {
  const runtimeActions = Array.isArray(
    (runtime as { actions?: unknown[] }).actions,
  )
    ? ((runtime as { actions: unknown[] }).actions as RuntimeActionLike[])
    : [];

  const lookup = new Map<string, RuntimeActionLike>();
  for (const action of runtimeActions) {
    if (typeof action.name === "string")
      lookup.set(action.name.toUpperCase(), action);
    if (!Array.isArray(action.similes)) continue;
    for (const alias of action.similes) {
      if (typeof alias === "string") lookup.set(alias.toUpperCase(), action);
    }
  }

  for (const parsed of parsedActions) {
    if (
      parsed.name === "REPLY" ||
      parsed.name === "NONE" ||
      parsed.name === "IGNORE"
    ) {
      continue;
    }
    // Prefer the built-in self-control actions for fallback execution.
    // The runtime-registered wrappers can gate these too aggressively during
    // early web-chat ownership bootstrap, while the built-in actions still
    // enforce the actual self-control OWNER/ADMIN check.
    const action =
      (await resolveBuiltInFallbackAction(parsed.name)) ??
      lookup.get(parsed.name);
    if (!action || typeof action.handler !== "function") continue;

    if (typeof action.validate === "function") {
      const valid = await Promise.resolve(
        action.validate(runtime, message, undefined),
      );
      if (!valid) continue;
    }

    let callbackSeen = false;
    const actionResult = await Promise.resolve(
      action.handler(
        runtime,
        message,
        undefined,
        { parameters: parsed.parameters ?? {} },
        async (content: unknown) => {
          const contentRecord =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const actionTag =
            typeof contentRecord.action === "string"
              ? contentRecord.action
              : parsed.name;
          const chunk =
            contentRecord && typeof contentRecord === "object"
              ? extractCompatTextContent(contentRecord as Content)
              : "";
          callbackSeen = true;
          onActionCallback(actionTag, Boolean(chunk));
          if (chunk) {
            (options?.onCallbackText ?? appendIncomingText)(chunk);
          }
          return [];
        },
        [],
      ),
    );
    if (!callbackSeen) {
      const currentText = options?.getCurrentText?.() ?? "";
      const actionSucceeded =
        actionResult &&
        typeof actionResult === "object" &&
        "success" in actionResult
          ? actionResult.success === true
          : undefined;
      const fallbackText =
        actionResult && typeof actionResult === "object"
          ? typeof actionResult.text === "string"
            ? actionResult.text
            : ""
          : "";
      const currentTextLooksLikeCompletedWebsiteBlock =
        /\b(started|starting|blocked|blocking now|website block is active|block is active)\b/i.test(
          currentText,
        );
      const shouldSuppressSuccessFallbackText =
        parsed.name === "OWNER_WEBSITE_BLOCK" &&
        actionSucceeded === true &&
        currentTextLooksLikeCompletedWebsiteBlock;
      if (fallbackText) {
        onActionCallback(parsed.name, !shouldSuppressSuccessFallbackText);
        if (!shouldSuppressSuccessFallbackText) {
          appendIncomingText(
            currentText.trim().length > 0
              ? `\n\n${fallbackText}`
              : fallbackText,
          );
        }
      }
    }
  }
}

/**
 * Keyword-to-slug mapping for implicit Binance skill dispatch.
 * Users don't need to type "binance-meme-rush" — natural language triggers work.
 * Order matters: first match wins, so more specific patterns go first.
 */
const BINANCE_SKILL_KEYWORD_MAP: Array<{
  pattern: RegExp;
  slug: string;
}> = [
  // meme-rush: meme tokens, pump.fun, bonding curve, launchpad tokens
  {
    pattern:
      /\b(?:meme\s*(?:token|coin|rush)?|pump\.?fun|four\.?meme|bonding\s*curve|launchpad\s*token|new\s*(?:token|coin)s?\s*on|trending\s*(?:token|coin))/i,
    slug: "binance-meme-rush",
  },
  // trading-signal: smart money signals, whale signals
  {
    pattern:
      /\b(?:(?:trading|smart\s*money|whale)\s*signal|signal\s*(?:list|data))/i,
    slug: "binance-trading-signal",
  },
  // crypto-market-rank: market rankings, trending, alpha, leaderboard
  {
    pattern:
      /\b(?:(?:market|crypto)\s*rank|leader\s*board|top\s*(?:trader|search|token)|alpha\s*(?:token|rank)|smart\s*money\s*(?:rank|inflow))/i,
    slug: "binance-crypto-market-rank",
  },
  // query-token-audit: token/contract audit, rug check, security scan
  {
    pattern:
      /\b(?:(?:token|contract)\s*audit|audit\s*(?:this\s*)?(?:token|contract)|(?:rug|security|safety)\s*(?:check|scan)|check\s*(?:this\s*)?contract)/i,
    slug: "binance-query-token-audit",
  },
  // query-token-info: token info, token price, token detail, search token
  {
    pattern:
      /\b(?:(?:token|coin)\s*(?:info|detail|price|data|search)|search\s*(?:token|coin)|look\s*up\s*(?:token|coin))/i,
    slug: "binance-query-token-info",
  },
  // query-address-info: wallet balance, address info, check wallet
  {
    pattern:
      /\b(?:(?:wallet|address)\s*(?:balance|info|detail|holding)|check\s*(?:this\s*)?(?:wallet|address)|(?:wallet|address)\s*check)/i,
    slug: "binance-query-address-info",
  },
];

function extractDirectBinanceSkillSlug(userText: string): string | null {
  const normalized = userText.toLowerCase();

  // 1. Explicit slug mention: "use binance-meme-rush ..."
  const skillMatch = normalized.match(/\b(binance-[a-z0-9-]+)\b/);
  if (skillMatch) {
    // Still require an action verb for explicit slugs to avoid false positives
    if (/\b(use|run|show|fetch|pull|get)\b/.test(normalized)) {
      return skillMatch[1];
    }
  }

  // 2. Implicit keyword matching: "show me trending meme tokens on BSC"
  for (const { pattern, slug } of BINANCE_SKILL_KEYWORD_MAP) {
    if (pattern.test(normalized)) {
      return slug;
    }
  }

  return null;
}

function pickDirectBinanceLimit(
  userText: string,
  fallback: number,
  max: number,
): string {
  const matches = userText.match(/\b([1-9]\d{0,2})\b/g);
  if (!matches) return String(fallback);
  for (const raw of matches) {
    const value = Number(raw);
    if (value >= 1 && value <= max) {
      return String(value);
    }
  }
  return String(fallback);
}

function extractExplicitDirectBinanceCount(
  userText: string,
  max: number,
): number | null {
  const matches = userText.match(/\b([1-9]\d{0,2})\b/g);
  if (!matches) return null;
  for (const raw of matches) {
    const value = Number(raw);
    if (value >= 1 && value <= max) {
      return value;
    }
  }
  return null;
}

function pickDirectBinanceChain(
  userText: string,
  allowed: string[],
  fallback: string,
): string {
  const normalized = userText.toLowerCase();
  const candidates: Array<[string, RegExp]> = [
    ["solana", /\bsolana\b|\bsol\b|pump\.fun/],
    ["bsc", /\bbsc\b|\bbnb\b|four\.meme/],
    ["base", /\bbase\b/],
    ["eth", /\beth\b|\bethereum\b/],
  ];
  for (const [chain, pattern] of candidates) {
    if (allowed.includes(chain) && pattern.test(normalized)) {
      return chain;
    }
  }
  return fallback;
}

function resolveDirectBinanceMemeRushCommand(userText: string): {
  script: string;
  args: string[];
} {
  const normalized = userText.toLowerCase();
  const chain = pickDirectBinanceChain(normalized, ["solana", "bsc"], "solana");
  if (
    /topic|topics|narrative|narratives|social rush|hot topic|hot topics/.test(
      normalized,
    )
  ) {
    const type = /rising|inflow/.test(normalized) ? "rising" : "latest";
    const sort = /inflow/.test(normalized) ? "inflow" : "time";
    const explicitCount = extractExplicitDirectBinanceCount(normalized, 50);
    return {
      script: "fetch-topics.sh",
      args: explicitCount
        ? [chain, type, sort, String(explicitCount)]
        : [chain, type, sort],
    };
  }
  const stage = /migrat/.test(normalized)
    ? "migrated"
    : /finaliz|about to migrate/.test(normalized)
      ? "finalizing"
      : "new";
  const limit = pickDirectBinanceLimit(normalized, 20, 200);
  return { script: "fetch-trending.sh", args: [chain, stage, limit] };
}

type DirectBinanceScriptResolution =
  | {
      kind: "run";
      script: string;
      args: string[];
    }
  | {
      kind: "ask";
      text: string;
    };

function extractQuotedUserText(userText: string): string | null {
  const quotedMatch = userText.match(/["'`“”]([^"'`“”]{2,120})["'`“”]/);
  return quotedMatch?.[1]?.trim() || null;
}

function extractFirstEvmAddress(userText: string): string | null {
  return userText.match(/\b0x[a-fA-F0-9]{40}\b/)?.[0] ?? null;
}

function extractFirstSolanaAddress(userText: string): string | null {
  const candidates = userText.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [];
  for (const candidate of candidates) {
    if (
      candidate.toLowerCase().startsWith("binance") ||
      candidate.toLowerCase().startsWith("signal")
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

function extractDirectBinanceSearchKeyword(userText: string): string | null {
  const quoted = extractQuotedUserText(userText);
  if (quoted) return quoted;

  const safeText =
    userText.length > 10_000 ? userText.slice(0, 10_000) : userText;

  const patterns = [
    /\bsearch(?: for)?\s+(.+?)(?:\s+on\s+(?:bsc|bnb|solana|sol|base|eth|ethereum)\b|$)/i,
    /\bfind\s+(.+?)(?:\s+on\s+(?:bsc|bnb|solana|sol|base|eth|ethereum)\b|$)/i,
    /\blook up\s+(.+?)(?:\s+on\s+(?:bsc|bnb|solana|sol|base|eth|ethereum)\b|$)/i,
    /\bfor\s+(.+?)(?:\s+on\s+(?:bsc|bnb|solana|sol|base|eth|ethereum)\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = safeText.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/\s+/g, " ").trim();
  }

  const cleaned = safeText
    .replace(/\b(binance-[a-z0-9-]+)\b/gi, " ")
    .replace(
      /\b(use|run|show|tell|give|fetch|pull|get|search|find|lookup|look up|query|token|info|market|data|detail|details|price|please|me|and)\b/gi,
      " ",
    )
    .replace(/\b(on|in)\s+(bsc|bnb|solana|sol|base|eth|ethereum)\b/gi, " ")
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, " ")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function extractDirectBinanceAddressTarget(userText: string): {
  address: string;
  chain: string | null;
} | null {
  const solanaAddress = extractFirstSolanaAddress(userText);
  if (solanaAddress) {
    return {
      address: solanaAddress,
      chain: "solana",
    };
  }

  const evmAddress = extractFirstEvmAddress(userText);
  if (!evmAddress) return null;

  const chain = pickDirectBinanceChain(userText, ["bsc", "base", "eth"], "");
  return {
    address: evmAddress,
    chain: chain || null,
  };
}

function resolveDirectBinanceTradingSignalCommand(
  userText: string,
): DirectBinanceScriptResolution {
  const chain = pickDirectBinanceChain(userText, ["solana", "bsc"], "solana");
  const limit = pickDirectBinanceLimit(userText, 20, 100);
  return {
    kind: "run",
    script: "signals.sh",
    args: [chain, limit],
  };
}

function resolveDirectBinanceCryptoMarketRankCommand(
  userText: string,
): DirectBinanceScriptResolution {
  const normalized = userText.toLowerCase();
  let type = "trending";
  if (/smart money|inflow/.test(normalized)) type = "smart-money";
  else if (/trader|leaderboard|pnl|kol/.test(normalized)) type = "traders";
  else if (/top search|searched|search ranking/.test(normalized))
    type = "top-search";
  else if (/\balpha\b/.test(normalized)) type = "alpha";
  else if (/stock|tokenized/.test(normalized)) type = "stock";
  else if (/meme/.test(normalized)) type = "meme";

  const chain = pickDirectBinanceChain(
    userText,
    ["solana", "bsc", "base", "eth"],
    "",
  );
  const limit = pickDirectBinanceLimit(userText, 20, 200);

  return {
    kind: "run",
    script: "rankings.sh",
    args: [type, chain || "all", limit],
  };
}

function resolveDirectBinanceTokenInfoCommand(
  userText: string,
): DirectBinanceScriptResolution {
  const chain = pickDirectBinanceChain(
    userText,
    ["solana", "bsc", "base", "eth"],
    "",
  );
  const target = extractDirectBinanceAddressTarget(userText);
  if (target?.address) {
    const targetChain = target.chain ?? (chain || null);
    if (targetChain) {
      return {
        kind: "run",
        script: "token-detail.sh",
        args: [target.address, targetChain],
      };
    }
    return {
      kind: "run",
      script: "search.sh",
      args: [target.address],
    };
  }

  const keyword = extractDirectBinanceSearchKeyword(userText);
  if (!keyword) {
    return {
      kind: "ask",
      text: "Please provide a token keyword, symbol, or contract address for binance-query-token-info.",
    };
  }
  return {
    kind: "run",
    script: "search.sh",
    args: chain ? [keyword, chain] : [keyword],
  };
}

function resolveDirectBinanceTokenAuditCommand(
  userText: string,
): DirectBinanceScriptResolution {
  const target = extractDirectBinanceAddressTarget(userText);
  if (!target?.address) {
    return {
      kind: "ask",
      text: "Please provide a token contract address for binance-query-token-audit.",
    };
  }
  if (!target.chain) {
    return {
      kind: "ask",
      text: "Please specify the chain for that contract address: BSC, Base, Ethereum, or Solana.",
    };
  }
  return {
    kind: "run",
    script: "audit.sh",
    args: [target.address, target.chain],
  };
}

function resolveDirectBinanceAddressInfoCommand(
  userText: string,
): DirectBinanceScriptResolution {
  const target = extractDirectBinanceAddressTarget(userText);
  if (!target?.address) {
    return {
      kind: "ask",
      text: "Please provide a wallet address for binance-query-address-info.",
    };
  }
  if (!target.chain) {
    return {
      kind: "ask",
      text: "Please specify the chain for that wallet address: BSC, Base, Ethereum, or Solana.",
    };
  }
  return {
    kind: "run",
    script: "balances.sh",
    args: [target.address, target.chain],
  };
}

function resolveDirectBinanceScriptCommand(
  skillSlug: string,
  userText: string,
): DirectBinanceScriptResolution | null {
  switch (skillSlug) {
    case "binance-meme-rush":
      return {
        kind: "run",
        ...resolveDirectBinanceMemeRushCommand(userText),
      };
    case "binance-trading-signal":
      return resolveDirectBinanceTradingSignalCommand(userText);
    case "binance-crypto-market-rank":
      return resolveDirectBinanceCryptoMarketRankCommand(userText);
    case "binance-query-token-info":
      return resolveDirectBinanceTokenInfoCommand(userText);
    case "binance-query-token-audit":
      return resolveDirectBinanceTokenAuditCommand(userText);
    case "binance-query-address-info":
      return resolveDirectBinanceAddressInfoCommand(userText);
    default:
      return null;
  }
}

const DIRECT_BINANCE_SUMMARY_INPUT_MAX_CHARS = 12_000;
const DIRECT_BINANCE_SUMMARY_DEFAULT_ITEMS = 5;
const DIRECT_BINANCE_SUMMARY_MAX_DEPTH = 4;

function shouldOmitDirectBinanceSummaryKey(key: string): boolean {
  return (
    /^(?:icon|iconUrl|image|imageUrl|logo|logoUrl|avatar|avatarUrl|cover|coverUrl)$/i.test(
      key,
    ) ||
    /^(?:website|websites|twitter|telegram|discord|medium|social|socials|links?|x)$/i.test(
      key,
    )
  );
}

function compactDirectBinanceSummaryValue(
  value: unknown,
  itemLimit: number,
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (depth >= DIRECT_BINANCE_SUMMARY_MAX_DEPTH) {
    if (Array.isArray(value)) {
      return value
        .slice(0, Math.min(itemLimit, 3))
        .map((item) =>
          compactDirectBinanceSummaryValue(item, itemLimit, depth + 1),
        );
    }
    if (typeof value === "object") {
      const objectValue = value as Record<string, unknown>;
      const compactObject: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(objectValue).slice(0, 8)) {
        if (shouldOmitDirectBinanceSummaryKey(key)) continue;
        if (
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean"
        ) {
          compactObject[key] = entry;
        }
      }
      return compactObject;
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, itemLimit)
      .map((item) =>
        compactDirectBinanceSummaryValue(item, itemLimit, depth + 1),
      )
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const scalarEntries: Array<[string, unknown]> = [];
    const complexEntries: Array<[string, unknown]> = [];
    for (const [key, entry] of Object.entries(objectValue)) {
      if (shouldOmitDirectBinanceSummaryKey(key)) continue;
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
      ) {
        scalarEntries.push([key, entry]);
      } else {
        complexEntries.push([key, entry]);
      }
    }

    const maxKeys = depth === 0 ? 24 : depth === 1 ? 16 : 10;
    const compactObject: Record<string, unknown> = {};
    for (const [key, entry] of [...scalarEntries, ...complexEntries].slice(
      0,
      maxKeys,
    )) {
      const compactEntry = compactDirectBinanceSummaryValue(
        entry,
        key === "data" ? itemLimit : Math.min(itemLimit, 6),
        depth + 1,
      );
      if (compactEntry === undefined) continue;
      if (Array.isArray(compactEntry) && compactEntry.length === 0) continue;
      if (
        compactEntry &&
        typeof compactEntry === "object" &&
        !Array.isArray(compactEntry) &&
        Object.keys(compactEntry as Record<string, unknown>).length === 0
      ) {
        continue;
      }
      compactObject[key] = compactEntry;
    }
    return compactObject;
  }

  return String(value);
}

function buildDirectBinanceSummaryInput(
  unwrapped: string,
  explicitCount: number | null,
): string {
  const itemLimit = explicitCount ?? DIRECT_BINANCE_SUMMARY_DEFAULT_ITEMS;
  try {
    const parsed = JSON.parse(unwrapped) as unknown;
    const compact = compactDirectBinanceSummaryValue(parsed, itemLimit);
    if (compact !== undefined) {
      const compactText = JSON.stringify(compact, null, 2);
      if (compactText.trim()) {
        return compactText;
      }
    }
  } catch {
    // Fall back to raw text for non-JSON outputs.
  }
  return unwrapped;
}

function wantsRawBinanceSkillResult(userText: string): boolean {
  const normalized = userText.toLowerCase();
  return (
    /\braw\b/.test(normalized) ||
    /\bjson\b/.test(normalized) ||
    /\bverbatim\b/.test(normalized) ||
    /\bfull (?:response|result|output)\b/.test(normalized) ||
    /\bexact (?:response|result|output)\b/.test(normalized)
  );
}

const FENCED_JSON_RE_SERVER = /```(?:json)?\s*\n([\s\S]*?)```/;

function unwrapDirectBinanceSkillResult(rawText: string): string {
  const fencedBlocks = Array.from(
    rawText.matchAll(new RegExp(FENCED_JSON_RE_SERVER.source, "g")),
  )
    .map((match) => match[1]?.trim() ?? "")
    .filter((block) => block.length > 0);
  if (fencedBlocks.length > 0) {
    return fencedBlocks.join("\n\n");
  }
  return rawText
    .replace(/^Script executed successfully:\s*/i, "")
    .replace(/^Script execution failed:\s*/i, "")
    .trim();
}

function normalizeDirectBinanceSummaryText(summary: string): string {
  return summary
    .replace(/\*\*/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/^[ \t]*\d+\.\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(
      /\n?(?:For more details or the raw JSON, feel free to ask\.?|You can ask for the raw JSON if you want it\.?|If you need the raw JSON details, feel free to ask\.?)\s*$/i,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function summarizeDirectBinanceSkillResult(
  runtime: AgentRuntime,
  skillSlug: string,
  userText: string,
  rawText: string,
): Promise<string> {
  const unwrapped = unwrapDirectBinanceSkillResult(rawText);
  if (!unwrapped) return rawText;
  const explicitCount = extractExplicitDirectBinanceCount(userText, 50);
  const compactInput = buildDirectBinanceSummaryInput(unwrapped, explicitCount);

  const resultSnippet =
    compactInput.length > DIRECT_BINANCE_SUMMARY_INPUT_MAX_CHARS
      ? `${compactInput.slice(0, DIRECT_BINANCE_SUMMARY_INPUT_MAX_CHARS)}\n\n[truncated]`
      : compactInput;
  const prompt = [
    "You are formatting the result of a Binance skill for the end user.",
    "The official skill instructions say to run the skill first and then summarize the results.",
    "",
    `User request: ${userText}`,
    `Skill: ${skillSlug}`,
    explicitCount
      ? `The user explicitly requested ${explicitCount} items. Return ${explicitCount} distinct items if the result contains that many.`
      : "If the user did not request a count, choose a sensible concise amount.",
    "",
    "Rules:",
    "- Answer the user's request directly using only the result below.",
    "- Default to a concise summary, not raw JSON.",
    "- If the result is a ranking or list, show at most 5 items unless the user explicitly requested a different count.",
    "- Output plain text only.",
    "- Do not use markdown, bullets, numbered lists, bold markers, or code fences.",
    "- Prefer a clean title line followed by compact 'Label: value' lines, with blank lines between items when listing multiple entries.",
    "- Do not prefix lines with generic labels like 'Label:' or 'Item:'. Use the actual field name directly.",
    "- Mention the chain when it is present in the result.",
    "- Ignore icon URLs, image links, and social links unless the user explicitly asked for them.",
    "- Do not mention scripts, stdout, code fences, or internal tooling.",
    "- Do not invent missing fields. If a field is unavailable, omit it.",
    "- If the result is an error, explain it briefly and suggest one next step.",
    "- Do not append any follow-up sentence about raw JSON, more details, or next questions.",
    "",
    "Skill result:",
    resultSnippet,
  ].join("\n");

  try {
    const summary = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 700,
      temperature: 0.2,
    });
    const clean = summary?.trim()
      ? normalizeDirectBinanceSummaryText(summary.trim())
      : "";
    return clean || rawText;
  } catch (err) {
    runtime.logger?.warn(
      {
        src: "eliza-api",
        skillSlug,
        error: err instanceof Error ? err.message : String(err),
      },
      "[eliza-api] Binance skill summarization failed; falling back to raw output",
    );
    return rawText;
  }
}

export async function maybeHandleDirectBinanceSkillRequest(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  appendIncomingText: (incoming: string) => void,
  replaceText?: (text: string) => void,
): Promise<string | null> {
  const userText = extractCompatTextContent(message.content)?.trim();
  if (!userText) return null;

  const skillSlug = extractDirectBinanceSkillSlug(userText);
  if (!skillSlug) return null;
  if (!shouldExposeBinanceSkillId(skillSlug)) {
    const visibleSkills = Array.from(EXPOSED_BINANCE_SKILL_IDS)
      .sort()
      .join(", ");
    return `The Binance skill "${skillSlug}" is currently hidden in this build. Available Binance skills: ${visibleSkills}.`;
  }

  const service = runtime.getService("AGENT_SKILLS_SERVICE") as
    | {
        getLoadedSkill?: (slug: string) => unknown;
        getLoadedSkills?: () => Array<{ slug?: string }>;
      }
    | undefined;
  const hasSkill =
    typeof service?.getLoadedSkill === "function"
      ? Boolean(service.getLoadedSkill(skillSlug))
      : typeof service?.getLoadedSkills === "function"
        ? service
            .getLoadedSkills()
            .some(
              (skill) =>
                typeof skill.slug === "string" && skill.slug === skillSlug,
            )
        : false;
  if (!hasSkill) return null;

  const runtimeActions = Array.isArray(
    (runtime as { actions?: unknown[] }).actions,
  )
    ? ((runtime as { actions: unknown[] }).actions as Array<{
        name?: string;
        handler?: (...args: unknown[]) => unknown;
      }>)
    : [];
  const useSkillAction = runtimeActions.find(
    (action) => action.name === "USE_SKILL",
  );
  const command = resolveDirectBinanceScriptCommand(skillSlug, userText);
  if (!command) {
    return null;
  }
  if (command.kind === "ask") {
    appendIncomingText(command.text);
    return command.text;
  }
  if (typeof useSkillAction?.handler === "function") {
    // Stream a loading hint so the user sees immediate feedback
    const loadingHints: Record<string, string> = {
      "binance-meme-rush": "Fetching meme tokens from Binance...",
      "binance-trading-signal": "Fetching trading signals...",
      "binance-crypto-market-rank": "Fetching market rankings...",
      "binance-query-token-info": "Looking up token info...",
      "binance-query-token-audit": "Running token audit...",
      "binance-query-address-info": "Checking wallet balances...",
    };
    appendIncomingText(loadingHints[skillSlug] ?? "Fetching Binance data...");

    let directRunText = "";
    runtime.logger?.info(
      {
        src: "eliza-api",
        action: "USE_SKILL",
        skillSlug,
        script: command.script,
        args: command.args,
      },
      `[eliza-api] Direct Binance script dispatch: ${skillSlug}/${command.script}`,
    );
    const runResult = await Promise.resolve(
      useSkillAction.handler(
        runtime,
        message,
        undefined,
        {
          slug: skillSlug,
          mode: "script",
          script: command.script,
          args: command.args,
        },
        async (content: unknown) => {
          const chunk =
            content && typeof content === "object"
              ? extractCompatTextContent(content as Content)
              : "";
          if (!chunk) return [];
          directRunText = chunk;
          return [];
        },
        [],
      ),
    );
    const rawDirectText =
      directRunText.trim().length > 0
        ? directRunText
        : runResult &&
            typeof runResult === "object" &&
            "text" in runResult &&
            typeof (runResult as { text?: unknown }).text === "string"
          ? (runResult as { text: string }).text
          : "";
    if (rawDirectText.trim().length > 0) {
      const finalText = wantsRawBinanceSkillResult(userText)
        ? rawDirectText
        : await summarizeDirectBinanceSkillResult(
            runtime,
            skillSlug,
            userText,
            rawDirectText,
          );
      // Replace the loading hint with the actual result via snapshot
      if (replaceText) {
        replaceText(finalText);
      } else {
        appendIncomingText(finalText);
      }
      return finalText;
    }
  }
  return null;
}
