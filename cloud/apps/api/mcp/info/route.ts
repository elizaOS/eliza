/**
 * GET /api/mcp/info
 * Metadata endpoint for the Eliza Cloud MCP server.
 * Returns information about available tools, pricing, and features.
 * This endpoint does not require authentication.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const tools = [
  {
    name: "check_credits",
    description: "Check your credit balance and recent transactions",
    category: "billing",
  },
  { name: "get_recent_usage", description: "Get recent API usage statistics", category: "billing" },
  {
    name: "list_credit_transactions",
    description: "List credit transaction history",
    category: "billing",
  },
  { name: "generate_text", description: "Generate text using AI models", category: "generation" },
  {
    name: "generate_image",
    description: "Generate images using AI models",
    category: "generation",
  },
  { name: "generate_embeddings", description: "Generate text embeddings", category: "generation" },
  {
    name: "search_web",
    description: "Search the web with hosted Google-grounded Gemini search",
    category: "tools",
  },
  {
    name: "extract_page",
    description: "Extract page content through the hosted Firecrawl extract API",
    category: "tools",
  },
  {
    name: "browser_session",
    description: "Create, inspect, and control hosted browser sessions",
    category: "tools",
  },
  { name: "save_memory", description: "Save a memory for later retrieval", category: "memory" },
  { name: "retrieve_memories", description: "Retrieve relevant memories", category: "memory" },
  { name: "delete_memory", description: "Delete a specific memory", category: "memory" },
  {
    name: "create_conversation",
    description: "Create a new conversation",
    category: "conversations",
  },
  {
    name: "get_conversation_context",
    description: "Get context from a conversation",
    category: "conversations",
  },
  {
    name: "search_conversations",
    description: "Search through conversations",
    category: "conversations",
  },
  { name: "list_agents", description: "List available agents", category: "agents" },
  { name: "chat_with_agent", description: "Chat with a specific agent", category: "agents" },
  { name: "create_agent", description: "Create a new agent", category: "agents" },
  { name: "list_containers", description: "List deployed containers", category: "containers" },
  {
    name: "get_container_health",
    description: "Check container health status",
    category: "containers",
  },
  { name: "list_models", description: "List available AI models", category: "models" },
  { name: "text_to_speech", description: "Convert text to speech audio", category: "audio" },
  { name: "list_voices", description: "List available voices for TTS", category: "audio" },
] as const;

const categories = [...new Set(tools.map((tool) => tool.category))];

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    name: "Eliza Cloud MCP",
    version: "1.0.0",
    description:
      "Full access to Eliza Cloud features including credits management, AI generation, hosted search and browser tools, conversation management, agent operations, and more.",
    transport: ["streamable-http"],
    endpoint: "/api/mcp",
    authRequired: true,
    tools,
    toolCount: tools.length,
    categories,
    pricing: {
      type: "credits",
      description: "Uses your organization's credit balance",
      rates: {
        generate_text: "Varies by model and tokens",
        generate_image: "Fixed cost per image",
        search_web: "Usage-based credits",
        extract_page: "Usage-based credits",
        browser_session: "Usage-based credits",
        save_memory: "0.0001 credits",
        retrieve_memories: "0.0001 - 0.001 credits",
      },
    },
    authentication: {
      type: "Bearer",
      header: "Authorization",
      description: "Requires API key in Authorization header: Bearer YOUR_API_KEY",
    },
    status: "live",
  }),
);

export default app;
