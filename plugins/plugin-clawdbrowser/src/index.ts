/**
 * @elizaos/plugin-clawdbrowser
 *
 * Official elizaOS plugin that gives agents access to the ClawdBrowser
 * SOL GPT tool catalog (tools.md) — search, describe, and list tools.
 *
 * Default catalog path: /Users/8bit/ClawdBrowser/tools.md
 * Override: CLAWDBROWSER_TOOLS_MD or CLAWDBROWSER_ROOT
 */

import type { Plugin, Service } from "@elizaos/core";
import { describeClawdToolAction } from "./actions/describe-tool.js";
import { listClawdToolsAction } from "./actions/list-tools.js";
import { searchClawdToolsAction } from "./actions/search-tools.js";
import { clawdBrowserToolsProvider } from "./providers/tools-catalog.js";
import {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "./services/catalog-service.js";

export {
  formatCatalogSummary,
  formatToolBrief,
  parseToolsMd,
  searchCatalog,
} from "./catalog/parse-tools-md.js";
export type {
  CatalogGroup,
  CatalogTool,
  ClawdBrowserCatalog,
} from "./catalog/parse-tools-md.js";
export {
  readClawdBrowserConfig,
  resolveToolsMdPath,
} from "./config.js";
export type { ClawdBrowserConfig } from "./config.js";
export {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "./services/catalog-service.js";
export { searchClawdToolsAction } from "./actions/search-tools.js";
export { describeClawdToolAction } from "./actions/describe-tool.js";
export { listClawdToolsAction } from "./actions/list-tools.js";
export { clawdBrowserToolsProvider } from "./providers/tools-catalog.js";

/** Service class adapter for runtime.registerService */
class ClawdBrowserCatalogServiceClass {
  static serviceType = CLAWDBROWSER_SERVICE_TYPE;
  capabilityDescription =
    "ClawdBrowser SOL GPT tool catalog (tools.md)";
  private inner: ClawdBrowserCatalogService;

  constructor(runtime: {
    getSetting: (k: string) => string | undefined | null;
  }) {
    this.inner = new ClawdBrowserCatalogService((k) => runtime.getSetting(k));
  }

  static async start(runtime: {
    getSetting: (k: string) => string | undefined | null;
  }): Promise<ClawdBrowserCatalogServiceClass> {
    const s = new ClawdBrowserCatalogServiceClass(runtime);
    s.inner.load();
    return s;
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  getInner(): ClawdBrowserCatalogService {
    return this.inner;
  }
}

export const clawdBrowserPlugin: Plugin = {
  name: "@elizaos/plugin-clawdbrowser",
  description:
    "Official ClawdBrowser tools.md catalog for elizaOS agents — SEARCH_CLAWD_TOOLS, DESCRIBE_CLAWD_TOOL, LIST_CLAWD_TOOLS. Non-custodial SOL GPT surface (171 tools).",
  actions: [
    searchClawdToolsAction,
    describeClawdToolAction,
    listClawdToolsAction,
  ],
  providers: [clawdBrowserToolsProvider],
  services: [ClawdBrowserCatalogServiceClass as unknown as typeof Service],
  init: async (_config, runtime) => {
    // Eager load so first turn has catalog in provider
    const getSetting = (k: string) =>
      (runtime as { getSetting?: (key: string) => string | undefined }).getSetting?.(
        k,
      );
    const svc = new ClawdBrowserCatalogService(getSetting ?? (() => undefined));
    svc.load();
  },
};

export default clawdBrowserPlugin;
