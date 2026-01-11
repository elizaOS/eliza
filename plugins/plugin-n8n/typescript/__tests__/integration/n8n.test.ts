/**
 * Integration tests for the N8n Plugin.
 * Uses REAL AgentRuntime - NO MOCKS.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginCreationService } from "../../services/plugin-creation-service";
import type { PluginSpecification } from "../../types";

// Test utilities for creating real runtime
async function createTestRuntime(): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  // Dynamically import plugin-sql to get the database adapter
  const sqlPlugin = await import("@elizaos/plugin-sql");
  const { AgentRuntime } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: ["A test agent for plugin creation"],
      system: "You are a helpful assistant for testing.",
      plugins: [],
      settings: {
        secrets: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      await adapter.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

describe("PluginCreationService", () => {
  let service: PluginCreationService;
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;
    service = new PluginCreationService(runtime);
    await service.initialize(runtime);
  });

  afterEach(async () => {
    await service.stop();
    await cleanup();
  });

  describe("initialization", () => {
    it("should initialize without API key", async () => {
      expect(service).toBeDefined();
      expect(service.capabilityDescription).toContain("Plugin creation");
    });
  });

  describe("plugin name validation", () => {
    const testSpec: PluginSpecification = {
      name: "@elizaos/plugin-test",
      description: "A test plugin for validation",
      version: "1.0.0",
    };

    it("should reject invalid plugin names", async () => {
      const invalidSpec = { ...testSpec, name: "invalid-name" };
      await expect(service.createPlugin(invalidSpec)).rejects.toThrow("Invalid plugin name");
    });

    it("should reject path traversal attempts", async () => {
      const invalidSpec = { ...testSpec, name: "@scope/../plugin-evil" };
      await expect(service.createPlugin(invalidSpec)).rejects.toThrow("Invalid plugin name");
    });
  });

  describe("job management", () => {
    it("should return empty list when no jobs", () => {
      const jobs = service.getAllJobs();
      expect(jobs).toEqual([]);
    });

    it("should return empty list for created plugins initially", () => {
      const plugins = service.getCreatedPlugins();
      expect(plugins).toEqual([]);
    });

    it("should return null for non-existent job", () => {
      const job = service.getJobStatus("non-existent-id");
      expect(job).toBeNull();
    });

    it("should correctly report plugin not created", () => {
      expect(service.isPluginCreated("@test/non-existent")).toBe(false);
    });
  });

  describe("rate limiting", () => {
    it("should allow initial job creation", async () => {
      const spec: PluginSpecification = {
        name: "@test/plugin-rate-1",
        description: "Rate limit test plugin 1",
      };

      // This will fail due to no API key, but rate limit check happens first
      try {
        await service.createPlugin(spec);
      } catch {
        // Expected to fail for other reasons
      }

      expect(service.isPluginCreated("@test/plugin-rate-1")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("should cleanup old jobs without errors", () => {
      expect(() => service.cleanupOldJobs()).not.toThrow();
    });
  });

  describe("service lifecycle", () => {
    it("should stop gracefully", async () => {
      await expect(service.stop()).resolves.not.toThrow();
    });
  });
});
