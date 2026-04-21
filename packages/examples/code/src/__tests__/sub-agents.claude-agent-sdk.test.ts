import { afterEach, describe, expect, test, vi } from "vitest";
import { ClaudeAgentSdkSubAgent } from "../lib/sub-agents/claude-agent-sdk-sub-agent.js";
import type { SubAgentContext, SubAgentTool } from "../lib/sub-agents/types.js";
import type { CodeTask, JsonValue } from "../types.js";

vi.mock(
  "@anthropic-ai/claude-agent-sdk",
  () => {
    const createSdkMcpServer = vi.fn((opts: Record<string, JsonValue>) => opts);

    const tool = vi.fn(
      (
        name: string,
        description: string,
        _schema: JsonValue,
        handler: (
          args: Record<string, string>,
        ) => Promise<Record<string, JsonValue>>,
      ) => ({
        name,
        description,
        handler,
      }),
    );

    const query = vi.fn(
      (input: {
        prompt: AsyncIterable<Record<string, JsonValue>>;
        options: { mcpServers: Record<string, JsonValue> };
      }) => {
        const servers = input.options.mcpServers;
        const serverVal = servers.eliza_tools;
        const server =
          typeof serverVal === "object" && serverVal !== null
            ? (serverVal as Record<string, JsonValue>)
            : null;
        const toolsVal = server ? server.tools : null;
        const tools = Array.isArray(toolsVal) ? toolsVal : [];

        async function* run() {
          // Simulate some assistant text coming through the stream.
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "hello from assistant" }],
            },
          };

          // Simulate the SDK calling our tools once.
          for (const t of tools) {
            if (typeof t !== "object" || t === null || Array.isArray(t))
              continue;
            const rec = t as Record<string, JsonValue>;
            const name = typeof rec.name === "string" ? rec.name : "";
            const handlerVal = rec.handler;
            const handler =
              typeof handlerVal === "function"
                ? (handlerVal as (
                    a: Record<string, string>,
                  ) => Promise<Record<string, JsonValue>>)
                : null;
            if (!handler) continue;
            if (name === "write_file") {
              await handler({ filepath: "a.txt", content: "hello" });
            }
            if (name === "edit_file") {
              await handler({ filepath: "b.txt", old_str: "x", new_str: "y" });
            }
          }

          // Simulate a final result.
          yield { type: "result", subtype: "success", result: "DONE: ok" };
        }

        return run();
      },
    );

    return {
      query,
      tool,
      createSdkMcpServer,
    };
  },
  { virtual: true },
);

function createContext(tools: SubAgentTool[]): {
  context: SubAgentContext;
  messages: Array<{ text: string; priority: "info" | "warning" | "error" }>;
} {
  const messages: Array<{
    text: string;
    priority: "info" | "warning" | "error";
  }> = [];

  const context: SubAgentContext = {
    runtime: {} as never,
    workingDirectory: "/tmp",
    tools,
    onProgress: () => {},
    onMessage: (text, priority) => {
      messages.push({ text, priority });
    },
    isCancelled: () => false,
    isPaused: () => false,
  };

  return { context, messages };
}

describe("ClaudeAgentSdkSubAgent", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZA_CODE_CLAUDE_AGENT_SDK_MAX_TURNS;
  });

  test("wires tools via MCP server and returns filesCreated/filesModified", async () => {
    const writeFile: SubAgentTool = {
      name: "write_file",
      description: "write file",
      parameters: [
        { name: "filepath", description: "path", required: true },
        { name: "content", description: "content", required: true },
      ],
      execute: vi.fn(async (args) => ({
        success: true,
        output: "wrote",
        data: { filepath: args.filepath ?? "", size: 5 },
      })),
    };

    const editFile: SubAgentTool = {
      name: "edit_file",
      description: "edit file",
      parameters: [
        { name: "filepath", description: "path", required: true },
        { name: "old_str", description: "old", required: true },
        { name: "new_str", description: "new", required: true },
      ],
      execute: vi.fn(async (args) => ({
        success: true,
        output: "edited",
        data: { filepath: args.filepath ?? "" },
      })),
    };

    const { context, messages } = createContext([writeFile, editFile]);
    const task: CodeTask = {
      id: "t1",
      name: "Demo",
      description: "Do a thing",
      tags: [],
      metadata: {
        status: "pending",
        progress: 0,
        output: [],
        steps: [],
        workingDirectory: context.workingDirectory,
        createdAt: Date.now(),
      },
    };

    const agent = new ClaudeAgentSdkSubAgent();
    const result = await agent.execute(task, context);

    expect(result.success).toBe(true);
    expect(result.filesCreated).toContain("a.txt");
    expect(result.filesModified).toContain("b.txt");

    // Ensure tool handlers were actually invoked by the mocked query.
    expect(writeFile.execute).toHaveBeenCalled();
    expect(editFile.execute).toHaveBeenCalled();

    // File events should be emitted for write/edit tools.
    const fileMsgs = messages.filter((m) => m.text.startsWith("FILE "));
    expect(fileMsgs.length).toBeGreaterThanOrEqual(2);

    // Assistant text should also stream into onMessage.
    const assistantMsgs = messages.filter((m) =>
      m.text.includes("hello from assistant"),
    );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
