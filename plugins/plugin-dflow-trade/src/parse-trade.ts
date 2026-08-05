/**
 * Parse natural-language trade intents into structured swap params.
 */

import {
  resolveMint,
  toAtomicAmount,
  type DflowTradeConfig,
} from "./config.js";

export type ParsedTrade = {
  input: { mint: string; decimals: number | null; symbol: string };
  output: { mint: string; decimals: number | null; symbol: string };
  humanAmount: string;
  atomicAmount: string | null;
  live: boolean;
  previewOnly: boolean;
};

const TRADE_RE =
  /(?:quote|swap|trade|buy|sell|convert|exchange)\s+(\d+(?:\.\d+)?)\s+([$\w.-]{2,48})\s+(?:to|for|into|->|→)\s+([$\w.-]{2,48})/i;

const LIVE_RE = /\b(live|execute|broadcast|sign\s+and\s+send|confirm\s+swap)\b/i;
const PREVIEW_RE = /\b(preview|quote\s+only|dry[- ]?run|simulate)\b/i;

export function parseTradeIntent(
  text: string,
  _cfg?: DflowTradeConfig,
): ParsedTrade | null {
  const m = text.match(TRADE_RE);
  if (!m) return null;

  const humanAmount = m[1]!;
  const fromRaw = m[2]!;
  const toRaw = m[3]!;

  // sell X for Y vs buy Y with X — "buy 10 USDC with SOL" not covered; keep simple A to B
  const input = resolveMint(fromRaw);
  const output = resolveMint(toRaw);

  let atomicAmount: string | null = null;
  if (input.decimals != null) {
    atomicAmount = toAtomicAmount(humanAmount, input.decimals);
  }

  const live = LIVE_RE.test(text) && !PREVIEW_RE.test(text);
  const previewOnly = PREVIEW_RE.test(text) || !live;

  return {
    input,
    output,
    humanAmount,
    atomicAmount,
    live,
    previewOnly,
  };
}

export function looksLikeTradeUtterance(text: string): boolean {
  return (
    TRADE_RE.test(text) ||
    /\b(dflow|swap|quote)\b/i.test(text) ||
    /\b(solana\s+balance|wallet\s+balance|trade\s+readiness)\b/i.test(text)
  );
}
