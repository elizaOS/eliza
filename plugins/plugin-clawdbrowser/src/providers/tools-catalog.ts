/**
 * Injects a compact ClawdBrowser tool catalog summary into agent context.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { formatCatalogSummary } from "../catalog/parse-tools-md.js";
import {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "../services/catalog-service.js";

function getService(runtime: IAgentRuntime): ClawdBrowserCatalogService | null {
  const svc = runtime.getService?.(CLAWDBROWSER_SERVICE_TYPE) as
    | ClawdBrowserCatalogService
    | null
    | undefined;
  if (svc) return svc;
  // Ephemeral fallback so providers work even before service registration
  const ephemeral = new ClawdBrowserCatalogService((k) =>
    runtime.getSetting?.(k) as string | undefined,
  );
  ephemeral.load();
  return ephemeral;
}

export const clawdBrowserToolsProvider: Provider = {
  name: "CLAWD_BROWSER_TOOLS",
  description:
    "ClawdBrowser SOL GPT tool catalog summary (from tools.md) — groups, counts, non-custodial rules",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const svc = getService(runtime);
    const catalog = svc?.getCatalog();
    if (!catalog) {
      const err = svc?.getLastError() || "catalog unavailable";
      return {
        text: `ClawdBrowser tools: unavailable (${err}). Set CLAWDBROWSER_TOOLS_MD=/path/to/tools.md`,
        data: { error: err },
        values: { clawdbrowserToolsReady: false },
      };
    }
    const text = formatCatalogSummary(catalog);
    return {
      text,
      data: {
        totalTools: catalog.totalTools,
        coreCount: catalog.coreCount,
        groups: catalog.groups.map((g) => ({
          id: g.id,
          name: g.name,
          count: g.tools.length,
        })),
        sourcePath: catalog.sourcePath,
      },
      values: {
        clawdbrowserToolsReady: true,
        clawdbrowserToolCount: catalog.totalTools,
      },
    };
  },
};
