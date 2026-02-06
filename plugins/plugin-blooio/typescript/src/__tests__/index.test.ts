import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import blooioPlugin from "../index";

describe("blooioPlugin", () => {
  it("should have correct metadata", () => {
    expect(blooioPlugin.name).toBe("blooio");
    expect(blooioPlugin.description).toBe("Blooio plugin for iMessage/SMS messaging integration");
  });

  it("should export all actions", () => {
    expect(blooioPlugin.actions).toBeDefined();
    expect(blooioPlugin.actions).toHaveLength(1);

    const actionNames = blooioPlugin.actions?.map((a) => a.name);
    expect(actionNames).toContain("SEND_MESSAGE");
  });

  it("should export all providers", () => {
    expect(blooioPlugin.providers).toBeDefined();
    expect(blooioPlugin.providers).toHaveLength(1);

    const providerNames = blooioPlugin.providers?.map((p) => p.name);
    expect(providerNames).toContain("blooioConversationHistory");
  });

  it("should export BlooioService", () => {
    expect(blooioPlugin.services).toBeDefined();
    expect(blooioPlugin.services).toHaveLength(1);
    expect(blooioPlugin.services?.[0].name).toBe("BlooioService");
  });

  it("should export test suite", () => {
    expect(blooioPlugin.tests).toBeDefined();
    expect(blooioPlugin.tests).toHaveLength(1);
    expect(blooioPlugin.tests?.[0].name).toBe("Blooio Plugin Test Suite");
  });

  describe("init", () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
      mockRuntime = {
        getSetting: vi.fn(),
      } as IAgentRuntime;
      vi.clearAllMocks();
    });

    it("should initialize successfully with all required settings", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        const settings: Record<string, string> = {
          BLOOIO_API_KEY: "api_key",
          BLOOIO_WEBHOOK_URL: "https://example.com/webhook",
          BLOOIO_WEBHOOK_SECRET: "whsec_test",
        };
        return settings[key];
      });

      await blooioPlugin.init?.({}, mockRuntime);

      expect(logger.info).toHaveBeenCalledWith("Blooio plugin initialized successfully");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("should warn when API key is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "BLOOIO_API_KEY") return "";
        return "value";
      });

      await blooioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Blooio API key not provided - Blooio plugin is loaded but will not be functional"
      );
    });

    it("should warn when webhook URL is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "BLOOIO_WEBHOOK_URL") return "";
        if (key === "BLOOIO_API_KEY") return "api_key";
        return "value";
      });

      await blooioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Blooio webhook URL not provided - Blooio will not receive incoming messages"
      );
    });
  });
});
