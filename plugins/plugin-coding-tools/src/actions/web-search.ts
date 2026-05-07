import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readArrayParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

function asStringArray(value: unknown[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

export const webSearchAction: Action = {
  name: "WEB_SEARCH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["SEARCH_WEB", "GOOGLE", "BING"],
  description:
    "Run a web search and return ranked results. Stub in v1: no provider is wired in this plugin, so the action returns a placeholder success that echoes the query and any domain filters. Wire a Brave/Bing/Tavily backend before relying on this for real results.",
  descriptionCompressed:
    "Web search (stub — no backend configured; echoes query + filters).",
  parameters: [
    {
      name: "query",
      description: "Search query string.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "allowed_domains",
      description: "Optional list of domains to restrict results to.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "blocked_domains",
      description: "Optional list of domains to exclude from results.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    const disable = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (disable === true || disable === "true" || disable === "1") return false;
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const query = readStringParam(options, "query");
    if (!query || query.trim().length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "query is required",
      });
    }

    const allowedDomains = asStringArray(
      readArrayParam(options, "allowed_domains"),
    );
    const blockedDomains = asStringArray(
      readArrayParam(options, "blocked_domains"),
    );

    const text = `WEB_SEARCH not configured (no provider). Query: "${query}". When a provider is wired (Brave/Bing/Tavily), this action will return ranked results.`;

    const data: Record<string, unknown> = {
      stub: true,
      query,
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
    };

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, data);
  },
};
