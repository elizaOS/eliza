import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { type ActionWithParams, defineActionParameters } from "../../plugin-cloud-bootstrap/types";
import type { McpService } from "../service";
import { MCP_SERVICE_NAME } from "../types";
import { createMcpToolAction } from "./dynamic-tool-actions";

// ─── SEARCH_ACTIONS ─────────────────────────────────────────────────────────

const MCP_CONTEXTS = ["connectors", "automation", "documents"];
const SEARCH_ACTION_KEYWORDS = [
  "search",
  "find",
  "discover",
  "tool",
  "action",
  "capability",
  "connect",
  "integration",
  "platform",
  "buscar",
  "encontrar",
  "descubrir",
  "herramienta",
  "accion",
  "integracion",
  "chercher",
  "trouver",
  "decouvrir",
  "outil",
  "action",
  "integration",
  "suchen",
  "finden",
  "entdecken",
  "werkzeug",
  "aktion",
  "integration",
  "cercare",
  "trovare",
  "scoprire",
  "strumento",
  "azione",
  "integrazione",
  "pesquisar",
  "encontrar",
  "descobrir",
  "ferramenta",
  "acao",
  "integracao",
  "搜索",
  "查找",
  "工具",
  "操作",
  "集成",
  "検索",
  "探す",
  "ツール",
  "アクション",
  "連携",
];

function hasSelectedContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => MCP_CONTEXTS.includes(String(context).toLowerCase()));
}

function collectText(message: Memory, state?: State): string {
  return [message.content?.text, state?.values?.conversationLog, state?.values?.recentMessages]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

export const searchActionsAction: ActionWithParams = {
  name: "SEARCH_ACTIONS",
  contexts: MCP_CONTEXTS,
  contextGate: { anyOf: MCP_CONTEXTS },
  roleGate: { minRole: "ADMIN" },
  description:
    "Search for additional tool actions not shown in your current toolset. " +
    "Uses BM25 keyword matching against action names and descriptions across all connected platforms. " +
    "IMPORTANT: Use specific verbs and nouns from the user's request as the query. " +
    "Good queries: 'list pull requests', 'send email', 'create calendar event'. " +
    "Bad queries: 'search tools', 'find actions', 'capabilities'. " +
    "If the user's request is vague, search for the platform name (e.g., 'linear', 'github').",
  similes: [
    "FIND_ACTIONS",
    "DISCOVER_ACTIONS",
    "SEARCH_TOOLS",
    "FIND_TOOLS",
    "DISCOVER_TOOLS",
    "LOOKUP_ACTIONS",
  ],
  parameters: defineActionParameters({
    query: {
      type: "string",
      description:
        "Keyword search query matched against action names and descriptions. " +
        "Use specific verbs and nouns (e.g., 'create calendar event', 'list pull requests', 'send email').",
      required: true,
    },
    platform: {
      type: "string",
      description: "Filter results to a single connected platform. Omit to search all.",
      required: false,
      enum: [
        "google",
        "github",
        "linear",
        "notion",
        "jira",
        "asana",
        "airtable",
        "salesforce",
        "dropbox",
        "microsoft",
        "zoom",
        "linkedin",
        "twitter",
      ],
    },
    limit: {
      type: "number",
      description: "Maximum results to return (default 10, max 20).",
      required: false,
      default: 10,
    },
    offset: {
      type: "number",
      description:
        "Skip first N results for pagination when initial search didn't find what you need.",
      required: false,
      default: 0,
    },
  }),

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!svc) return false;

    const text = collectText(message, state);
    return (
      hasSelectedContext(state) || SEARCH_ACTION_KEYWORDS.some((keyword) => text.includes(keyword))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!svc) {
      return { success: false, error: "MCP service not available" };
    }

    const content = message.content as Record<string, unknown>;
    const params =
      (content.actionParams as Record<string, unknown>) ||
      (content.actionInput as Record<string, unknown>) ||
      (state?.data?.actionParams as Record<string, unknown>) ||
      {};

    const query = (params.query as string) || (content.text as string) || "";
    const platform = (params.platform as string) || undefined;
    const rawLimit = Number(params.limit) || 10;
    const limit = Math.min(Math.max(rawLimit, 1), 20);
    const offset = Math.max(Number(params.offset) || 0, 0);

    if (!query.trim()) {
      return { success: false, error: "A search query is required" };
    }

    const tier2Index = svc.getTier2Index();
    const results = tier2Index.search(query, platform, limit, offset);

    if (results.length === 0) {
      return {
        success: true,
        text: platform
          ? `No actions found matching "${query}" for platform "${platform}".`
          : `No actions found matching "${query}".`,
        data: {
          query,
          platform,
          offset,
          resultCount: 0,
          totalAvailable: tier2Index.getToolCount(),
        },
      };
    }

    // Register discovered actions on the runtime (skip already-registered).
    const existingNames = new Set(runtime.actions.map((a) => a.name));
    const newlyRegistered: string[] = [];
    const alreadyRegistered: string[] = [];
    // Track original tier-2 names for removal (before collision adjustment)
    const promotedTier2Names: string[] = [];

    for (const entry of results) {
      if (existingNames.has(entry.actionName)) {
        alreadyRegistered.push(entry.actionName);
        continue;
      }
      if (runtime.actions.some((a) => a.name === entry.actionName)) {
        existingNames.add(entry.actionName);
        alreadyRegistered.push(entry.actionName);
        continue;
      }
      const action = createMcpToolAction(entry.serverName, entry.tool, existingNames);
      runtime.registerAction(action as unknown as Action);
      existingNames.add(String(action.name));
      newlyRegistered.push(String(action.name));
      // Use the original tier-2 actionName (not collision-adjusted) for removal
      promotedTier2Names.push(entry.actionName);
    }

    // Remove promoted actions from both Tier-2 source array and BM25 index
    // so discoverableToolCount stays accurate and reconnect doesn't restore them.
    // Uses original tier-2 names, not collision-adjusted registered names.
    if (promotedTier2Names.length > 0) {
      svc.removeFromTier2(promotedTier2Names);
    }

    // Transparent: no callback — results appear as new actions in next iteration's Available Actions
    const text = `Registered ${newlyRegistered.length} new action(s) for "${query}". They are now callable.`;

    return {
      success: true,
      text,
      data: {
        query,
        platform,
        offset,
        resultCount: results.length,
        totalAvailable: tier2Index.getToolCount(),
        newlyRegistered,
        alreadyRegistered,
        actions: results.map((r) => ({
          name: r.actionName,
          serverName: r.serverName,
          toolName: r.toolName,
          platform: r.platform,
          description: r.tool.description,
        })),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Search for email-related actions" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll search for email-related actions.",
          actions: ["SEARCH_ACTIONS"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Find actions for creating Linear issues" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "Let me search for Linear issue actions.",
          actions: ["SEARCH_ACTIONS"],
        },
      },
    ],
  ],
};

// ─── LIST_CONNECTIONS ───────────────────────────────────────────────────────

export const listConnectionsAction: Action = {
  name: "LIST_CONNECTIONS",
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  roleGate: { minRole: "ADMIN" },
  description:
    "List OAuth connections for the current organization. " +
    "Shows connected platforms, status, email, scopes, and linked date. " +
    "Optionally filter by platform name.",
  similes: [
    "SHOW_CONNECTIONS",
    "GET_CONNECTIONS",
    "OAUTH_CONNECTIONS",
    "MY_CONNECTIONS",
    "CONNECTED_SERVICES",
  ],
  parameters: defineActionParameters({
    platform: {
      type: "string",
      description: "Optional connected platform to filter by.",
      required: false,
    },
  }),

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Requires authenticated org context (set immutably by RuntimeFactory)
    const orgId = runtime.getSetting("ORGANIZATION_ID") as string | undefined;
    if (!orgId) return false;
    const text = collectText(message, state);
    const connectionKeywords = [
      "connection",
      "connected",
      "oauth",
      "account",
      "service",
      "integration",
      "platform",
      "conexion",
      "conectado",
      "cuenta",
      "servicio",
      "connexion",
      "connecte",
      "compte",
      "service",
      "verbindung",
      "verbunden",
      "konto",
      "dienst",
      "connessione",
      "collegato",
      "account",
      "servizio",
      "conexao",
      "conectado",
      "conta",
      "servico",
      "连接",
      "账户",
      "服务",
      "接続",
      "アカウント",
      "サービス",
    ];
    return (
      hasSelectedContext(state) || connectionKeywords.some((keyword) => text.includes(keyword))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const orgId = runtime.getSetting("ORGANIZATION_ID") as string | undefined;
    if (!orgId) {
      return { success: false, error: "No organization context available" };
    }

    const content = message.content as Record<string, unknown>;
    const params =
      (content.actionParams as Record<string, unknown>) ||
      (content.actionInput as Record<string, unknown>) ||
      (state?.data?.actionParams as Record<string, unknown>) ||
      {};
    const platform = (params.platform as string) || undefined;

    let connections: Array<{
      platform: string;
      status: string;
      email?: string;
      scopes: string[];
      linkedAt: Date;
    }>;

    try {
      const { oauthService } = await import("../../../services/oauth");
      connections = await oauthService.listConnections({
        organizationId: orgId,
        platform,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ error: msg }, "[LIST_CONNECTIONS] Failed to fetch connections");
      if (msg.includes("Cannot find module")) {
        return { success: false, error: "OAuth service not available" };
      }
      return { success: false, error: "Failed to fetch OAuth connections" };
    }

    if (connections.length === 0) {
      const text = platform
        ? `No connections found for platform "${platform}".`
        : "No OAuth connections found.";
      if (callback) await callback({ text });
      return { success: true, text, data: { connectionCount: 0, platform } };
    }

    const lines: string[] = [`Found ${connections.length} connection(s):\n`];
    for (const conn of connections) {
      const email = conn.email ? ` (${conn.email})` : "";
      const linked = conn.linkedAt.toISOString().split("T")[0];
      lines.push(`- **${conn.platform}**${email} — Status: ${conn.status}`);
      lines.push(`  Connected: ${linked}`);
    }

    const text = lines.join("\n");
    if (callback) await callback({ text });

    return {
      success: true,
      text,
      data: {
        platform,
        connectionCount: connections.length,
        platforms: [...new Set(connections.map((c) => c.platform))],
        hasActive: connections.some((c) => c.status === "active"),
      },
    };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "What services are connected?" } },
      {
        name: "{{assistant}}",
        content: {
          text: "Let me check your connected services.",
          actions: ["LIST_CONNECTIONS"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Show my Google connections" } },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll look up your Google connections.",
          actions: ["LIST_CONNECTIONS"],
        },
      },
    ],
  ],
};
