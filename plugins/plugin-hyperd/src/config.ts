/**
 * Resolves and validates plugin config from agentConfig env vars.
 *
 * Source precedence (highest first):
 *   1. agentConfig.settings (when loaded inside an elizaOS runtime)
 *   2. process.env (when running standalone — tests, scripts)
 *
 * Required: HYPERD_BUYER_PRIVATE_KEY (a 0x-prefixed 32-byte hex string).
 * Optional: HYPERD_API_BASE (defaults to https://api.hyperd.ai),
 *           HYPERD_MAX_USDC_PER_CALL (defaults to 0.25).
 */

export interface HyperdConfig {
  apiBase: string;
  buyerPrivateKey: `0x${string}`;
  maxUsdcPerCall: number;
}

const DEFAULT_API_BASE = "https://api.hyperd.ai";
const DEFAULT_MAX_USDC_PER_CALL = 0.25;

/**
 * Read a setting from runtime if present (its `getSetting` returns
 * `string | number | boolean | null`), otherwise fall back to process.env.
 * Returns a non-empty string or undefined.
 */
function readSetting(
  source: { getSetting?: (key: string) => string | number | boolean | null } | undefined,
  key: string,
): string | undefined {
  if (source?.getSetting) {
    const v = source.getSetting(key);
    if (v !== undefined && v !== null) {
      const s = String(v);
      if (s.length > 0) return s;
    }
  }
  return process.env[key];
}

function validatePrivateKey(value: string | undefined): `0x${string}` {
  if (!value) {
    throw new Error(
      "[plugin-hyperd] HYPERD_BUYER_PRIVATE_KEY is required. Set it in agentConfig or process.env.",
    );
  }
  const trimmed = value.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(trimmed)) {
    throw new Error(
      "[plugin-hyperd] HYPERD_BUYER_PRIVATE_KEY must be a 0x-prefixed 64-hex-character (32-byte) EVM private key.",
    );
  }
  return trimmed as `0x${string}`;
}

function parseMaxUsdc(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_USDC_PER_CALL;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `[plugin-hyperd] HYPERD_MAX_USDC_PER_CALL must be a positive number. Got: ${value}`,
    );
  }
  return n;
}

export function resolveConfig(
  runtime?: { getSetting?: (key: string) => string | number | boolean | null },
): HyperdConfig {
  const apiBase = readSetting(runtime, "HYPERD_API_BASE") ?? DEFAULT_API_BASE;
  const privateKey = validatePrivateKey(readSetting(runtime, "HYPERD_BUYER_PRIVATE_KEY"));
  const maxUsdcPerCall = parseMaxUsdc(readSetting(runtime, "HYPERD_MAX_USDC_PER_CALL"));

  return {
    apiBase: apiBase.replace(/\/$/, ""),
    buyerPrivateKey: privateKey,
    maxUsdcPerCall,
  };
}
