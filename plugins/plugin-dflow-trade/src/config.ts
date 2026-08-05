/**
 * DFlow + Helius + wallet settings for Solana spot trading.
 *
 * Production Trade API: https://quote-api.dflow.net (requires DFLOW_API_KEY)
 * Dev Trade API:        https://dev-quote-api.dflow.net (no key, rate-limited)
 * RPC: HELIUS_RPC_URL or SOLANA_RPC_URL
 * Live: SOLANA_TRADE_LIVE=true + SOLANA_PRIVATE_KEY (base58)
 */

export type DflowTradeConfig = {
  apiKey: string | null;
  tradeApiUrl: string;
  rpcUrl: string | null;
  privateKeyBase58: string | null;
  liveEnabled: boolean;
  defaultSlippageBps: string;
  prioritizationFeeLamports: string;
  deepseekConfigured: boolean;
};

const PROD_API = "https://quote-api.dflow.net";
const DEV_API = "https://dev-quote-api.dflow.net";

export function readDflowTradeConfig(
  getSetting: (key: string) => string | undefined | null = (k) =>
    process.env[k],
): DflowTradeConfig {
  const apiKey =
    (getSetting("DFLOW_API_KEY") || getSetting("DFLOW_TRADE_API_KEY") || "")
      .trim() || null;

  const explicitUrl = (
    getSetting("DFLOW_TRADE_API_URL") ||
    getSetting("DFLOW_API_URL") ||
    ""
  ).trim();

  // Prefer prod host when a key is present; otherwise dev (no key required).
  const tradeApiUrl =
    explicitUrl || (apiKey ? PROD_API : DEV_API);

  const rpcUrl =
    (
      getSetting("HELIUS_RPC_URL") ||
      getSetting("SOLANA_RPC_URL") ||
      getSetting("RPC_URL") ||
      ""
    ).trim() || null;

  const privateKeyBase58 =
    (
      getSetting("SOLANA_PRIVATE_KEY") ||
      getSetting("WALLET_PRIVATE_KEY") ||
      getSetting("PRIVATE_KEY") ||
      ""
    ).trim() || null;

  const liveRaw = (
    getSetting("SOLANA_TRADE_LIVE") ||
    getSetting("DFLOW_TRADE_LIVE") ||
    ""
  )
    .trim()
    .toLowerCase();
  const liveEnabled = liveRaw === "true" || liveRaw === "1" || liveRaw === "yes";

  const defaultSlippageBps =
    (getSetting("DFLOW_SLIPPAGE_BPS") || "auto").trim() || "auto";

  const prioritizationFeeLamports =
    (getSetting("DFLOW_PRIORITY_FEE") || "auto").trim() || "auto";

  const deepseekConfigured = Boolean(
    (getSetting("DEEPSEEK_API_KEY") || "").trim(),
  );

  return {
    apiKey,
    tradeApiUrl,
    rpcUrl,
    privateKeyBase58,
    liveEnabled,
    defaultSlippageBps,
    prioritizationFeeLamports,
    deepseekConfigured,
  };
}

export function formatReadiness(cfg: DflowTradeConfig): string {
  const lines = [
    "DFlow Solana trade readiness:",
    `  trade API: ${cfg.tradeApiUrl}`,
    `  DFLOW_API_KEY: ${cfg.apiKey ? "set" : "missing (using dev host if default)"}`,
    `  HELIUS_RPC_URL / SOLANA_RPC_URL: ${cfg.rpcUrl ? "set" : "missing"}`,
    `  wallet key: ${cfg.privateKeyBase58 ? "set" : "missing"}`,
    `  SOLANA_TRADE_LIVE: ${cfg.liveEnabled ? "true (live swaps allowed)" : "false (quote/preview only)"}`,
    `  DEEPSEEK_API_KEY: ${cfg.deepseekConfigured ? "set" : "not set (any LLM provider works)"}`,
    "",
    "Natural language: “quote 0.01 SOL to USDC”, “swap 1 USDC to SOL (preview)”, “execute swap …”.",
    "Live path requires SOLANA_TRADE_LIVE=true + SOLANA_PRIVATE_KEY + HELIUS_RPC_URL.",
  ];
  return lines.join("\n");
}

/** Well-known mainnet mints for natural language. */
export const KNOWN_MINTS: Record<string, { mint: string; decimals: number }> = {
  sol: {
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  wsol: {
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  usdc: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  usdt: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
  jup: {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
  },
  bonk: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
  },
  jito: {
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    decimals: 9,
  },
  jitosol: {
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    decimals: 9,
  },
  ray: {
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    decimals: 6,
  },
};

export function resolveMint(symbolOrMint: string): {
  mint: string;
  decimals: number | null;
  symbol: string;
} {
  const raw = symbolOrMint.trim();
  if (!raw) throw new Error("empty mint/symbol");

  // base58 mint (~32-44 chars)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) && raw.length >= 32) {
    return { mint: raw, decimals: null, symbol: raw.slice(0, 4) + "…" };
  }

  const key = raw.toLowerCase().replace(/^\$/, "");
  const known = KNOWN_MINTS[key];
  if (known) {
    return { mint: known.mint, decimals: known.decimals, symbol: key.toUpperCase() };
  }
  throw new Error(
    `Unknown token "${raw}". Use a base58 mint or one of: ${Object.keys(KNOWN_MINTS).join(", ")}`,
  );
}

/** Convert human amount to atomic units (bigint string). */
export function toAtomicAmount(
  human: number | string,
  decimals: number,
): string {
  const s = String(human).trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid amount: ${human}`);
  }
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const atomic = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  if (atomic <= 0n) throw new Error("amount must be > 0");
  return atomic.toString();
}
