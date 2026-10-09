/**
 * Centralised readers for Eliza feature flags that gate unreleased or
 * in-progress integrations. Keep this module dependency-free so it can be
 * imported from any layer (api, runtime, cloud) without cycles.
 *
 * Flags live in `process.env` (set via `config.env` on disk). They are read
 * each call so a runtime restart picks up changes without a module reload.
 */

function readBoolFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const trimmed = String(raw).trim().toLowerCase();
  if (
    trimmed === "1" ||
    trimmed === "true" ||
    trimmed === "yes" ||
    trimmed === "on"
  ) {
    return true;
  }
  if (
    trimmed === "0" ||
    trimmed === "false" ||
    trimmed === "no" ||
    trimmed === "off"
  ) {
    return false;
  }
  return fallback;
}

/**
 * Eliza Cloud remote-signing wallet bridge.
 *
 * When on: `POST /api/cloud/login/status` provisions cloud wallets, writes
 * `WALLET_SOURCE_*`, and the UI exposes a dual-wallet (local | cloud) picker.
 * When off: zero cloud-wallet code paths run; wallet UI/API behave as before.
 */
export function isCloudWalletEnabled(): boolean {
  return readBoolFlag("ENABLE_CLOUD_WALLET");
}
