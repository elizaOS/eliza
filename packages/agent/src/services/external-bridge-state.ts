/**
 * External wallet bridge state — owned by the agent runtime so callers in this
 * package don't have to reach upward into presentation packages (apps/*) for
 * sync state queries. Outer-layer integrations (e.g. app-steward) write into
 * this module via the public setters; agent-internal code reads via the
 * getters.
 */

let stewardEvmBridgeActive = false;

export function setStewardEvmBridgeActive(active: boolean): void {
  stewardEvmBridgeActive = active;
}

export function isStewardEvmBridgeActive(): boolean {
  return stewardEvmBridgeActive;
}

function normalizeEnv(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isPrivyWalletProvisioningEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const appId =
    normalizeEnv(env.PRIVY_APP_ID) ?? normalizeEnv(env.BABYLON_PRIVY_APP_ID);
  const appSecret =
    normalizeEnv(env.PRIVY_APP_SECRET) ??
    normalizeEnv(env.BABYLON_PRIVY_APP_SECRET);
  return Boolean(appId && appSecret);
}
