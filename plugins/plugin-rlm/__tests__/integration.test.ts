/**
 * Integration tests for the RLM plugin.
 *
 * These tests require Python and the RLM library to be installed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const execAsync = promisify(exec);

// Check if Python is available
async function checkPython(): Promise<boolean> {
  try {
    await execAsync("python --version");
    return true;
  } catch {
    try {
      await execAsync("python3 --version");
      return true;
    } catch {
      return false;
    }
  }
}

// Check if elizaos_plugin_rlm is installed
async function checkRLMModule(): Promise<boolean> {
  try {
    await execAsync("python -c 'import elizaos_plugin_rlm'");
    return true;
  } catch {
    return false;
  }
}

describe("RLM Integration", () => {
  let hasPython = false;
  let hasRLMModule = false;

  beforeAll(async () => {
    hasPython = await checkPython();
    if (hasPython) {
      hasRLMModule = await checkRLMModule();
    }
  });

  describe("Python Environment", () => {
    it("should detect Python availability", () => {
      // This test always passes, just logs the status
      console.log(`Python available: ${hasPython}`);
      console.log(`RLM module available: ${hasRLMModule}`);
      expect(true).toBe(true);
    });
  });

  describe("RLMClient without Python", () => {
    it("should return stub response when Python unavailable", async () => {
      const { RLMClient } = await import("../client");

      // Use invalid python path to simulate unavailable Python
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });
      const result = await client.infer("Hello");

      expect(result.metadata.stub).toBe(true);
      expect(result.text).toContain("[RLM STUB]");
    });
  });

  describe.skipIf(!hasPython || !hasRLMModule)("RLMClient with Python", () => {
    it("should initialize server successfully", async () => {
      const { RLMClient } = await import("../client");

      const client = new RLMClient();
      const status = await client.getStatus();

      // Status should return, even if RLM is not available
      expect(status).toBeDefined();
      expect(typeof status.available).toBe("boolean");

      await client.shutdown();
    });

    it("should handle infer request", async () => {
      const { RLMClient } = await import("../client");

      const client = new RLMClient();
      const result = await client.infer("Hello, world!");

      expect(result).toBeDefined();
      expect(typeof result.text).toBe("string");
      expect(typeof result.metadata.stub).toBe("boolean");

      await client.shutdown();
    });

    it("should handle message array format", async () => {
      const { RLMClient } = await import("../client");

      const client = new RLMClient();
      const result = await client.infer([{ role: "user", content: "What is 1 + 1?" }]);

      expect(result).toBeDefined();
      expect(typeof result.text).toBe("string");

      await client.shutdown();
    });

    it("should shutdown cleanly", async () => {
      const { RLMClient } = await import("../client");

      const client = new RLMClient();
      await client.getStatus(); // Initialize server
      await client.shutdown();

      // Should be able to reinitialize
      const status = await client.getStatus();
      expect(status).toBeDefined();
      await client.shutdown();
    });
  });
});

describe("RLM trajectory wrapping", () => {
  afterEach(() => {
    vi.doUnmock("../client");
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("records plugin model inference through recordLlmCall", async () => {
    vi.resetModules();
    const infer = vi.fn(async () => ({
      text: "recursive answer",
      metadata: { stub: false },
    }));
    vi.doMock("../client", () => ({
      RLMClient: vi.fn(function RLMClient() {
        return {
          infer,
          getStatus: vi.fn(async () => ({ available: true, backend: "gemini" })),
          shutdown: vi.fn(),
        };
      }),
      configFromEnv: vi.fn(() => ({})),
      stubResult: vi.fn(() => ({ text: "[RLM STUB]", metadata: { stub: true } })),
    }));

    const { rlmPlugin } = await import("../index");
    const llmCalls: Record<string, unknown>[] = [];
    const trajectoryLogger = {
      isEnabled: () => true,
      logLlmCall: vi.fn((call: Record<string, unknown>) => {
        llmCalls.push(call);
      }),
    };
    const runtime = {
      agentId: "agent-rlm",
      character: { system: "system prompt" },
      getService: vi.fn((name: string) => (name === "trajectories" ? trajectoryLogger : null)),
      getServicesByType: vi.fn((type: string) =>
        type === "trajectories" ? [trajectoryLogger] : [],
      ),
      getSetting: vi.fn(),
      rlmConfig: { backend: "gemini" },
    } as IAgentRuntime & { rlmConfig: { backend: "gemini" } };
    const handler = rlmPlugin.models?.[ModelType.TEXT_LARGE];
    expect(handler).toBeDefined();

    await runWithTrajectoryContext({ trajectoryStepId: "step-rlm" }, () =>
      handler?.(runtime, {
        prompt: "Solve this",
        maxTokens: 128,
        temperature: 0.2,
      }),
    );

    expect(infer).toHaveBeenCalledWith(
      "Solve this",
      expect.objectContaining({ maxTokens: 128, temperature: 0.2 }),
    );
    expect(llmCalls[0]).toMatchObject({
      stepId: "step-rlm",
      model: "gemini:rlm",
      actionType: "rlm.client.infer",
      response: "recursive answer",
      userPrompt: "Solve this",
    });
  });
});

describe("Plugin Init", () => {
  it("should initialize plugin with mock runtime", async () => {
    const { rlmPlugin } = await import("../index");

    const mockRuntime = {
      rlmConfig: undefined,
    };

    // Init should not throw
    await expect(
      rlmPlugin.init?.(
        {
          ELIZA_RLM_BACKEND: "gemini",
          ELIZA_RLM_ENV: "local",
        },
        mockRuntime as never,
      ),
    ).resolves.not.toThrow();
  });
});
