/**
 * GET /api/mcp/list — Lists the MCP server definitions the deployment can
 * actually serve, annotated with trust, health, and availability from the
 * integration catalog policy. Kill-switched entries are listed as disabled
 * with tools withheld; unconfigured entries are not advertised.
 */

import {
  BUILTIN_MCP_PRICING,
  MCP_FREE_COST_LABEL,
  MCP_USAGE_BASED_COST_LABEL,
  PLATFORM_MCP_TOOL_PRICING,
} from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";

import {
  INTEGRATION_TRUST,
  integrationHealth,
  plannerVisibleFeatures,
  resolveIntegrationAvailability,
} from "@/api-app/lib/mcp/integration-catalog";
import type { AppEnv } from "@/types/cloud-worker-env";

// MCP definitions with their tools and schemas
const mcpDefinitions = [
  {
    id: "eliza-cloud-mcp",
    name: "Eliza Cloud MCP",
    description:
      "Core Eliza Cloud platform MCP with credit management, AI generation, hosted tools, memory, conversations, and agent interaction capabilities",
    version: "1.0.0",
    endpoint: "/api/mcp",
    category: "platform",
    status: "live",
    x402Enabled: false,
    pricing: {
      type: "credits",
      description: "Pay per use in USD-denominated cloud credits",
      creditUnit: "USD",
    },
    tools: [
      {
        name: "check_credits",
        description:
          "Check credit balance and recent transactions for your organization",
        parameters: {
          includeTransactions: {
            type: "boolean",
            optional: true,
            description: "Include recent transactions in the response",
          },
          limit: {
            type: "number",
            optional: true,
            default: 5,
            description: "Number of recent transactions to include",
            min: 1,
            max: 20,
          },
        },
        cost: "FREE",
      },
      {
        name: "get_recent_usage",
        description:
          "Get recent API usage statistics including models used, costs, and tokens",
        parameters: {
          limit: {
            type: "number",
            optional: true,
            default: 10,
            description: "Number of recent usage records to fetch",
            min: 1,
            max: 50,
          },
        },
        cost: "FREE",
      },
      {
        name: "generate_text",
        description:
          "Generate text using AI models (GPT-4, Claude, Gemini). Deducts credits based on token usage.",
        parameters: {
          prompt: {
            type: "string",
            description: "The text prompt to generate from",
            min: 1,
            max: 10000,
          },
          model: {
            type: "enum",
            options: [
              "gemma-4-31b",
              "gpt-5-mini",
              "claude-sonnet-5",
              "gemini-2.0-flash-001",
            ],
            optional: true,
            default: "gemma-4-31b",
            description: "The AI model to use for generation",
          },
          maxLength: {
            type: "number",
            optional: true,
            default: 1000,
            description: "Maximum length of generated text",
            min: 1,
            max: 4000,
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "generate_image",
        description:
          "Generate images using Google Gemini 2.5. Deducts credits per image generated.",
        parameters: {
          prompt: {
            type: "string",
            description: "Description of the image to generate",
            min: 1,
            max: 5000,
          },
          aspectRatio: {
            type: "enum",
            options: ["1:1", "16:9", "9:16", "4:3", "3:4"],
            optional: true,
            default: "1:1",
            description: "Aspect ratio for the generated image",
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "search_web",
        description:
          "Search the web using hosted Google Search grounding via Gemini. Returns a grounded answer, citations, and search metadata.",
        parameters: {
          query: {
            type: "string",
            description: "What to search for",
            min: 1,
            max: 2000,
          },
          maxResults: {
            type: "number",
            optional: true,
            default: 5,
            description: "Maximum number of cited results to return",
            min: 1,
            max: 10,
          },
          source: {
            type: "string",
            optional: true,
            description: "Preferred source domain, e.g. reuters.com",
          },
          topic: {
            type: "enum",
            options: ["general", "finance"],
            optional: true,
            description: "Use finance for market and crypto queries",
          },
          timeRange: {
            type: "enum",
            options: ["day", "week", "month", "year", "d", "w", "m", "y"],
            optional: true,
            description: "Prefer sources from a recent time window",
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "extract_page",
        description:
          "Extract page content through the hosted Firecrawl extract API. Returns cleaned markdown plus optional HTML, links, screenshot data, and metadata.",
        parameters: {
          url: {
            type: "string",
            description: "Page URL to extract",
            min: 1,
            max: 2000,
          },
          formats: {
            type: "array",
            optional: true,
            description: "Requested output formats",
          },
          onlyMainContent: {
            type: "boolean",
            optional: true,
            default: true,
            description: "Prefer primary page content only",
          },
          waitFor: {
            type: "number",
            optional: true,
            description: "Wait time before extracting, in milliseconds",
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "browser_session",
        description:
          "Create, inspect, and control hosted browser sessions through Eliza Cloud. Supports session listing, navigation, screenshots, and structured browser commands.",
        parameters: {
          operation: {
            type: "enum",
            options: [
              "list",
              "create",
              "get",
              "delete",
              "navigate",
              "snapshot",
              "command",
            ],
            description: "Browser operation to perform",
          },
          sessionId: {
            type: "string",
            optional: true,
            description: "Session id for get/delete/navigate/snapshot/command",
          },
          url: {
            type: "string",
            optional: true,
            description: "Initial or navigation URL",
          },
          subaction: {
            type: "enum",
            options: [
              "back",
              "click",
              "eval",
              "forward",
              "get",
              "navigate",
              "press",
              "reload",
              "scroll",
              "state",
              "type",
              "wait",
            ],
            optional: true,
            description: "Browser command subaction for command operation",
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "save_memory",
        description: `Save important information to long-term memory with semantic tagging. Deducts ${PLATFORM_MCP_TOOL_PRICING.save_memory.label} per save.`,
        parameters: {
          content: {
            type: "string",
            description: "The memory content to save",
            min: 1,
            max: 10000,
          },
          type: {
            type: "enum",
            options: ["fact", "preference", "context", "document"],
            description: "Type of memory being saved",
          },
          roomId: {
            type: "string",
            description: "Room ID to associate memory with (required)",
          },
          tags: {
            type: "array",
            optional: true,
            description: "Optional tags for categorization",
          },
        },
        cost: PLATFORM_MCP_TOOL_PRICING.save_memory.label,
      },
      {
        name: "retrieve_memories",
        description:
          "Search and retrieve memories using semantic search or filters. This read operation is free.",
        parameters: {
          query: {
            type: "string",
            optional: true,
            description: "Semantic search query",
          },
          roomId: {
            type: "string",
            optional: true,
            description: "Filter to specific room/conversation",
          },
          limit: {
            type: "number",
            optional: true,
            default: 10,
            description: "Maximum results to return",
            min: 1,
            max: 50,
          },
        },
        cost: PLATFORM_MCP_TOOL_PRICING.retrieve_memories.label,
      },
      {
        name: "chat_with_agent",
        description:
          "Send a message to your deployed elizaOS agent and receive a response. Supports streaming via SSE.",
        parameters: {
          message: {
            type: "string",
            description: "Message to send to the agent",
            min: 1,
            max: 4000,
          },
          roomId: {
            type: "string",
            optional: true,
            description: "Existing conversation room ID",
          },
          streaming: {
            type: "boolean",
            optional: true,
            default: false,
            description: "Enable streaming response via SSE",
          },
        },
        cost: MCP_USAGE_BASED_COST_LABEL,
      },
      {
        name: "list_agents",
        description:
          "List all available agents, characters, and deployed elizaOS instances.",
        parameters: {
          filters: {
            type: "object",
            optional: true,
            description: "Filter options for deployed/template/owned agents",
          },
          includeStats: {
            type: "boolean",
            optional: true,
            default: false,
            description: "Include agent statistics",
          },
        },
        cost: "FREE",
      },
      {
        name: "list_containers",
        description: "List all deployed containers with status.",
        parameters: {
          status: {
            type: "enum",
            options: ["running", "stopped", "failed", "deploying"],
            optional: true,
            description: "Filter by container status",
          },
          includeMetrics: {
            type: "boolean",
            optional: true,
            default: false,
            description: "Include container metrics",
          },
        },
        cost: "FREE",
      },
    ],
  },
  {
    id: "time-mcp",
    name: "Time & Date MCP",
    description:
      "Get current time, timezone conversions, and date calculations. Perfect for scheduling and time-aware applications.",
    version: "2.0.0",
    endpoint: "/api/mcps/time",
    category: "utilities",
    status: "live",
    x402Enabled: false,
    pricing: BUILTIN_MCP_PRICING.time,
    tools: [
      {
        name: "get_current_time",
        description: "Get current date and time in any timezone",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "convert_timezone",
        description: "Convert times between timezones",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "format_date",
        description: "Format dates in various locales and styles",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "calculate_time_diff",
        description: "Calculate difference between two dates",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "list_timezones",
        description: "List common timezones with current offsets",
        cost: MCP_FREE_COST_LABEL,
      },
    ],
  },
  {
    id: "weather-mcp",
    name: "Weather MCP",
    description:
      "Real-time weather data, forecasts, and location search powered by Open-Meteo API.",
    version: "2.0.0",
    endpoint: "/api/mcps/weather",
    category: "data",
    status: "live",
    x402Enabled: false,
    pricing: BUILTIN_MCP_PRICING.weather,
    tools: [
      {
        name: "get_current_weather",
        description: "Get current weather conditions for any city",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "get_weather_forecast",
        description: "Get multi-day forecast (up to 16 days)",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "compare_weather",
        description: "Compare weather between multiple cities",
        cost: MCP_FREE_COST_LABEL,
      },
      {
        name: "search_location",
        description: "Search for location coordinates and timezone",
        cost: MCP_FREE_COST_LABEL,
      },
    ],
  },
  {
    id: "crypto-mcp",
    name: "Crypto Price MCP",
    description:
      "Real-time cryptocurrency prices, market data, and trending coins powered by CoinGecko API. Free to use.",
    version: "2.0.0",
    endpoint: "/api/mcps/crypto",
    category: "finance",
    status: "live",
    x402Enabled: false,
    pricing: BUILTIN_MCP_PRICING.crypto,
    tools: [
      {
        name: "get_price",
        description: "Get current price for any cryptocurrency",
        cost: "Free",
      },
      {
        name: "get_market_data",
        description:
          "Get comprehensive market data including price, volume, supply, ATH/ATL",
        cost: "Free",
      },
      {
        name: "list_trending",
        description:
          "Get list of trending cryptocurrencies by search popularity",
        cost: "Free",
      },
    ],
  },
];

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  // Availability gates advertising: unconfigured definitions are withheld and
  // kill-switched definitions are listed as disabled with tools hidden. Tool
  // lists are additionally filtered to planner-visible (risk-reviewed)
  // capability names.
  const mcps = [];
  for (const definition of mcpDefinitions) {
    const trust = INTEGRATION_TRUST[definition.id];
    if (trust === undefined) continue;
    const availability = resolveIntegrationAvailability(
      c.env,
      definition.id,
      definition.endpoint,
    );
    if (availability === "unconfigured") continue;
    const disabled = availability === "disabled";
    const visibleNames = new Set(
      plannerVisibleFeatures(
        trust,
        definition.tools.map((tool) => tool.name),
      ),
    );
    mcps.push({
      ...definition,
      availability,
      health: integrationHealth(availability, trust.provenance),
      trust,
      status: disabled ? "disabled" : definition.status,
      tools: disabled
        ? []
        : definition.tools.filter((tool) => visibleNames.has(tool.name)),
    });
  }
  return c.json({
    mcps,
    total: mcps.length,
    categories: ["platform", "utilities", "data", "finance"],
  });
});

export default app;
