import { describe, it, expect, vi } from "vitest";
import { printBootstrapBanner } from "../banner";
import type { IAgentRuntime } from "../../types";

describe("Banner functionality", () => {
  const createMockRuntime = (characterName = "Test Character", settings: Record<string, string> = {}) => {
    return {
      agentId: "test-agent-id",
      character: {
        name: characterName
      },
      getSetting: vi.fn((key: string) => settings[key] || null),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }
    } as unknown as IAgentRuntime;
  };

  it("should display a banner with character name", async () => {
    const mockRuntime = createMockRuntime("Test Character");
    
    await printBootstrapBanner(mockRuntime);
    
    // Check if banner was displayed via logger.info
    expect(mockRuntime.logger.info).toHaveBeenCalled();
    const bannerText = (mockRuntime.logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bannerText).toContain("Bootstrap");
  });

  it("should handle missing character name gracefully", async () => {
    const mockRuntime = createMockRuntime(undefined);
    
    await printBootstrapBanner(mockRuntime);
    
    // Check if banner was displayed via logger.info
    expect(mockRuntime.logger.info).toHaveBeenCalled();
  });

  it("should respect DISABLE_STARTUP_BANNER setting", async () => {
    const mockSettings = {
      "DISABLE_STARTUP_BANNER": "true"
    };
    
    const mockRuntime = createMockRuntime("Test Character", mockSettings);
    
    await printBootstrapBanner(mockRuntime);
    
    // Banner should not be displayed - logger.info should not be called
    expect(mockRuntime.logger.info).not.toHaveBeenCalled();
  });
});
