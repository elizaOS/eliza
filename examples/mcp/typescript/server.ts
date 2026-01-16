/**
 * elizaOS MCP Agent Server - TypeScript
 *
 * Exposes an elizaOS agent as an MCP server. Any MCP-compatible client
 * (Claude Desktop, VS Code, etc.) can interact with your agent.
 *
 * Uses real elizaOS runtime with OpenAI and SQL plugins.
 */

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type ListToolsResult,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Tool Argument Types
// ============================================================================

interface ChatToolArgs {
  message: string;
  userId?: string;
}

interface CallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS, accessible via MCP.",
  system:
    "You are a helpful, friendly AI assistant. Be concise and informative.",
});

// ============================================================================
// MCP Tools Definition
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: "chat",
    description: "Send a message to the Eliza agent and receive a response",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message to send to the agent",
        },
        userId: {
          type: "string",
          description: "Optional user identifier for conversation context",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "get_agent_info",
    description: "Get information about the Eliza agent",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ============================================================================
// Agent Runtime
// ============================================================================

let runtime: AgentRuntime | null = null;
const roomId = stringToUuid("mcp-room");
const worldId = stringToUuid("mcp-world");

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;

  console.error("🚀 Initializing elizaOS runtime...");

  runtime = new AgentRuntime({
    character: CHARACTER,
    plugins: [sqlPlugin, openaiPlugin],
  });

  await runtime.initialize();

  console.error("✅ elizaOS runtime initialized");
  return runtime;
}

async function handleChat(message: string, userId?: string): Promise<string> {
  const rt = await initializeRuntime();

  const entityId = userId ? stringToUuid(userId) : (uuidv4() as UUID);

  // Ensure connection
  await rt.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: userId ?? "MCP User",
    source: "mcp",
    channelId: "mcp",
    serverId: "mcp-server",
    type: ChannelType.DM,
  } as Parameters<typeof rt.ensureConnection>[0]);

  // Create message memory
  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId,
    roomId,
    content: {
      text: message,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  // Process message and collect response
  let response = "";

  await rt.messageService!.handleMessage(rt, messageMemory, async (content) => {
    if (content?.text) {
      response += content.text;
    }
    return [];
  });

  return response || "I didn't generate a response. Please try again.";
}

function getAgentInfo(): { name: string; bio: string; capabilities: string[] } {
  const bio = CHARACTER.bio;
  const bioStr = Array.isArray(bio) ? bio.join(" ") : (bio ?? "An AI assistant");
  return {
    name: CHARACTER.name,
    bio: bioStr,
    capabilities: [
      "Natural language conversation",
      "Helpful responses",
      "Context-aware dialogue",
    ],
  };
}

// ============================================================================
// MCP Server
// ============================================================================

async function main(): Promise<void> {
  const server = new Server(
    {
      name: "eliza-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Helper to handle Zod schema type compatibility
  // Due to Zod version differences between MCP SDK and project dependencies
  type RequestSchema = Parameters<typeof server.setRequestHandler>[0];

  // Handle tool listing
  server.setRequestHandler(
    ListToolsRequestSchema as RequestSchema,
    async (): Promise<ListToolsResult> => ({
      tools: TOOLS,
    }),
  );

  // Handle tool calls
  server.setRequestHandler(
    CallToolRequestSchema as RequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "chat": {
            const chatArgs = args as ChatToolArgs | undefined;
            const message = chatArgs?.message;
            const userId = chatArgs?.userId;

            if (!message || typeof message !== "string") {
              return {
                content: [{ type: "text", text: "Error: message is required" }],
                isError: true,
              };
            }

            const response = await handleChat(message, userId);
            return {
              content: [{ type: "text", text: response }],
            };
          }

          case "get_agent_info": {
            const info = getAgentInfo();
            return {
              content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    },
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("🌐 elizaOS MCP Server running on stdio");
  console.error("📚 Available tools: chat, get_agent_info");
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.error("\n👋 Shutting down...");
  if (runtime) {
    await runtime.stop();
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
