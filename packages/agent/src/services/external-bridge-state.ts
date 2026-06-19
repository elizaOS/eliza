/**
 * External wallet bridge state — owned by the agent runtime so callers in this
 * package don't have to reach upward into app plugin packages (plugins/app-*) for
 * sync state queries. This is the single source of truth for whether the
 * Steward EVM bridge is active: outer-layer integrations (plugin-steward-app)
 * write into it via {@link setStewardEvmBridgeActive}, and any reader — including
 * the plugin's own status accessor — must read it via {@link isStewardEvmBridgeActive}.
 */

let stewardEvmBridgeActive = false;

export function setStewardEvmBridgeActive(active: boolean): void {
  stewardEvmBridgeActive = active;
}

export function isStewardEvmBridgeActive(): boolean {
  return stewardEvmBridgeActive;
}
