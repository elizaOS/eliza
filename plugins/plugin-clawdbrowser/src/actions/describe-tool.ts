import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
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

function extractToolName(text: string): string | null {
  const fenced = text.match(/`([a-zA-Z][a-zA-Z0-9_]*)`/);
  if (fenced?.[1]) return fenced[1];
  const m = text.match(
    /(?:describe|explain|what is|docs? for)\s+(?:tool\s+)?([a-zA-Z][a-zA-Z0-9_]*)/i,
  );
  if (m?.[1] && !/^(tool|the|a|an)$/i.test(m[1])) return m[1];
  // bare snake_case token
  const bare = text.match(/\b([a-z]+_[a-z0-9_]+)\b/);
  return bare?.[1] || null;
}

export const describeClawdToolAction: Action = {
  name: "DESCRIBE_CLAWD_TOOL",
  similes: ["EXPLAIN_CLAWD_TOOL", "CLAWD_TOOL_DOCS", "SOL_GPT_TOOL_INFO"],
  description:
    "Describe one ClawdBrowser / SOL GPT tool from tools.md (name, group, core flag, description).",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /describe\s+(tool\s+)?[a-z_]+|what is\s+[a-z]+_|explain\s+`?[a-z]+_/i.test(
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
      if (callback) await callback({ text, actions: ["DESCRIBE_CLAWD_TOOL"] });
      return { success: false, text, error: new Error(err) };
    }

    const name = extractToolName(message.content?.text || "");
    if (!name) {
      const text =
        "Name a tool to describe (e.g. describe tool `get_phoenix_mark_price`).";
      if (callback) await callback({ text, actions: ["DESCRIBE_CLAWD_TOOL"] });
      return { success: false, text };
    }

    const tool = svc.describe(name);
    if (!tool) {
      const text = `No tool named \`${name}\` in ClawdBrowser catalog (${catalog.totalTools} tools). Try SEARCH_CLAWD_TOOLS.`;
      if (callback) await callback({ text, actions: ["DESCRIBE_CLAWD_TOOL"] });
      return { success: false, text };
    }

    const body = [
      `### \`${tool.name}\``,
      `- **Group:** ${tool.group} (\`${tool.groupId}\`)`,
      `- **Core (Kimi first-turn):** ${tool.core ? "yes" : "no"}`,
      `- **Description:** ${tool.description}`,
      "",
      "Execution model: research tools return JSON; `prepare_*` live tools are user-signed only (no server hot wallet).",
    ].join("\n");

    if (callback) {
      await callback({ text: body, actions: ["DESCRIBE_CLAWD_TOOL"] });
    }
    return {
      success: true,
      text: body,
      data: { tool },
      values: { lastDescribedClawdTool: tool.name },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Describe tool get_phoenix_mark_price" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Looking up get_phoenix_mark_price in ClawdBrowser tools.md…",
          actions: ["DESCRIBE_CLAWD_TOOL"],
        },
      },
    ],
  ],
};
