import { describe, it, expect, vi } from "vitest";
import { printBootstrapBanner } from "../banner";
import type { IAgentRuntime } from "../../types";

describe("Banner functionality", () => {
  // Mock console.log to capture output
  const originalConsoleLog = console.log;
  let consoleLogOutput: string[] = [];

  beforeEach(() => {
    consoleLogOutput = [];
    console.log = vi.fn((...args) => {
      consoleLogOutput.push(args.join(' '));
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    vi.resetAllMocks();
  });

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
    
    // Check if banner was displayed
    const bannerText = consoleLogOutput.join('\n');
    expect(bannerText).toContain("Character: Test Character");
    expect(bannerText).toContain("[ Bootstrap ]");
  });

  it("should include environment variables in the banner", async () => {
    const mockSettings = {
      "TEST_VAR": "test-value",
      "ANOTHER_VAR": "another-value"
    };
    
    const mockRuntime = createMockRuntime("Test Character", mockSettings);
    
    await printBootstrapBanner(mockRuntime);
    
    // Check if environment variables are displayed in the banner
    const bannerText = consoleLogOutput.join('\n');
    expect(bannerText).toContain("TEST_VAR");
    expect(bannerText).toContain("test-value");
    expect(bannerText).toContain("ANOTHER_VAR");
    expect(bannerText).toContain("another-value");
  });

  it("should handle missing character name gracefully", async () => {
    const mockRuntime = createMockRuntime(undefined);
    
    await printBootstrapBanner(mockRuntime);
    
    // Check if banner was displayed with unknown character
    const bannerText = consoleLogOutput.join('\n');
    expect(bannerText).toContain("Character: unknown");
  });

  it("should include status indicators for variables", async () => {
    const mockSettings = {
      "REQUIRED_VAR": "set-value",
      "UNSET_VAR": ""
    };
    
    const mockRuntime = createMockRuntime("Test Character", mockSettings);
    
    await printBootstrapBanner(mockRuntime);
    
    // Check for status indicators
    const bannerText = consoleLogOutput.join('\n');
    expect(bannerText).toContain("custom");
    expect(bannerText).toContain("default");
  });

  it("should respect DISABLE_STARTUP_BANNER setting", async () => {
    const mockSettings = {
      "DISABLE_STARTUP_BANNER": "true"
    };
    
    const mockRuntime = createMockRuntime("Test Character", mockSettings);
    
    await printBootstrapBanner(mockRuntime);
    
    // Banner should not be displayed
    expect(consoleLogOutput.length).toBe(0);
  });
});
