import { describe, it, expect, vi } from "vitest";
import { anxietyProvider } from "../providers/anxiety";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime, Memory, State } from "../../types";

// Test utilities
const createMockRuntime = () => ({
  agentId: "test-agent-id", 
  getSetting: vi.fn((key) => null),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}) as unknown as IAgentRuntime;

const createMockMemory = (channelType: ChannelType): Memory => ({
  content: { 
    channelType,
    text: "Test message"
  }
}) as Memory;

describe("anxietyProvider", () => {
  const mockRuntime = createMockRuntime();

  it("should return group anxiety examples for GROUP channel", async () => {
    const mockMemory = createMockMemory(ChannelType.GROUP);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    expect(result.text).toContain("Social anxiety concerns");
    expect(result.text).toContain("Be careful about over-enthusiasm");
    expect(result.text).toBeTruthy();
    expect(result.values).toBeDefined();
    expect(result.values.hasAnxiety).toBe(true);
  });

  it("should return DM anxiety examples for DM channel", async () => {
    const mockMemory = createMockMemory(ChannelType.DM);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.text).toContain("Keep responses shorter");
    expect(result.text).toBeTruthy();
    expect(result.values).toBeDefined();
    expect(result.values.hasAnxiety).toBe(true);
  });

  it("should return DM anxiety examples for VOICE_DM channel", async () => {
    const mockMemory = createMockMemory(ChannelType.VOICE_DM);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.values.hasAnxiety).toBe(true);
  });

  it("should return appropriate anxiety for API channel", async () => {
    const mockMemory = createMockMemory(ChannelType.API);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );
    
    expect(result.text).toBeTruthy();
    expect(result.values.hasAnxiety).toBe(true);
    expect(result.values.channel).toBe(ChannelType.API);
  });

  it("should handle missing channel type gracefully", async () => {
    const mockMemory = {
      content: { text: "Test message" }
    } as Memory;
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );

    expect(result.text).toBeTruthy();
    expect(result.values.hasAnxiety).toBe(true);
    expect(result.values.channel).toBe("unknown");
  });

  it("should return consistent output regardless of runtime settings", async () => {
    const mockRuntimeWithSettings = createMockRuntime();
    mockRuntimeWithSettings.getSetting.mockReturnValue("custom anxiety content");

    const mockMemory = createMockMemory(ChannelType.DM);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntimeWithSettings,
      mockMemory,
      mockState
    );
    
    expect(result.text).toContain("AI model, you are too verbose and eager.");
    expect(result.values.hasAnxiety).toBe(true);
  });

  it("should provide values for state composition", async () => {
    const mockMemory = createMockMemory(ChannelType.GROUP);
    const mockState = {} as State;
    
    const result = await anxietyProvider.get(
      mockRuntime,
      mockMemory,
      mockState
    );

    expect(result.values).toEqual({
      hasAnxiety: true,
      channel: ChannelType.GROUP,
    });
  });
});
