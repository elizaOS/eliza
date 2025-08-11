import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { Agent, ElizaOS, Inference } from "@/lib/core";
import { stepCountIs, type Tool } from "ai";

// Initialize ElizaOS and agents (same setup as src/index.ts but without demo runs)
const elizaOS = new ElizaOS();

const tools: Record<string, Tool> = {};

// Initialize optional services/tools based on env like in src/index.ts
import {
  discordService,
  readChannel,
  listChannels,
} from "@/plugins/plugin-discord";
import {
  evmService,
  getWalletAddress,
  getWalletBalance,
  getTokenBalance,
  getEVMChains,
} from "@/plugins/plugin-evm";

if (process.env.DISCORD_API_TOKEN) {
  discordService.initialize(process.env.DISCORD_API_TOKEN);
  tools.readDiscordChannel = readChannel;
  tools.listDiscordChannels = listChannels;
}

if (process.env.WALLET_PRIVATE_KEY) {
  evmService.initialize({
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
    chainIds: process.env.EVM_CHAINS?.split(",").map((s) => s.trim()) as
      | Array<string>
      | undefined,
  });
  tools.getWalletAddress = getWalletAddress;
  tools.getWalletBalance = getWalletBalance;
  tools.getTokenBalance = getTokenBalance;
  tools.getEVMChains = getEVMChains;
}

const defaultAgent = new Agent({
  model: Inference.getModel("gpt-5-mini"),
  tools,
  stopWhen: stepCountIs(10),
});

// Register at least one agent with a stable ID
elizaOS.addAgent(defaultAgent, "default");

// Hono app
const app = new Hono();

app.get("/agents", (c: Context) => {
  return c.json(elizaOS.listAgents());
});

// Minimal OpenAI-compatible chat completions endpoint
// Accepts JSON body with { agent_id: string, messages: Array<{role, content}>, model?: string, stream?: boolean }
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

type ChatCompletionRequest = {
  agent_id: string;
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  include_intermediate_steps?: boolean;
};

app.post("/v1/chat/completions", async (c: Context) => {
  const body = (await c.req.json()) as ChatCompletionRequest;

  if (!body || typeof body.agent_id !== "string") {
    return c.json({ error: "agent_id is required in the request body" }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }
  if (body.stream === true) {
    // Streaming not implemented in this minimal pass
    return c.json({ error: "streaming is not supported yet" }, 400);
  }

  const agent = elizaOS.getAgentById(body.agent_id);
  if (!agent) {
    return c.json({ error: `agent not found: ${body.agent_id}` }, 404);
  }

  // Simple prompt composition from OpenAI-style chat messages
  const prompt = body.messages
    .map((m) => {
      const prefix =
        m.role === "system"
          ? "[System]"
          : m.role === "assistant"
            ? "[Assistant]"
            : m.role === "tool"
              ? "[Tool]"
              : "[User]";
      return `${prefix} ${m.content}`;
    })
    .join("\n\n");

  const result = await agent.generate({ prompt });

  const now = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl_${randomUUID()}`;

  // If intermediate steps are requested, return full conversation flow
  if (
    body.include_intermediate_steps &&
    result.steps &&
    result.steps.length > 0
  ) {
    const conversationMessages: any[] = [];

    // Add original user message - find the last user message in the conversation
    const userMessages = body.messages.filter((msg) => msg.role === "user");
    const lastUserMessage = userMessages[userMessages.length - 1];
    conversationMessages.push({
      role: "user",
      content:
        lastUserMessage?.content || prompt.split("[User] ").pop() || prompt,
    });

    // Process each step
    for (const step of result.steps) {
      if (step.toolCalls && step.toolCalls.length > 0) {
        // Add assistant message with tool calls
        conversationMessages.push({
          role: "assistant",
          content: step.text || null,
          tool_calls: step.toolCalls.map((toolCall) => ({
            id: toolCall.toolCallId,
            type: "function",
            function: {
              name: toolCall.toolName,
              arguments: JSON.stringify(toolCall.input || {}),
            },
          })),
        });

        // Add tool results as tool messages
        if (step.toolResults) {
          for (const toolResult of step.toolResults) {
            conversationMessages.push({
              role: "tool",
              tool_call_id: toolResult.toolCallId,
              content: JSON.stringify(
                toolResult.output || "Tool executed successfully",
              ),
            });
          }
        }
      } else if (step.text) {
        // Final assistant response
        conversationMessages.push({
          role: "assistant",
          content: step.text,
        });
      }
    }

    return c.json({
      id: responseId,
      object: "chat.completion",
      created: now,
      model: body.model ?? "gpt-5-mini",
      choices: [
        {
          index: 0,
          message: conversationMessages[conversationMessages.length - 1] || {
            role: "assistant",
            content: result.text,
          },
          finish_reason: "stop",
        },
      ],
      // Include full conversation in a custom field for debugging
      conversation_flow: conversationMessages,
    });
  }

  // Standard OpenAI response format
  const toolCalls = result.toolCalls?.map((toolCall) => ({
    id: toolCall.toolCallId,
    type: "function" as const,
    function: {
      name: toolCall.toolName,
      arguments: JSON.stringify(toolCall.input || {}),
    },
  }));

  const response = {
    id: responseId,
    object: "chat.completion" as const,
    created: now,
    model: body.model ?? "gpt-5-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: result.text,
          ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: result.finishReason,
      },
    ],
  };

  return c.json(response);
});

const port = Number(process.env.PORT ?? 3000);

// Start the server with Bun
Bun.serve({
  port,
  fetch: app.fetch,
});
console.log(`Hono server listening on http://localhost:${port}`);
