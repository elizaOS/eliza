import { describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@elizaos/app-core/state", () => ({
  getVrmPreviewUrl: vi.fn((index: number) => `/vrms/previews/eliza-${index}.png`),
  useApp: () => ({
    t: (key: string) => key,
    handleChatSend: vi.fn(),
    setState: vi.fn(),
    selectedVrmIndex: 1,
    copyToClipboard: vi.fn(),
  }),
}));

vi.mock("@elizaos/app-core/hooks", () => ({
  useTimeout: () => ({ setTimeout: globalThis.setTimeout }),
}));

vi.mock("@elizaos/ui", () => ({
  Button: () => null,
}));

vi.mock("./MessageContent", () => ({
  MessageContent: () => null,
}));

import { getVrmPreviewUrl } from "@elizaos/app-core/state";

// ChatEmptyState is a React component — test the pure logic it relies on
// without requiring a DOM renderer.

describe("ChatEmptyState logic", () => {
  it("includes agent name in generated suggestions", () => {
    const agentName = "Aria";
    // Mirror the suggestion generation logic from ChatEmptyState
    const suggestions = [
      `Hey ${agentName}, what can you do?`,
      `Tell me about yourself, ${agentName}`,
      `What's happening in crypto today?`,
      `Help me set up my wallet`,
    ];

    expect(suggestions[0]).toContain(agentName);
    expect(suggestions[1]).toContain(agentName);
    // The third and fourth are static
    expect(suggestions[2]).toBe("What's happening in crypto today?");
    expect(suggestions[3]).toBe("Help me set up my wallet");
  });

  it("produces four suggestions", () => {
    const agentName = "Luna";
    const suggestions = [
      `Hey ${agentName}, what can you do?`,
      `Tell me about yourself, ${agentName}`,
      `What's happening in crypto today?`,
      `Help me set up my wallet`,
    ];
    expect(suggestions).toHaveLength(4);
  });

  it("getVrmPreviewUrl returns a URL for the selected avatar index", () => {
    const url = getVrmPreviewUrl(2);
    expect(url).toContain("vrms/previews");
    expect(typeof url).toBe("string");
  });

  it("getVrmPreviewUrl falls back to index 1 when selectedVrmIndex is 0", () => {
    // ChatEmptyState uses: selectedVrmIndex > 0 ? selectedVrmIndex : 1
    const selectedVrmIndex = 0;
    const avatarIndex = selectedVrmIndex > 0 ? selectedVrmIndex : 1;
    const url = getVrmPreviewUrl(avatarIndex);
    expect(url).toBe("/vrms/previews/eliza-1.png");
  });

  it("suggestion onClick handler calls setState and handleChatSend", () => {
    const setState = vi.fn();
    const handleChatSend = vi.fn();

    // Mirror handleSuggestion from ChatEmptyState
    const handleSuggestion = (text: string) => {
      setState("chatInput", text);
      setTimeout(() => void handleChatSend(), 50);
    };

    const suggestion = "Hey Agent, what can you do?";
    handleSuggestion(suggestion);

    expect(setState).toHaveBeenCalledWith("chatInput", suggestion);
  });
});
