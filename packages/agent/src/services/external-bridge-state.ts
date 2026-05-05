/**
 * External wallet bridge state — owned by the agent runtime so callers in this
 * package don't have to reach upward into app plugin packages (plugins/app-*) for
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
