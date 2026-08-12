/**
 * WalletConnect project-ID resolution and validation.
 *
 * The WalletConnect project ID is a **public** identifier (safe to inline in a
 * browser bundle) but it must be *real*: RainbowKit/wagmi silently accept a
 * placeholder and present a QR/deep-link modal that never connects, which
 * false-greens wallet login. This module centralises the placeholder check so
 * both the runtime provider ({@link StewardWalletProviders}) and the Vite
 * build-time guard enforce the same rule.
 *
 * @see https://github.com/walletconnect/walletconnect-monorepo — project IDs
 * are issued from cloud.walletconnect.com and are intentionally non-secret.
 */

/** The literal placeholder the old code fell back to. */
export const WALLETCONNECT_PLACEHOLDER = "YOUR_WC_PROJECT_ID";

/**
 * Known placeholder substrings (lower-cased). Any env value containing one is
 * treated as unset so a partially-edited `.env` (e.g.
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=YOUR_WC_PROJECT_ID`) never slips
 * through.
 */
const PLACEHOLDER_SUBSTRINGS = Object.freeze([
  "your_wc_project_id",
  "your-wc-project-id",
  "your_walletconnect",
  "your-walletconnect",
  "replace_with",
  "replace-with",
  "placeholder",
  "changeme",
  "xxx",
  "todo",
]);

/**
 * Returns the env-provided project ID when it is present and not a placeholder,
 * or `undefined` otherwise. Trims surrounding whitespace.
 *
 * @param envValue - The raw `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` value.
 */
export function resolveWalletConnectProjectId(
  envValue: string | undefined,
): string | undefined {
  const trimmed = envValue?.trim();
  if (!trimmed) return undefined;

  if (trimmed === WALLETCONNECT_PLACEHOLDER) return undefined;

  const lower = trimmed.toLowerCase();
  for (const marker of PLACEHOLDER_SUBSTRINGS) {
    if (lower.includes(marker)) return undefined;
  }

  return trimmed;
}

/**
 * Reason strings surfaced to the developer when validation fails. Exported so
 * the build-time guard can reuse the exact wording in its thrown error.
 */
export const WALLETCONNECT_MISSING_REASON =
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing or blank";
export const WALLETCONNECT_PLACEHOLDER_REASON =
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is still the placeholder " +
  "(YOUR_WC_PROJECT_ID) — set a real project ID from cloud.walletconnect.com";

/**
 * Returns a human-readable failure reason when `resolveWalletConnectProjectId`
 * would reject the value, or `undefined` when the value is valid.
 */
export function walletConnectProjectIdRejectionReason(
  envValue: string | undefined,
): string | undefined {
  const trimmed = envValue?.trim();
  if (!trimmed) return WALLETCONNECT_MISSING_REASON;
  if (resolveWalletConnectProjectId(trimmed)) return undefined;
  return WALLETCONNECT_PLACEHOLDER_REASON;
}
