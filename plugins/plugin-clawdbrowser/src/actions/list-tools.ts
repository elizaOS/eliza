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

function extractGroup(text: string): string | undefined {
  const m = text.match(
    /(?:list|show)\s+(?:clawd\s*)?(?:browser\s*)?tools?(?:\s+in\s+|\s+for\s+|\s+group\s+)([a-zA-Z0-9_\-\s]+)/i,
  );
  return m?.[1]?.trim();
}

export const listClawdToolsAction: Action = {
  name: "LIST_CLAWD_TOOLS",
  similes: ["LIST_SOL_GPT_TOOLS", "SHOW_CLAWD_TOOLS", "CLAWD_TOOL_GROUPS"],
  description:
    "List ClawdBrowser tool groups or tools in a group (phoenix, imperial, market, wallet, trading, browser, …).",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /list\s+(clawd\s*)?(browser\s*)?tools|show\s+tool\s+groups|tool groups|catalog groups/i.test(
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
      if (callback) await callback({ text, actions: ["LIST_CLAWD_TOOLS"] });
      return { success: false, text, error: new Error(err) };
    }

    const group = extractGroup(message.content?.text || "");
    let body: string;
    if (!group) {
      body = [
        `ClawdBrowser catalog — **${catalog.totalTools}** tools (${catalog.coreCount} core)`,
        ...catalog.groups.map(
          (g) =>
            `• **${g.name}** (\`${g.id}\`) — ${g.tools.length} tools${g.blurb ? `: ${g.blurb}` : ""}`,
        ),
        "",
        "List a group: “list clawd tools in phoenix”",
        `Source: ${catalog.sourcePath}`,
      ].join("\n");
    } else {
      const tools = svc.listGroup(group);
      if (tools.length === 0) {
        body = `No tools in group \`${group}\`. Groups: ${catalog.groups.map((g) => g.id).join(", ")}`;
      } else {
        body = [
          `ClawdBrowser tools in **${group}** (${tools.length}):`,
          ...tools.slice(0, 40).map(formatToolBrief),
          tools.length > 40 ? `…and ${tools.length - 40} more` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }

    if (callback) await callback({ text: body, actions: ["LIST_CLAWD_TOOLS"] });
    return {
      success: true,
      text: body,
      data: { group: group || null, total: catalog.totalTools },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "List clawd browser tool groups" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Listing ClawdBrowser tool groups…",
          actions: ["LIST_CLAWD_TOOLS"],
        },
      },
    ],
  ],
};
