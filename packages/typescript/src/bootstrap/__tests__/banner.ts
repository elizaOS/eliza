import { describe, it, expect, vi, beforeEach } from "vitest";
import { printBootstrapBanner } from "../banner";
import { type IAgentRuntime } from "../../types";

describe("printBootstrapBanner", () => {
  const mockRuntime: IAgentRuntime = {
    agentId: "test-agent",
    getSetting: vi.fn(),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  } as unknown as IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should display banner with default settings", () => {
    // Mock all settings as undefined/default
    mockRuntime.getSetting.mockImplementation(() => undefined);

    printBootstrapBanner(mockRuntime);

    // Verify banner was logged
    expect(mockRuntime.logger.info).toHaveBeenCalled();
    const bannerCall = mockRuntime.logger.info.mock.calls[0][0];
    expect(bannerCall).toContain("Bootstrap");
    expect(bannerCall).toContain("plugin");
  // Note: shared mock ensures consistency across tests but requires careful handling of state.
  });

  it("should display banner with custom settings", () => {
    mockRuntime.getSetting.mockImplementation((key: string) => {
      switch(key) {
        case "ALWAYS_RESPOND_CHANNELS": 
          return '["DM","GROUP"]';
        case "DISABLE_MEMORY_CREATION":
          return "true";
        default:
          return undefined;  
      }
    });

    printBootstrapBanner(mockRuntime);

    const bannerCall = mockRuntime.logger.info.mock.calls[0][0];
    expect(bannerCall).toContain("ALWAYS_RESPOND_CHANNELS");
    expect(bannerCall).toContain('["DM","GROUP"]');
    expect(bannerCall).toContain("DISABLE_MEMORY_CREATION");
    expect(bannerCall).toContain("true");
  });

  it("should handle legacy setting names", () => {
    mockRuntime.getSetting.mockImplementation((key: string) => {
      switch(key) {
        case "SHOULD_RESPOND_BYPASS_TYPES":
          return '["VOICE_DM"]';
        case "SHOULD_RESPOND_BYPASS_SOURCES":
          return '["bot"]';
        default:
          return undefined;
      }
    });

    printBootstrapBanner(mockRuntime);

    const bannerCall = mockRuntime.logger.info.mock.calls[0][0];
    expect(bannerCall).toContain("ALWAYS_RESPOND_CHANNELS");
    expect(bannerCall).toContain('["VOICE_DM"]');
    expect(bannerCall).toContain("ALWAYS_RESPOND_SOURCES");
    expect(bannerCall).toContain('["bot"]');
  });
});
