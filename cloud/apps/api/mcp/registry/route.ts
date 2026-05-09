import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

// SECURITY FIX: Validate query parameters to prevent DoS attacks
// Whitelist allowed values and enforce length limits
const queryParamsSchema = z.object({
  category: z
    .enum([
      "all",
      "finance",
      "utilities",
      "platform",
      "search",
      "communication",
      "productivity",
      "data",
      "ai",
    ])
    .optional()
    .default("all")
    .describe("Filter by MCP server category"),
  status: z
    .enum(["all", "live", "coming_soon", "maintenance"])
    .optional()
    .default("all")
    .describe("Filter by server status"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(100)
    .describe("Maximum number of results to return"),
  search: z
    .string()
    .max(100)
    .optional()
    .describe("Search term for filtering by name or description"),
});

/**
 * MCP Server Registry Entry
 * Defines an MCP server that can be enabled on agents
 */
export interface McpRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  endpoint: string;
  type: "streamable-http" | "stdio";
  version: string;
  status: "live" | "coming_soon" | "maintenance";
  icon: string;
  color: string;
  toolCount: number;
  features: string[];
  pricing: {
    type: "free" | "credits" | "x402";
    description: string;
    pricePerRequest?: string;
  };
  x402Enabled: boolean;
  documentation?: string;
  // Config to inject into character settings
  configTemplate: {
    servers: Record<
      string,
      {
        type: "streamable-http" | "stdio";
        url: string;
      }
    >;
  };
}

type BuiltInRegistryEntry = McpRegistryEntry & {
  source: "platform";
  fullEndpoint: string;
};
type UserRegistryEntry = ReturnType<typeof userMcpsService.toRegistryFormat> & {
  source: "community";
  fullEndpoint: string;
};
type RegistryEntry = BuiltInRegistryEntry | UserRegistryEntry;

/**
 * Registry of available MCP servers
 * These can be enabled on agents via their character settings
 */
const MCP_REGISTRY: McpRegistryEntry[] = [
  {
    id: "crypto-prices",
    name: "Crypto Prices",
    description:
      "Real-time cryptocurrency price data from major exchanges. Get current prices, 24h changes, market cap, and volume for thousands of cryptocurrencies.",
    category: "finance",
    endpoint: "/api/mcps/crypto/streamable-http",
    type: "streamable-http",
    version: "2.0.0",
    status: "live",
    icon: "coins",
    color: "#F7931A",
    toolCount: 3,
    features: ["get_price", "get_market_data", "list_trending"],
    pricing: {
      type: "free",
      description: "Free tier available",
    },
    x402Enabled: false,
    documentation: "https://docs.elizaos.ai/mcps/crypto-prices",
    configTemplate: {
      servers: {
        "crypto-prices": {
          type: "streamable-http",
          url: "/api/mcps/crypto/streamable-http",
        },
      },
    },
  },
  {
    id: "time-server",
    name: "Time & Timezone",
    description:
      "Get current time, convert between timezones, and perform date calculations. Perfect for scheduling and time-aware agents.",
    category: "utilities",
    endpoint: "/api/mcps/time/streamable-http",
    type: "streamable-http",
    version: "2.0.0",
    status: "live",
    icon: "clock",
    color: "#6366F1",
    toolCount: 5,
    features: [
      "get_current_time",
      "convert_timezone",
      "format_date",
      "calculate_time_diff",
      "list_timezones",
    ],
    pricing: {
      type: "free",
      description: "Free to use",
    },
    x402Enabled: false,
    documentation: "https://docs.elizaos.ai/mcps/time",
    configTemplate: {
      servers: {
        "time-server": {
          type: "streamable-http",
          url: "/api/mcps/time/streamable-http",
        },
      },
    },
  },
  {
    id: "weather",
    name: "Weather Data",
    description:
      "Current weather conditions and forecasts for locations worldwide. Temperature, humidity, wind, and more.",
    category: "utilities",
    endpoint: "/api/mcps/weather/streamable-http",
    type: "streamable-http",
    version: "2.0.0",
    status: "live",
    icon: "cloud",
    color: "#3B82F6",
    toolCount: 4,
    features: ["get_current_weather", "get_weather_forecast", "compare_weather", "search_location"],
    pricing: {
      type: "credits",
      description: "1-2 credits per request",
      pricePerRequest: "1-2",
    },
    x402Enabled: false,
    configTemplate: {
      servers: {
        weather: {
          type: "streamable-http",
          url: "/api/mcps/weather/streamable-http",
        },
      },
    },
  },
  {
    id: "eliza-platform",
    name: "Eliza Cloud",
    description:
      "Access Eliza Cloud features: credits, usage, hosted search, extraction, browser sessions, generations, conversations, and agent management via MCP. Requires API key authentication.",
    category: "platform",
    endpoint: "/api/mcp",
    type: "streamable-http",
    version: "1.0.0",
    status: "live",
    icon: "puzzle",
    color: "#FF5800",
    toolCount: 29,
    features: [
      "check_credits",
      "get_usage",
      "search_web",
      "extract_page",
      "browser_session",
      "generate_text",
      "generate_image",
      "list_agents",
      "conversation_management",
    ],
    pricing: {
      type: "credits",
      description: "Uses your credit balance (requires API key authentication)",
    },
    x402Enabled: false,
    documentation: "https://docs.elizaos.ai/mcps/platform",
    configTemplate: {
      servers: {
        "eliza-platform": {
          type: "streamable-http",
          url: "${BASE_URL}/api/mcp",
        },
      },
    },
  },
  {
    id: "web-search",
    name: "Web Search",
    description:
      "Search the web and retrieve information from websites. Powered by multiple search providers for comprehensive results.",
    category: "search",
    endpoint: "/api/mcps/search/streamable-http",
    type: "streamable-http",
    version: "1.0.0",
    status: "coming_soon",
    icon: "puzzle",
    color: "#10B981",
    toolCount: 2,
    features: ["search", "fetch_page"],
    pricing: {
      type: "credits",
      description: "0.01 credits per search",
      pricePerRequest: "0.01",
    },
    x402Enabled: false,
    configTemplate: {
      servers: {
        "web-search": {
          type: "streamable-http",
          url: "${BASE_URL}/api/mcps/search/streamable-http",
        },
      },
    },
  },
  {
    id: "linear",
    name: "Linear",
    description:
      "Issue tracking and project management. Create, update, and manage issues, projects, teams, cycles, and labels in your Linear workspace.",
    category: "productivity",
    endpoint: "/api/mcps/linear/streamable-http",
    type: "streamable-http",
    version: "1.0.0",
    status: "live",
    icon: "clipboard-list",
    color: "#5E6AD2",
    toolCount: 27,
    features: [
      "linear_list_issues",
      "linear_create_issue",
      "linear_list_projects",
      "linear_list_teams",
    ],
    pricing: {
      type: "free",
      description: "Requires Linear OAuth connection",
    },
    x402Enabled: false,
    configTemplate: {
      servers: {
        linear: {
          type: "streamable-http",
          url: "${BASE_URL}/api/mcps/linear/streamable-http",
        },
      },
    },
  },
  {
    id: "notion",
    name: "Notion",
    description:
      "Pages, databases, and knowledge management. Search, create, and update pages, blocks, databases, and comments in your Notion workspace.",
    category: "productivity",
    endpoint: "/api/mcps/notion/streamable-http",
    type: "streamable-http",
    version: "1.0.0",
    status: "live",
    icon: "file-text",
    color: "#000000",
    toolCount: 21,
    features: [
      "notion_search",
      "notion_create_page",
      "notion_get_database",
      "notion_query_data_source",
    ],
    pricing: {
      type: "free",
      description: "Requires Notion OAuth connection",
    },
    x402Enabled: false,
    configTemplate: {
      servers: {
        notion: {
          type: "streamable-http",
          url: "${BASE_URL}/api/mcps/notion/streamable-http",
        },
      },
    },
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Repository, issue, and PR management. List repos, create issues, manage pull requests, branches, commits, and files in your GitHub account.",
    category: "productivity",
    endpoint: "/api/mcps/github/streamable-http",
    type: "streamable-http",
    version: "1.0.0",
    status: "live",
    icon: "git-branch",
    color: "#181717",
    toolCount: 45,
    features: ["github_list_repos", "github_create_issue", "github_list_prs", "github_create_pr"],
    pricing: {
      type: "free",
      description: "Requires GitHub OAuth connection",
    },
    x402Enabled: false,
    configTemplate: {
      servers: {
        github: {
          type: "streamable-http",
          url: "${BASE_URL}/api/mcps/github/streamable-http",
        },
      },
    },
  },
];

const app = new Hono<AppEnv>();

const OPTIONAL_REGISTRY_LOOKUP_TIMEOUT_MS = 2_000;

function withRegistryTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `[MCP Registry] ${label} timed out after ${OPTIONAL_REGISTRY_LOOKUP_TIMEOUT_MS}ms`,
          ),
        );
      }, OPTIONAL_REGISTRY_LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

app.get("/", async (c) => {
  try {
    const user = await withRegistryTimeout(getCurrentUser(c), "optional auth lookup").catch(
      (error) => {
        logger.warn("[MCP Registry] Optional auth lookup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      },
    );
    const isAuthenticated = user !== null;

    const baseUrl =
      c.env.NEXT_PUBLIC_APP_URL ||
      (c.req.header("host")
        ? `${c.req.header("x-forwarded-proto") || "https"}://${c.req.header("host")}`
        : "http://localhost:3000");

    const limitRaw = c.req.query("limit");
    const rawParams = {
      category: c.req.query("category") || "all",
      status: c.req.query("status") || "all",
      limit: limitRaw ? parseInt(limitRaw, 10) : 100,
      search: c.req.query("search") || undefined,
    };

    const validationResult = queryParamsSchema.safeParse(rawParams);

    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid query parameters",
          details: validationResult.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
            received: "received" in issue ? issue.received : undefined,
          })),
        },
        400,
      );
    }

    const { category, status, limit, search } = validationResult.data;

    // Process built-in registry entries
    const builtInRegistry: BuiltInRegistryEntry[] = MCP_REGISTRY.map((entry) => ({
      ...entry,
      source: "platform" as const,
      configTemplate: {
        servers: Object.fromEntries(
          Object.entries(entry.configTemplate.servers).map(([key, value]) => [
            key,
            {
              ...value,
              url: value.url.replace("${BASE_URL}", ""),
            },
          ]),
        ),
      },
      fullEndpoint: entry.endpoint.startsWith("http")
        ? entry.endpoint
        : `${baseUrl}${entry.endpoint}`,
    }));

    // Fetch user MCPs (public, live)
    let userMcpRegistry: UserRegistryEntry[] = [];
    try {
      const userMcps = await withRegistryTimeout(
        userMcpsService.listPublic({
          category: category !== "all" ? category : undefined,
          search,
          limit: 50,
        }),
        "community MCP lookup",
      );

      userMcpRegistry = userMcps.map((mcp) => {
        const formatted = userMcpsService.toRegistryFormat(mcp, baseUrl);
        return {
          ...formatted,
          source: "community" as const,
          fullEndpoint: formatted.endpoint,
        };
      });
    } catch (error) {
      // If user MCPs fail to load, continue with built-in only
      logger.warn("[MCP Registry] Failed to load user MCPs", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Combine registries
    const registry: RegistryEntry[] = [...builtInRegistry, ...userMcpRegistry];

    let filteredRegistry = registry;

    // Apply category filter with validated input
    if (category && category !== "all") {
      filteredRegistry = filteredRegistry.filter((e) => e.category === category);
    }

    // Apply status filter with validated input
    if (status && status !== "all") {
      filteredRegistry = filteredRegistry.filter((e) => e.status === status);
    }

    // Apply search filter if provided (case-insensitive)
    if (search && search.trim().length > 0) {
      const searchLower = search.toLowerCase().trim();
      filteredRegistry = filteredRegistry.filter(
        (e) =>
          e.name.toLowerCase().includes(searchLower) ||
          e.description.toLowerCase().includes(searchLower) ||
          e.features.some((f) => f.toLowerCase().includes(searchLower)),
      );
    }

    // Apply limit with validated input
    filteredRegistry = filteredRegistry.slice(0, limit);

    // Get unique categories from the full registry
    const categories = [...new Set(registry.map((e) => e.category))];
    const statuses = [...new Set(registry.map((e) => e.status))];

    return c.json({
      registry: filteredRegistry,
      categories,
      statuses,
      total: filteredRegistry.length,
      totalInRegistry: registry.length,
      platformMcps: builtInRegistry.length,
      communityMcps: userMcpRegistry.length,
      appliedFilters: {
        category: category !== "all" ? category : null,
        status: status !== "all" ? status : null,
        search: search || null,
        limit,
      },
      isAuthenticated,
    });
  } catch (error) {
    logger.error("[MCP Registry] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
