import { describe, it, expect, vi } from "vitest";
import { anxietyProvider } from "../providers/anxiety";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime, Memory, State } from "../../types";

describe("anxietyProvider", () => {
  const mockRuntime = {
    agentId: "test-agent-id",
    getSetting: vi.fn((key) => null),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;

  it("should return group anxiety examples for GROUP channel", async () => {
    const mockMemory = {
      content: { 
        channelType: ChannelType.GROUP,
        text: "Hello everyone!"
      }
    } as Memory;
    
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    // Verify it contains the anxiety header and has content
    // Test for actual anxiety provider content
    expect(result.text).toContain("Social anxiety concerns");
    expect(result.text).toBeTruthy();
  });

  it("should return DM anxiety examples for DM channel", async () => {
    const mockMemory = {
      content: { 
        channelType: ChannelType.DM,
        text: "Hello there"
      }
    } as Memory;
    
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    // Verify it contains the anxiety header
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.text).toBeTruthy();
  });

  it("should return DM anxiety examples for VOICE_DM channel", async () => {
    const mockMemory = {
      content: { 
        channelType: ChannelType.VOICE_DM,
        text: "Voice message test"
      }
    } as Memory;
    
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    // Verify it contains expected DM anxiety examples
    expect(result.text).toContain("AI model, you are too verbose and eager.");
  });

  it("should return appropriate anxiety for API channel", async () => {
    const mockMemory = {
      content: { 
        channelType: ChannelType.API,
        text: "API request"
      }
    } as Memory;
    
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    // Should have some anxiety examples but not necessarily specific ones
    expect(result.text).toBeTruthy();
  });

  it("should return consistent output regardless of getSetting mock", async () => {
    // The provider doesn't actually use runtime.getSetting for ANXIETY_EXAMPLES
    // (the runtime parameter is named _runtime and is unused)
    // This test verifies the provider returns valid output regardless

    const mockMemory = {
      content: { 
        channelType: ChannelType.DM,
        text: "Test message"
      }
    } as Memory;
    
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    // Provider returns its built-in anxiety content
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.text).toBeTruthy();
  });
});
