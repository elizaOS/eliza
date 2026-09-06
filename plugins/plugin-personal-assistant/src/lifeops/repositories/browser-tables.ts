/** Resolves browser bridge table ownership during schema compatibility transitions and caches the result per runtime. */
import type { IAgentRuntime } from "@elizaos/core";
import { tableExists } from "./schema-compatibility.js";

export type BrowserBridgeTableKey =
  | "companions"
  | "settings"
  | "tabs"
  | "pageContexts";

export const BROWSER_BRIDGE_TABLE_NAMES = {
  companions: "browser_bridge_companions",
  settings: "browser_bridge_settings",
  tabs: "browser_bridge_tabs",
  pageContexts: "browser_bridge_page_contexts",
} as const satisfies Record<BrowserBridgeTableKey, string>;

export const browserBridgeTableCache = new WeakMap<
  IAgentRuntime,
  Partial<Record<BrowserBridgeTableKey, string>>
>();

export async function resolveBrowserBridgeTable(
  runtime: IAgentRuntime,
  key: BrowserBridgeTableKey,
): Promise<string> {
  let cached = browserBridgeTableCache.get(runtime);
  if (!cached) {
    cached = {};
    browserBridgeTableCache.set(runtime, cached);
  }
  if (cached[key]) {
    return cached[key];
  }

  const publicTable = BROWSER_BRIDGE_TABLE_NAMES[key];
  const schemaTable = `browser.${publicTable}`;
  if (await tableExists(runtime, schemaTable)) {
    cached[key] = schemaTable;
    return schemaTable;
  }
  if (await tableExists(runtime, publicTable)) {
    cached[key] = publicTable;
    return publicTable;
  }

  cached[key] = schemaTable;
  return schemaTable;
}
