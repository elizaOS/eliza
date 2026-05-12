/**
 * GET /api/mcp/list — Lists all available MCP server definitions.
 */

import { Hono } from "hono";

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
    pricing: { type: "credits", description: "Pay-per-use with credits" },
    tools: [
      {
        name: "check_credits",
        description: "Check credit balance and recent transactions for your organization",
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
        description: "Get recent API usage statistics including models used, costs, and tokens",
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
            options: ["gpt-4o", "gpt-5-mini", "claude-sonnet-4-6", "gemini-2.0-flash-exp"],
            optional: true,
            default: "gpt-4o",
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
        cost: "$0.0001-$0.01",
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
        cost: "50 credits",
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
        cost: "Usage-based credits",
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
        cost: "Usage-based credits",
      },
      {
        name: "browser_session",
        description:
          "Create, inspect, and control hosted browser sessions through Eliza Cloud. Supports session listing, navigation, screenshots, and structured browser commands.",
        parameters: {
          operation: {
            type: "enum",
            options: ["list", "create", "get", "delete", "navigate", "snapshot", "command"],
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
        cost: "Usage-based credits",
      },
      {
        name: "save_memory",
        description:
          "Save important information to long-term memory with semantic tagging. Deducts 1 credit per save.",
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
        cost: "1 credit",
      },
      {
        name: "retrieve_memories",
        description:
          "Search and retrieve memories using semantic search or filters. Deducts 0.1 credit per memory retrieved (max 5 credits).",
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
        cost: "0.1-5 credits",
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
        cost: "$0.0001-$0.01",
      },
      {
        name: "list_agents",
        description: "List all available agents, characters, and deployed elizaOS instances.",
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
    pricing: {
      type: "credits",
      description: "1 credit per request",
      creditsPerRequest: 1,
    },
    tools: [
      {
        name: "get_current_time",
        description: "Get current date and time in any timezone",
        cost: "1 credit",
      },
      {
        name: "convert_timezone",
        description: "Convert times between timezones",
        cost: "1 credit",
      },
      {
        name: "format_date",
        description: "Format dates in various locales and styles",
        cost: "1 credit",
      },
      {
        name: "calculate_time_diff",
        description: "Calculate difference between two dates",
        cost: "1 credit",
      },
      {
        name: "list_timezones",
        description: "List common timezones with current offsets",
        cost: "1 credit",
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
    pricing: {
      type: "credits",
      description: "1-2 credits per request",
      creditsPerRequest: "1-2",
    },
    tools: [
      {
        name: "get_current_weather",
        description: "Get current weather conditions for any city",
        cost: "1 credit",
      },
      {
        name: "get_weather_forecast",
        description: "Get multi-day forecast (up to 16 days)",
        cost: "2 credits",
      },
      {
        name: "compare_weather",
        description: "Compare weather between multiple cities",
        cost: "2 credits",
      },
      {
        name: "search_location",
        description: "Search for location coordinates and timezone",
        cost: "1 credit",
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
    pricing: {
      type: "free",
      description: "Free",
      creditsPerRequest: 0,
    },
    tools: [
      {
        name: "get_price",
        description: "Get current price for any cryptocurrency",
        cost: "Free",
      },
      {
        name: "get_market_data",
        description: "Get comprehensive market data including price, volume, supply, ATH/ATL",
        cost: "Free",
      },
      {
        name: "list_trending",
        description: "Get list of trending cryptocurrencies by search popularity",
        cost: "Free",
      },
    ],
  },
];

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    mcps: mcpDefinitions,
    total: mcpDefinitions.length,
    categories: ["platform", "utilities", "data", "finance"],
  }),
);

export default app;
