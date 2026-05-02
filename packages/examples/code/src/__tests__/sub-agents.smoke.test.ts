import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { ElizaOSNativeSubAgent } from "../lib/sub-agents/elizaos-native-sub-agent.js";
import { OpenCodeSubAgent } from "../lib/sub-agents/opencode-sub-agent.js";
import { SweAgentSubAgent } from "../lib/sub-agents/sweagent-sub-agent.js";
import type { SubAgentContext, SubAgentTool } from "../lib/sub-agents/types.js";
import type { CodeTask } from "../types.js";

function createRuntimeAlwaysDone(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getModel: () => ({}),
    useModel: async () => "DONE: ok",
  } as IAgentRuntime;
}

function createTask(id: string, name: string): CodeTask {
  return {
    id,
    name,
    description: "desc",
    tags: ["code"],
    roomId: undefined,
    worldId: undefined,
    metadata: {
      status: "pending",
      progress: 0,
      output: [],
      steps: [],
      trace: [],
      userStatus: "open",
      userStatusUpdatedAt: Date.now(),
      filesCreated: [],
      filesModified: [],
      workingDirectory: process.cwd(),
      createdAt: Date.now(),
    },
  };
}

function baseContext(
  runtime: IAgentRuntime,
  tools: SubAgentTool[],
): SubAgentContext {
  return {
    runtime,
    workingDirectory: process.cwd(),
    tools,
    onProgress: () => {},
    onMessage: () => {},
    onTrace: () => {},
    isCancelled: () => false,
    isPaused: () => false,
  };
}

describe("sub-agent smoke", () => {
  test("OpenCodeSubAgent completes on DONE response", async () => {
    delete process.env.ELIZA_CODE_OPENCODE_PREFER_CLI;
    const agent = new OpenCodeSubAgent({ maxIterations: 3, preferCli: false });
    const runtime = createRuntimeAlwaysDone();
    const result = await agent.execute(
      createTask("t1", "OpenCode"),
      baseContext(runtime, []),
    );
    expect(result.success).toBe(true);
    expect(result.summary.toLowerCase()).toContain("ok");
  });

  test("ElizaOSNativeSubAgent completes on DONE response", async () => {
    const agent = new ElizaOSNativeSubAgent({
      maxIterations: 3,
      enableThinking: false,
    });
    const runtime = createRuntimeAlwaysDone();
    const result = await agent.execute(
      createTask("t2", "Native"),
      baseContext(runtime, []),
    );
    expect(result.success).toBe(true);
    expect(result.summary.toLowerCase()).toContain("ok");
  });

  test("SweAgentSubAgent fails fast outside git repo", async () => {
    const shell: SubAgentTool = {
      name: "shell",
      description: "shell",
      parameters: [{ name: "command", description: "cmd", required: true }],
      execute: async ({ command }) => ({
        success: true,
        output: `$ ${command}\nfalse`,
      }),
    };
    const agent = new SweAgentSubAgent({ maxIterations: 2 });
    const runtime = createRuntimeAlwaysDone();
    const result = await agent.execute(
      createTask("t3", "SWE"),
      baseContext(runtime, [shell]),
    );
    expect(result.success).toBe(false);
    expect(result.summary.toLowerCase()).toContain("git");
  });
});
