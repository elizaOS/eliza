import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { formatToolBrief } from "../catalog/parse-tools-md.js";
import {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "../services/catalog-service.js";

function getService(runtime: IAgentRuntime): ClawdBrowserCatalogService {
  const existing = runtime.getService?.(CLAWDBROWSER_SERVICE_TYPE) as
    | ClawdBrowserCatalogService
    | null
    | undefined;
  if (existing) return existing;
  const svc = new ClawdBrowserCatalogService((k) =>
    runtime.getSetting?.(k) as string | undefined,
  );
  svc.load();
  return svc;
}

function extractQuery(text: string): string {
  const m =
    text.match(
      /(?:search|find|lookup)\s+(?:clawd\s*)?(?:browser\s*)?tools?\s*(?:for|about|matching)?\s*[:\-]?\s*(.+)/i,
    ) ||
    text.match(/search_tools?\s+(.+)/i) ||
    text.match(/(?:tools?\s+for)\s+(.+)/i);
  return (m?.[1] || text).trim().slice(0, 200);
}

export const searchClawdToolsAction: Action = {
  name: "SEARCH_CLAWD_TOOLS",
  similes: [
    "SEARCH_SOL_GPT_TOOLS",
    "FIND_CLAWD_TOOLS",
    "SEARCH_TOOLS",
    "LOOKUP_SOLANA_TOOLS",
  ],
  description:
    "Search the ClawdBrowser SOL GPT tools.md catalog by keyword (Phoenix, Imperial, wallet, swap, etc.).",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /search.*(tool|phoenix|imperial|solana|clawd)|find.*(tool|catalog)|what tools|available tools|tool catalog/i.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const catalog = svc.getCatalog();
    if (!catalog) {
      const err = svc.getLastError() || "catalog missing";
      const text = `ClawdBrowser tools unavailable: ${err}`;
      if (callback) await callback({ text, actions: ["SEARCH_CLAWD_TOOLS"] });
      return { success: false, text, error: new Error(err) };
    }

    const query = extractQuery(message.content?.text || "");
    const hits = svc.search(query, 15);
    const body =
      hits.length === 0
        ? `No ClawdBrowser tools matched \`${query}\`. Try: phoenix, imperial, wallet, swap, browser, helius, tracker.`
        : [
            `ClawdBrowser tools matching \`${query}\` (${hits.length}):`,
            ...hits.map(formatToolBrief),
            "",
            `Catalog: ${catalog.totalTools} tools · source ${catalog.sourcePath}`,
          ].join("\n");

    if (callback) {
      await callback({ text: body, actions: ["SEARCH_CLAWD_TOOLS"] });
    }
    return {
      success: true,
      text: body,
      data: { query, hits, total: catalog.totalTools },
      values: { lastClawdToolSearch: query, hitCount: hits.length },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Search clawd tools for phoenix funding" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Searching ClawdBrowser catalog for phoenix funding…",
          actions: ["SEARCH_CLAWD_TOOLS"],
        },
      },
    ],
  ],
};
