import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { McpService } from "../service";
import { MCP_SERVICE_NAME, type McpServer } from "../types";
import { callToolAction } from "./callToolAction";
import { readResourceAction } from "./readResourceAction";

export const MCP_ACTION_CONTEXT = "mcp";

type RouterAction = Action & {
  actionGroup?: {
    contexts?: string[];
  };
};

type McpRoute = {
  operation: "tool" | "resource";
  action: Action;
  match: RegExp;
};

const routes: McpRoute[] = [
  {
    operation: "resource",
    action: readResourceAction,
    match: /\b(read|get|fetch|access|open|list)\b.*\b(resource|resources|document|docs?|file)\b/i,
  },
  {
    operation: "tool",
    action: callToolAction,
    match: /\b(call|use|run|execute|invoke|search|query)\b.*\b(tool|tools|mcp)\b/i,
  },
];

function textOf(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function readOptions(options?: HandlerOptions | Record<string, unknown>): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeOperation(value: unknown): McpRoute["operation"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "tool" || normalized === "resource" ? normalized : null;
}

function selectRoute(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): McpRoute | null {
  const requested = normalizeOperation(readOptions(options).operation);
  if (requested) {
    return routes.find((route) => route.operation === requested) ?? null;
  }

  const text = textOf(message);
  return routes.find((route) => route.match.test(text)) ?? null;
}

function hasConnectedCapability(runtime: IAgentRuntime): boolean {
  const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!mcpService) return false;
  return mcpService.getServers().some((server: McpServer) => {
    if (server.status !== "connected") return false;
    return (server.tools?.length ?? 0) > 0 || (server.resources?.length ?? 0) > 0;
  });
}

export function getMcpRouteForTest(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): string | null {
  return selectRoute(message, options)?.operation ?? null;
}

export const mcpRouterAction: RouterAction = {
  name: "MCP_ACTION",
  similes: ["MCP", "MCP_ROUTER", "USE_MCP"],
  description: "Route MCP tool calls and resource reads through one action.",
  descriptionCompressed: "route MCP tool call resource read list",
  contexts: ["general", "automation", "knowledge", "connectors", MCP_ACTION_CONTEXT],
  contextGate: { anyOf: ["general", "automation", "knowledge", "connectors", MCP_ACTION_CONTEXT] },
  roleGate: { minRole: "USER" },
  actionGroup: { contexts: ["connectors", MCP_ACTION_CONTEXT] },

  validate: async (runtime, message) => {
    if (!hasConnectedCapability(runtime)) return false;
    return /\b(mcp|tool|tools|resource|resources|server|servers)\b/i.test(textOf(message));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const route = selectRoute(message, options);
    if (!route) {
      const text = "MCP_ACTION requires operation: tool or operation: resource.";
      await callback?.({ text, source: message.content?.source });
      return {
        success: false,
        text,
        values: { error: "MISSING_OPERATION" },
        data: { actionName: "MCP_ACTION" },
      };
    }

    const result =
      (await route.action.handler(runtime, message, state, options as HandlerOptions, callback)) ??
      ({ success: true } as ActionResult);
    return {
      ...result,
      data: {
        ...(typeof result.data === "object" && result.data ? result.data : {}),
        actionName: "MCP_ACTION",
        routedActionName: route.action.name,
        operation: route.operation,
      },
    };
  },

  parameters: [
    {
      name: "operation",
      description: "MCP operation to run.",
      required: false,
      schema: { type: "string", enum: ["tool", "resource"] },
    },
  ],

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Use the MCP GitHub tool to read the repository README" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll use the matching MCP capability for that request.",
          actions: ["MCP_ACTION"],
        },
      },
    ],
  ],
};
