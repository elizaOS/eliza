import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { z } from "zod";
import type { CodeTask, TaskResult } from "../../types.js";
import type { SubAgent, SubAgentContext, SubAgentTool } from "./types.js";

type ToolSchemaValue = z.ZodString | z.ZodDefault<z.ZodOptional<z.ZodString>>;

function createSchemaFromTool(
  toolDef: SubAgentTool,
): Record<string, ToolSchemaValue> {
  const shape: Record<string, ToolSchemaValue> = {};
  for (const p of toolDef.parameters) {
    const schema = z.string();
    // Ensure optional params still deserialize to a string (default empty).
    shape[p.name] = p.required ? schema : schema.optional().default("");
  }
  return shape;
}

function toAllowedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function extractAssistantTextBlocks(blocks: BetaContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join("");
}

/**
 * ClaudeAgentSdkSubAgent
 *
 * Executes a task using Anthropic's Claude Agent SDK, wiring our `SubAgentTool[]`
 * as an SDK MCP server so Claude can call them.
 *
 * This is designed to be testable via module mocks; it does not require network
 * calls in tests.
 */
export class ClaudeAgentSdkSubAgent implements SubAgent {
  readonly name = "Claude Agent SDK Worker";
  readonly type = "claude-code" as const;

  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    const { tools, onMessage, workingDirectory, isCancelled } = context;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];

    const serverName = "eliza_tools";

    // Wire our tool list into an SDK MCP server.
    const sdkTools = tools.map((t) =>
      tool(t.name, t.description, createSchemaFromTool(t), async (args) => {
        if (this.cancelled || isCancelled()) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
          };
        }

        const result = await t.execute(args as Record<string, string>);

        const filepath = result.data?.filepath;
        if (result.success && typeof filepath === "string") {
          if (t.name === "write_file") {
            if (!filesCreated.includes(filepath)) filesCreated.push(filepath);
          }
          if (t.name === "edit_file") {
            if (!filesModified.includes(filepath)) filesModified.push(filepath);
          }

          if (t.name === "write_file" || t.name === "edit_file") {
            const abs = path.resolve(workingDirectory, filepath);
            const link = pathToFileURL(abs).toString();
            const sizeValue = result.data?.size;
            const sizeSuffix =
              typeof sizeValue === "number" ? ` (${sizeValue} chars)` : "";
            const kind = t.name === "write_file" ? "write" : "edit";
            onMessage(
              `FILE ${kind}: ${filepath}${sizeSuffix} — ${link}`,
              "info",
            );
          }
        }

        return {
          content: [{ type: "text", text: result.output }],
        };
      }),
    );

    const mcpServer = createSdkMcpServer({
      name: serverName,
      version: "1.0.0",
      tools: sdkTools,
    });

    const allowedTools = tools.map((t) =>
      toAllowedToolName(serverName, t.name),
    );

    const maxTurns = Number.parseInt(
      process.env.ELIZA_CODE_CLAUDE_AGENT_SDK_MAX_TURNS ?? "12",
      10,
    );

    let finalText = "";
    try {
      const stream = query({
        // Keep this as a string for type safety. The SDK supports streaming
        // prompts, but that requires constructing full SDKUserMessage objects.
        prompt:
          `Task: ${task.name}\nWorking directory: ${workingDirectory}\n\n${task.description ?? ""}`.trim(),
        options: {
          mcpServers: { [serverName]: mcpServer },
          allowedTools,
          maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 12,
        },
      });

      for await (const raw of stream as AsyncIterable<SDKMessage>) {
        if (this.cancelled || isCancelled()) break;
        if (raw.type === "assistant") {
          const delta = extractAssistantTextBlocks(raw.message.content);
          if (delta) {
            finalText += delta;
            onMessage(delta, "info");
          }
        }
        if (raw.type === "result" && raw.subtype === "success") {
          finalText = raw.result;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: `Claude Agent SDK failed: ${message}`,
        filesCreated,
        filesModified,
        error: message,
      };
    }

    if (this.cancelled || isCancelled()) {
      return {
        success: false,
        summary: "Cancelled",
        filesCreated,
        filesModified,
        error: "Cancelled",
      };
    }

    const summary = finalText.trim().split("\n")[0] || "Completed";
    return {
      success: true,
      summary,
      filesCreated,
      filesModified,
    };
  }
}
