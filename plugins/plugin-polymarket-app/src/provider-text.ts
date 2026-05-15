import {
  POLYMARKET_CLOB_API_BASE,
  POLYMARKET_DATA_API_BASE,
  POLYMARKET_GAMMA_API_BASE,
  POLYMARKET_TRADING_ENV_VARS,
  type PolymarketTradingEnvVar,
} from "./polymarket-contracts";

const TRADING_ENV_ALIASES: Partial<Record<PolymarketTradingEnvVar, string[]>> =
  {
    CLOB_API_KEY: ["POLYMARKET_CLOB_API_KEY"],
    CLOB_API_SECRET: ["POLYMARKET_CLOB_SECRET"],
    CLOB_API_PASSPHRASE: ["POLYMARKET_CLOB_PASSPHRASE"],
  };

function hasTradingEnvVar(
  env: Record<string, string | undefined>,
  name: PolymarketTradingEnvVar,
): boolean {
  if (env[name]?.trim()) return true;
  return (TRADING_ENV_ALIASES[name] ?? []).some((alias) => env[alias]?.trim());
}

export function derivePolymarketStatusText(
  env: Record<string, string | undefined>,
): {
  text: string;
  data: Record<string, unknown>;
} {
  const missing = POLYMARKET_TRADING_ENV_VARS.filter(
    (name) => !hasTradingEnvVar(env, name),
  );
  const credentialsReady = missing.length === 0;
  const text = [
    "Polymarket app context:",
    "- Public reads: ready",
    `- Gamma API: ${POLYMARKET_GAMMA_API_BASE}`,
    `- Data API: ${POLYMARKET_DATA_API_BASE}`,
    `- CLOB API: ${POLYMARKET_CLOB_API_BASE}`,
    `- Trading credentials: ${credentialsReady ? "present" : "missing"}`,
    "- Signed trading: disabled in this native app scaffold",
    missing.length ? `- Missing: ${missing.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    text,
    data: {
      publicReadsReady: true,
      tradingReady: false,
      credentialsReady,
      missing,
    },
  };
}
