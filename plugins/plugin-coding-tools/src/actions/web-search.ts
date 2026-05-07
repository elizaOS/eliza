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

const ACTION_NAME = "CODE_WEB_SEARCH";

function asStringArray(value: unknown[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

export const webSearchAction: Action = {
  name: ACTION_NAME,
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["CODING_WEB_SEARCH", "DEV_WEB_SEARCH", "CODE_SEARCH_WEB"],
  description:
    "Run a coding-agent web search request. This plugin reports query and domain filters when no search provider is configured; use the global WEB_SEARCH action for hosted generic web search when that plugin is available.",
  descriptionCompressed:
    "Coding web search request; reports query + filters when no provider is configured.",
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
      }, {
        actionName: ACTION_NAME,
        reason: "missing_query",
      });
    }

    const allowedDomains = asStringArray(
      readArrayParam(options, "allowed_domains"),
    );
    const blockedDomains = asStringArray(
      readArrayParam(options, "blocked_domains"),
    );

    const text = `${ACTION_NAME} not configured (no provider). Query: "${query}". Use WEB_SEARCH for hosted generic web search when available.`;

    const data: Record<string, unknown> = {
      actionName: ACTION_NAME,
      stub: true,
      query,
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
    };

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, data);
  },
};
