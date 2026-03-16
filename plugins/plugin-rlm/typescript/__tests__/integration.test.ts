/**
 * Integration tests for the RLM plugin.
 *
 * These tests require Python and the RLM library to be installed.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
