import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  actionFailure,
  actionSuccess,
  getPriorActionResult,
} from "../action-result.js";
import {
  CLAWDBROWSER_SERVICE_TYPE,
  ClawdBrowserCatalogService,
} from "../services/catalog-service.js";

const ACTION = "DESCRIBE_CLAWD_TOOL";

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
  if (m?.[1] && !/^(tool|the|a|an|top|first|best)$/i.test(m[1])) return m[1];
  const bare = text.match(/\b([a-z]+_[a-z0-9_]+)\b/);
  return bare?.[1] || null;
}

export const describeClawdToolAction: Action = {
  name: ACTION,
  similes: ["EXPLAIN_CLAWD_TOOL", "CLAWD_TOOL_DOCS", "SOL_GPT_TOOL_INFO"],
  description:
    "Describe one ClawdBrowser tool. Chains after SEARCH_CLAWD_TOOLS — uses first hit when name omitted (“describe the top one”).",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /describe|explain|what is|top one|first hit|tool docs/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
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

    let name = extractToolName(message.content?.text || "");
    const prior = getPriorActionResult("SEARCH_CLAWD_TOOLS", options, state);
    if (!name && prior?.data) {
      const hitNames = prior.data.hitNames as string[] | undefined;
      if (hitNames?.[0]) name = hitNames[0];
    }

    if (!name) {
      const text =
        "Name a tool to describe (e.g. describe tool `get_phoenix_mark_price`), or chain after SEARCH_CLAWD_TOOLS.";
      if (callback) await callback({ text }, ACTION);
      return actionFailure(ACTION, text);
    }

    const tool = svc.describe(name);
    if (!tool) {
      const text = `No tool named \`${name}\` in ClawdBrowser catalog (${catalog.totalTools} tools). Try SEARCH_CLAWD_TOOLS.`;
      if (callback) await callback({ text }, ACTION);
      return actionFailure(ACTION, text);
    }

    const body = [
      `### \`${tool.name}\``,
      `- **Group:** ${tool.group} (\`${tool.groupId}\`)`,
      `- **Core (Kimi first-turn):** ${tool.core ? "yes" : "no"}`,
      `- **Description:** ${tool.description}`,
      prior ? `- **Chained from:** SEARCH_CLAWD_TOOLS` : "",
      "",
      "Execution model: research tools return JSON; `prepare_*` live tools are user-signed only (no server hot wallet).",
    ]
      .filter(Boolean)
      .join("\n");

    if (callback) await callback({ text: body }, ACTION);
    return actionSuccess(
      ACTION,
      body,
      { tool, chainedFrom: prior ? "SEARCH_CLAWD_TOOLS" : null },
      {
        values: { lastDescribedClawdTool: tool.name },
        turnComplete: true,
        verifiedUserFacing: true,
      },
    );
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
          text: "Looking up get_phoenix_mark_price…",
          actions: ["DESCRIBE_CLAWD_TOOL"],
        },
      },
    ],
  ],
};
