/**
 * Integration tests for the N8n Plugin.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { PluginCreationService } from "../../services/plugin-creation-service";
import type { PluginSpecification } from "../../types";

const createMockRuntime = (): IAgentRuntime => {
  const runtime = {
    getSetting: vi.fn((key: string) => {
      if (key === "ANTHROPIC_API_KEY") {
        return process.env.ANTHROPIC_API_KEY;
      }
      return undefined;
    }),
    services: new Map(),
    providers: new Map(),
    actions: new Map(),
    evaluators: new Map(),
  } as unknown as IAgentRuntime;

  return runtime;
};

describe("PluginCreationService", () => {
  let service: PluginCreationService;
  let mockRuntime: IAgentRuntime;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();
    service = new PluginCreationService(mockRuntime);
    await service.initialize(mockRuntime);
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
      await expect(service.createPlugin(invalidSpec)).rejects.toThrow(
        "Invalid plugin name"
      );
    });

    it("should reject path traversal attempts", async () => {
      const invalidSpec = { ...testSpec, name: "@scope/../plugin-evil" };
      await expect(service.createPlugin(invalidSpec)).rejects.toThrow(
        "Invalid plugin name"
      );
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


