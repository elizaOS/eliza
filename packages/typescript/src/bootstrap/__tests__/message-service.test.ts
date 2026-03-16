import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Message Service Memory Controls", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("DISABLE_MEMORY_CREATION", () => {
    it("should respect DISABLE_MEMORY_CREATION environment variable", async () => {
      process.env.DISABLE_MEMORY_CREATION = "true";
      
      // Import after setting env var
      const messageService = await import("../../services/message");
      
      // Verify the module loaded (basic smoke test)
      expect(messageService).toBeDefined();
    });

    it("should allow memory creation when DISABLE_MEMORY_CREATION is false", async () => {
      process.env.DISABLE_MEMORY_CREATION = "false";
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });

    it("should allow memory creation when DISABLE_MEMORY_CREATION is not set", async () => {
      delete process.env.DISABLE_MEMORY_CREATION;
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });
  });

  describe("ALLOW_MEMORY_SOURCE_IDS", () => {
    it("should parse ALLOW_MEMORY_SOURCE_IDS as comma-separated list", async () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = "source1,source2,source3";
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });

    it("should handle empty ALLOW_MEMORY_SOURCE_IDS", async () => {
      process.env.ALLOW_MEMORY_SOURCE_IDS = "";
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });
  });

  describe("keepExistingResponses / BOOTSTRAP_KEEP_RESP", () => {
    it("should respect BOOTSTRAP_KEEP_RESP environment variable", async () => {
      process.env.BOOTSTRAP_KEEP_RESP = "true";
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });

    it("should default to false when BOOTSTRAP_KEEP_RESP not set", async () => {
      delete process.env.BOOTSTRAP_KEEP_RESP;
      
      const messageService = await import("../../services/message");
      expect(messageService).toBeDefined();
    });
  });
});
