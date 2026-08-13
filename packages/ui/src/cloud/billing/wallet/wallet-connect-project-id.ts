/**
 * Resolves a WalletConnect Cloud project id for the packaged wallet stack.
 *
 * The public project id is not a secret, but a placeholder or blank value
 * silently breaks QR/deep-link WalletConnect while injected wallets can still
 * appear healthy. Callers must fail closed: never substitute
 * `YOUR_WC_PROJECT_ID` or any other non-configured sentinel (#18459).
 */

/** Documented placeholder still present in older templates and docs samples. */
export const WALLETCONNECT_PROJECT_ID_PLACEHOLDER = "YOUR_WC_PROJECT_ID";

/**
 * Whether a raw env candidate is a usable WalletConnect project id.
 *
 * Rejects empty/whitespace, the documented placeholder, and generic
 * replace-me / placeholder tokens. Real Reown/WalletConnect ids are
 * non-empty alphanumeric (with optional hyphen/underscore) strings that are
 * not those sentinels.
 */
export function isConfiguredWalletConnectProjectId(
  value: string | undefined | null,
): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  const normalized = trimmed.toLowerCase();
  if (
    normalized === WALLETCONNECT_PROJECT_ID_PLACEHOLDER.toLowerCase() ||
    normalized.includes("your_wc_") ||
    normalized.includes("your-wc-") ||
    normalized.includes("replace_with") ||
    normalized.includes("replace-me") ||
    normalized.includes("placeholder") ||
    normalized === "changeme" ||
    normalized === "todo"
  ) {
    return false;
  }

  // WalletConnect/Reown project ids are opaque public tokens; require a
  // minimum length so a single character or "0" cannot pass as configured.
  if (trimmed.length < 8) return false;

  return true;
}

/**
 * Pick the first configured WalletConnect project id from candidate env values.
 * Returns `null` when none is usable — callers must not invent a fallback.
 */
export function resolveWalletConnectProjectId(
  ...candidates: ReadonlyArray<string | undefined | null>
): string | null {
  for (const candidate of candidates) {
    if (isConfiguredWalletConnectProjectId(candidate)) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Read WalletConnect project id from the Vite / process env surfaces used by
 * the cloud shell. Vite only inlines literal `import.meta.env.*` property
 * accesses; keep those explicit so production bundles can substitute values.
 */
export function readWalletConnectProjectIdFromEnv(): string | null {
  return resolveWalletConnectProjectId(
    import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID,
    import.meta.env?.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
      : undefined,
    typeof process !== "undefined"
      ? process.env.VITE_WALLETCONNECT_PROJECT_ID
      : undefined,
  );
}
