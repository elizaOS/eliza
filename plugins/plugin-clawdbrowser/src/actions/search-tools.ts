import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { actionFailure, actionSuccess } from "../action-result.js";
import { formatToolBrief } from "../catalog/parse-tools-md.js";
import {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "../services/catalog-service.js";

const ACTION = "SEARCH_CLAWD_TOOLS";

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
  name: ACTION,
  similes: [
    "SEARCH_SOL_GPT_TOOLS",
    "FIND_CLAWD_TOOLS",
    "SEARCH_TOOLS",
    "LOOKUP_SOLANA_TOOLS",
  ],
  description:
    "Search ClawdBrowser tools.md catalog. Chain before DESCRIBE_CLAWD_TOOL — hits stored in actionResults.",
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
    _options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const catalog = svc.getCatalog();
    if (!catalog) {
      const err = svc.getLastError() || "catalog missing";
      const text = `ClawdBrowser tools unavailable: ${err}`;
      if (callback) await callback({ text }, ACTION);
      return actionFailure(ACTION, text);
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

    if (callback) await callback({ text: body }, ACTION);
    return actionSuccess(
      ACTION,
      body,
      {
        query,
        hits: hits.map((h) => ({
          name: h.name,
          groupId: h.groupId,
          core: h.core,
          description: h.description,
        })),
        hitNames: hits.map((h) => h.name),
        total: catalog.totalTools,
      },
      {
        values: { lastClawdToolSearch: query, hitCount: hits.length },
        turnComplete: hits.length === 0,
        verifiedUserFacing: true,
      },
    );
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Search clawd tools for phoenix funding then describe the top one",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Searching catalog, then describing the best match.",
          actions: ["SEARCH_CLAWD_TOOLS", "DESCRIBE_CLAWD_TOOL"],
        },
      },
    ],
  ],
};
