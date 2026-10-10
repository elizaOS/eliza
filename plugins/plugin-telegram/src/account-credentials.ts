/** Resolves personal Telegram application credentials through account configuration and canonical runtime projections. */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";

function isVaultReference(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("vault://") &&
    value.length > "vault://".length
  );
}

// These public Telegram Desktop credentials identify the client application.
// Account authorization remains in the separately encrypted StringSession.
const BUNDLED_TELEGRAM_APP_ID = 2040;
const BUNDLED_TELEGRAM_APP_HASH = "b18441a1ff607e10a989891a5462e627";

/**
 * Parse a Telegram app id as a canonical decimal integer only. `Number()`
 * silently accepts non-canonical forms (`"0x7F8"` → 2040, `"2e3"` → 2000,
 * `"+2040"` → 2040) that my.telegram.org never issues; malformed values must
 * be rejected so the credential tiers fall through to the next source
 * instead of silently using a fabricated app id.
 * Returns `Number.NaN` for anything that is not a canonical digit string
 * or a number.
 */
function parseAppId(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Canonical digit strings only: no hex, no exponents, no explicit-plus
    // forms, no leading-dot forms, no trailing junk, no blanks.
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
  }
  return Number.NaN;
}

function resolveRuntimeCredentialPair(
  runtime: IAgentRuntime,
  appIdKey: string,
  appHashKey: string,
): { apiId: number; apiHash: string } | null {
  const appId = runtime.getSetting(appIdKey);
  const appHash = runtime.getSetting(appHashKey);
  const parsedAppId = parseAppId(appId);
  if (
    !Number.isInteger(parsedAppId) ||
    parsedAppId <= 0 ||
    typeof appHash !== "string" ||
    appHash.trim().length === 0
  ) {
    return null;
  }
  return { apiId: parsedAppId, apiHash: appHash.trim() };
}

/**
 * Resolve the MTProto app credentials for the personal-account login, in
 * priority order: (1) per-account configured creds (power users / own app
 * identity), (2) canonical connector settings `TELEGRAM_ACCOUNT_APP_ID` /
 * `TELEGRAM_ACCOUNT_APP_HASH`, (3) the legacy deployment-setting aliases, and
 * (4) the bundled default. Vault-backed connector values are projected only
 * through the canonical setting names, so reading those names first preserves
 * a user's app identity after plaintext-to-Vault migration. Never returns null,
 * so the fragile my.telegram.org provisioning scrape is bypassed entirely.
 */
export function resolveTelegramAppCredentials(
  runtime: IAgentRuntime,
  connConfig: Record<string, unknown>,
  requireVaultProjection = false,
): { apiId: number; apiHash: string } {
  const parsedAccountId = parseAppId(connConfig.appId);
  if (
    Number.isInteger(parsedAccountId) &&
    parsedAccountId > 0 &&
    typeof connConfig.appHash === "string" &&
    connConfig.appHash.trim().length > 0 &&
    !isVaultReference(connConfig.appHash)
  ) {
    return {
      apiId: parsedAccountId,
      apiHash: connConfig.appHash.trim(),
    };
  }
  const canonicalCredentials = resolveRuntimeCredentialPair(
    runtime,
    "TELEGRAM_ACCOUNT_APP_ID",
    "TELEGRAM_ACCOUNT_APP_HASH",
  );
  if (canonicalCredentials && !isVaultReference(canonicalCredentials.apiHash))
    return canonicalCredentials;
  if (requireVaultProjection && isVaultReference(connConfig.appHash))
    throw new ElizaError(
      "Resolve this account's Telegram application credentials before connecting history.",
      {
        code: "TELEGRAM_ACCOUNT_CONFIG_INVALID",
      },
    );

  const legacyCredentials = resolveRuntimeCredentialPair(
    runtime,
    "TELEGRAM_APP_ID",
    "TELEGRAM_APP_HASH",
  );
  if (legacyCredentials) return legacyCredentials;

  return {
    apiId: BUNDLED_TELEGRAM_APP_ID,
    apiHash: BUNDLED_TELEGRAM_APP_HASH,
  };
}
