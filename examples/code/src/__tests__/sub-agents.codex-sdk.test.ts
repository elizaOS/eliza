import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexSdkSubAgent } from "../lib/sub-agents/codex-sdk-sub-agent.js";
import type { SubAgentContext } from "../lib/sub-agents/types.js";
import type { CodeTask, JsonValue } from "../types.js";

vi.mock(
  "@openai/codex-sdk",
  () => {
    class FakeThread {
      async runStreamed(): Promise<{
        events: AsyncIterable<Record<string, JsonValue>>;
      }> {
        async function* events() {
          yield {
            type: "item.completed",
            item: {
              type: "fileChange",
              changes: [
                { path: "src/a.ts", kind: "modify", diff: "..." },
                { path: "src/new.ts", kind: "create", diff: "..." },
              ],
              status: "completed",
            },
          };

          yield {
            type: "item.completed",
            item: { type: "agent_message", text: "DONE: ok" },
          };

          yield {
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        return { events: events() };
      }
    }

    class Codex {
      startThread(): FakeThread {
        return new FakeThread();
      }
    }

    return { Codex };
  },
  { virtual: true },
);

function createContext(): {
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
    tools: [],
    onProgress: () => {},
    onMessage: (text, priority) => {
      messages.push({ text, priority });
    },
    isCancelled: () => false,
    isPaused: () => false,
  };
  return { context, messages };
}

describe("CodexSdkSubAgent", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("captures file changes from streamed events and returns them in TaskResult", async () => {
    const { context, messages } = createContext();
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

    const agent = new CodexSdkSubAgent();
    const result = await agent.execute(task, context);

    expect(result.success).toBe(true);
    expect(result.filesModified).toContain("src/a.ts");
    expect(result.filesCreated).toContain("src/new.ts");

    const fileMsgs = messages.filter((m) => m.text.startsWith("FILE "));
    expect(fileMsgs.length).toBeGreaterThanOrEqual(2);
  });
});
