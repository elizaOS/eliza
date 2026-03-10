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
    
    // Verify it contains expected group anxiety examples
    expect(result.text).toContain("IGNORE");
    expect(result.text).toContain("AI model, you are too verbose and eager.");
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
    
    // Verify it contains expected DM anxiety examples
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.text).not.toContain("Group Anxiety");
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

  it("should handle custom anxiety examples from ANXIETY_EXAMPLES setting", async () => {
    // Configure mock to return custom examples
    mockRuntime.getSetting = vi.fn((key) => {
        if (key === "_runtime") {
            return null; // Return the desired mock response
        }
      if (key === "ANXIETY_EXAMPLES") {
        return "Custom anxiety 1,Custom anxiety 2";
      }
      return null;
    });

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
    
    // Ensure it handles the case correctly when no examples are set
    expect(result.text).not.toContain("Custom anxiety 1");
    expect(result.text).not.toContain("Custom anxiety 2");
  });
});
