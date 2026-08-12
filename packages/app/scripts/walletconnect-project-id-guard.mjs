/**
 * Build-time guard for the WalletConnect project ID.
 *
 * WalletConnect reads `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and, historically,
 * fell back to the literal placeholder `YOUR_WC_PROJECT_ID`. The QR/deep-link
 * modal silently accepts a placeholder and never connects — false-green wallet
 * login. This guard makes a **production** Vite build (`vite build` / mode
 * "production") fail loudly when the project ID is missing, blank, or still the
 * placeholder, so a Pages deploy that forgot to inject it is caught at build
 * time rather than shipping a broken wallet surface.
 *
 * The production/staging Pages builds (cloud-cf-deploy.yml) run plain
 * `vite build` (mode "production"); `vite dev` and development-mode bundles are
 * exempt so local development without a project ID still works.
 *
 * Mirrors the validation logic in
 * packages/ui/src/cloud/billing/wallet/walletconnect-project-id.ts.
 */

export const WALLETCONNECT_PLACEHOLDER = "YOUR_WC_PROJECT_ID";

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
 * or `undefined` otherwise.
 */
export function resolveWalletConnectProjectId(envValue) {
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  if (!trimmed) return undefined;

  if (trimmed === WALLETCONNECT_PLACEHOLDER) return undefined;

  const lower = trimmed.toLowerCase();
  for (const marker of PLACEHOLDER_SUBSTRINGS) {
    if (lower.includes(marker)) return undefined;
  }

  return trimmed;
}

/**
 * Returns a human-readable failure reason when the value is invalid, or
 * `undefined` when the value is valid. Exported so the Vite plugin can reuse
 * the exact wording in its thrown error.
 */
export function walletConnectProjectIdRejectionReason(envValue) {
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  if (!trimmed) {
    return (
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing or blank — " +
      "set a real project ID from cloud.walletconnect.com"
    );
  }
  if (resolveWalletConnectProjectId(trimmed)) return undefined;
  return (
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is still the placeholder " +
    "(YOUR_WC_PROJECT_ID) — set a real project ID from cloud.walletconnect.com"
  );
}
