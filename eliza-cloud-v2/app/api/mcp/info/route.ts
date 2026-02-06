import { NextResponse } from "next/server";

/**
 * GET /api/mcp/info
 * Metadata endpoint for ElizaOS Platform MCP server.
 * Returns information about available tools, pricing, and features.
 * This endpoint does not require authentication.
 *
 * @returns MCP server metadata including tools, pricing, and feature list.
 */
export async function GET() {
  return NextResponse.json({
    name: "ElizaOS Platform MCP",
    version: "1.0.0",
    description:
      "Full access to ElizaOS platform features including credits management, AI generation, conversation management, agent operations, and more.",
    transport: ["http"],
    endpoint: "/api/mcp",
    authRequired: true,
    tools: [
      {
        name: "check_credits",
        description: "Check your credit balance and recent transactions",
        category: "billing",
      },
      {
        name: "get_recent_usage",
        description: "Get recent API usage statistics",
        category: "billing",
      },
      {
        name: "list_credit_transactions",
        description: "List credit transaction history",
        category: "billing",
      },
      {
        name: "generate_text",
        description: "Generate text using AI models",
        category: "generation",
      },
      {
        name: "generate_image",
        description: "Generate images using AI models",
        category: "generation",
      },
      {
        name: "generate_embeddings",
        description: "Generate text embeddings",
        category: "generation",
      },
      {
        name: "save_memory",
        description: "Save a memory for later retrieval",
        category: "memory",
      },
      {
        name: "retrieve_memories",
        description: "Retrieve relevant memories",
        category: "memory",
      },
      {
        name: "delete_memory",
        description: "Delete a specific memory",
        category: "memory",
      },
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
      {
        name: "list_agents",
        description: "List available agents",
        category: "agents",
      },
      {
        name: "chat_with_agent",
        description: "Chat with a specific agent",
        category: "agents",
      },
      {
        name: "create_agent",
        description: "Create a new agent",
        category: "agents",
      },
      {
        name: "list_containers",
        description: "List deployed containers",
        category: "containers",
      },
      {
        name: "get_container_health",
        description: "Check container health status",
        category: "containers",
      },
      {
        name: "list_models",
        description: "List available AI models",
        category: "models",
      },
      {
        name: "text_to_speech",
        description: "Convert text to speech audio",
        category: "audio",
      },
      {
        name: "list_voices",
        description: "List available voices for TTS",
        category: "audio",
      },
    ],
    toolCount: 25,
    categories: [
      "billing",
      "generation",
      "memory",
      "conversations",
      "agents",
      "containers",
      "models",
      "audio",
    ],
    pricing: {
      type: "credits",
      description: "Uses your organization's credit balance",
      rates: {
        generate_text: "Varies by model and tokens",
        generate_image: "Fixed cost per image",
        save_memory: "0.0001 credits",
        retrieve_memories: "0.0001 - 0.001 credits",
      },
    },
    authentication: {
      type: "Bearer",
      header: "Authorization",
      description:
        "Requires API key in Authorization header: Bearer YOUR_API_KEY",
    },
    status: "live",
  });
}
