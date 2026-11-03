/** Live swaps stay off unless this env value is the exact string "true". */
export const LIVE_TRADING_ENV = "VALHALLA_LIVE_TRADING";
export const WALLET_SECRET_ENV = "VALHALLA_WALLET_SECRET_KEY";
export const WALLET_PUBKEY_ENV = "VALHALLA_PUBKEY";

export function liveTradingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LIVE_TRADING_ENV] === "true";
}

/**
 * Read the trading secret only after live mode is explicit.
 * A file path is refused. This function does not touch the filesystem.
 */
export function loadWalletSecret(env: Record<string, string | undefined>): string {
  if (!liveTradingEnabled(env)) {
    throw new Error("Live trading is off. The wallet secret is not read.");
  }
  const secret = env[WALLET_SECRET_ENV]?.trim() ?? "";
  if (!secret) {
    throw new Error(
      "Set VALHALLA_WALLET_SECRET_KEY to a base58 secret. The plugin does not read key files."
    );
  }
  if (
    secret.includes("/") ||
    secret.includes("\\") ||
    secret.endsWith(".json") ||
    secret.startsWith("file:") ||
    secret.startsWith("wallet")
  ) {
    throw new Error(
      "Refusing a file path. Pass the secret only through VALHALLA_WALLET_SECRET_KEY."
    );
  }
  return secret;
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}
