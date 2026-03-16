import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

const {
  mockGetAgentAutomationMode,
  mockSetAgentAutomationMode,
  mockGetTradePermissionMode,
  mockSetTradePermissionMode,
} = vi.hoisted(() => ({
  mockGetAgentAutomationMode: vi.fn(),
  mockSetAgentAutomationMode: vi.fn(),
  mockGetTradePermissionMode: vi.fn(),
  mockSetTradePermissionMode: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("../../src/components/ChatView.js", () => ({
  ChatView: () => React.createElement("section", null, "ChatView Ready"),
}));

vi.mock("../../src/components/ConversationsSidebar.js", () => ({
  ConversationsSidebar: () =>
    React.createElement("aside", null, "ConversationsSidebar Ready"),
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getAgentAutomationMode: mockGetAgentAutomationMode,
    setAgentAutomationMode: mockSetAgentAutomationMode,
    getTradePermissionMode: mockGetTradePermissionMode,
    setTradePermissionMode: mockSetTradePermissionMode,
  },
}));

import { ChatModalView } from "../../src/components/ChatModalView";

function createContext() {
  return {
    t: (k: string) => k,
    conversations: [
      {
        id: "conv-1",
        title: "General",
        roomId: "room-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    activeConversationId: "conv-1",
    onboardingLoading: false,
    startupPhase: "ready",
    conversationMessages: [],
    chatSending: false,
    handleNewConversation: vi.fn(async () => {}),
    handleChatClear: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    uiLanguage: "en",
  };
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

describe("ChatModalView", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockGetAgentAutomationMode.mockReset();
    mockSetAgentAutomationMode.mockReset();
    mockGetTradePermissionMode.mockReset();
    mockSetTradePermissionMode.mockReset();
    mockGetAgentAutomationMode.mockResolvedValue({
      mode: "connectors-only",
      options: ["connectors-only", "full"],
    });
    mockSetAgentAutomationMode.mockImplementation(async (mode) => ({
      mode,
      options: ["connectors-only", "full"],
    }));
    mockGetTradePermissionMode.mockResolvedValue({
      mode: "user-sign-only",
      options: ["user-sign-only", "manual-local-key", "agent-auto"],
    });
    mockSetTradePermissionMode.mockImplementation(async (mode) => ({
      mode,
      options: ["user-sign-only", "manual-local-key", "agent-auto"],
    }));
    mockUseApp.mockReturnValue(createContext());
  });

  it("renders full overlay layout by default", async () => {
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ChatModalView));
    });

    const overlays = tree?.root.findAll(
      (node) => node.props["data-chat-game-overlay"] === true,
    );
    expect(overlays.length).toBe(1);

    const shells = tree?.root.findAll(
      (node) => node.props["data-chat-game-shell"] === true,
    );
    expect(shells.length).toBe(1);

    const content = textOf(tree?.root);
    expect(content).toContain("ChatView Ready");
    expect(content).toContain("ConversationsSidebar Ready");
  });

  it("renders companion dock layout", async () => {
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ChatModalView, {
          variant: "companion-dock",
        }),
      );
    });

    const docks = tree?.root.findAll(
      (node) => node.props["data-chat-game-dock"] === true,
    );
    expect(docks.length).toBe(1);

    const overlays = tree?.root.findAll(
      (node) => node.props["data-chat-game-overlay"] === true,
    );
    expect(overlays.length).toBe(0);

    const shell = tree?.root.find(
      (node) => node.props["data-chat-game-shell"] === true,
    );
    const thread = tree?.root.find(
      (node) => node.props["data-chat-game-thread"] === true,
    );
    expect(String(shell.props.className)).toContain("overflow-visible");
    expect(String(thread.props.className)).toContain("overflow-visible");
  });

  it("does not boot a new conversation in companion dock when none is active", async () => {
    const handleNewConversation = vi.fn(async () => {});
    mockUseApp.mockReturnValue({
      ...createContext(),
      activeConversationId: null,
      handleNewConversation,
    });

    await act(async () => {
      TestRenderer.create(
        React.createElement(ChatModalView, {
          variant: "companion-dock",
        }),
      );
    });

    expect(handleNewConversation).not.toHaveBeenCalled();
  });

  it("does not boot a new conversation before startup restore finishes", async () => {
    const handleNewConversation = vi.fn(async () => {});
    mockUseApp.mockReturnValue({
      ...createContext(),
      activeConversationId: null,
      onboardingLoading: true,
      handleNewConversation,
    });

    await act(async () => {
      TestRenderer.create(
        React.createElement(ChatModalView, {
          variant: "companion-dock",
        }),
      );
    });

    expect(handleNewConversation).not.toHaveBeenCalled();
  });
});
