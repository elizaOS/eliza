import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: (index: number) => `mock-vrm-${index}.png`,
  VRM_COUNT: 8,
}));

vi.mock("@elizaos/ui", async () => {
  const React = await import("react");
  const actual =
    await vi.importActual<typeof import("@elizaos/ui")>("@elizaos/ui");

  return {
    ...actual,
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuContent: ({
      children,
      ...props
    }: React.ComponentProps<"div">) =>
      React.createElement("div", props, children),
    DropdownMenuItem: ({
      children,
      onClick,
      ...props
    }: React.ComponentProps<"button">) =>
      React.createElement("button", { ...props, onClick }, children),
  };
});

import { ConversationsSidebar } from "../../src/components/ConversationsSidebar";

type ConversationStub = {
  id: string;
  title: string;
  updatedAt: string;
};

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    t: (k: string) => k,
    conversations: [
      {
        id: "conv-1",
        title: "First conversation",
        updatedAt: "2026-02-19T00:00:00.000Z",
      } satisfies ConversationStub,
    ],
    activeConversationId: "conv-1",
    unreadConversations: new Set<string>(),
    handleStartDraftConversation: vi.fn(async () => { }),
    handleNewConversation: vi.fn(),
    handleSelectConversation: vi.fn(async () => { }),
    handleDeleteConversation: vi.fn(async () => { }),
    handleRenameConversation: vi.fn(async () => { }),
    uiLanguage: "en",
    ...overrides,
  };
}

function findButtonByText(
  tree: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  return tree.root.find(
    (node) =>
      (node.type === "button" || typeof node.type === "function") &&
      node.children.some(
        (child) => typeof child === "string" && child === label,
      ),
  );
}

describe("ConversationsSidebar", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    if (typeof document !== "undefined") {
      document.addEventListener ??= vi.fn();
      document.removeEventListener ??= vi.fn();
    }
  });

  it("requires explicit confirmation before deleting", async () => {
    const handleDeleteConversation = vi.fn(async () => { });
    mockUseApp.mockReturnValue(createContext({ handleDeleteConversation }));

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConversationsSidebar));
    });

    const rowTrigger = tree.root.findByProps({
      "data-testid": "conv-select",
    });
    await act(async () => {
      rowTrigger.props.onContextMenu({
        preventDefault: () => { },
        stopPropagation: () => { },
        clientX: 40,
        clientY: 60,
      });
    });

    expect(handleDeleteConversation).not.toHaveBeenCalled();
    const deleteMenuItem = tree.root.findByProps({
      "data-testid": "conv-menu-delete",
    });
    await act(async () => {
      deleteMenuItem.props.onClick();
    });
    expect(findButtonByText(tree, "conversations.deleteYes")).toBeDefined();
    expect(findButtonByText(tree, "conversations.deleteNo")).toBeDefined();
  });

  it("deletes only after clicking Yes", async () => {
    const handleDeleteConversation = vi.fn(async () => { });
    mockUseApp.mockReturnValue(createContext({ handleDeleteConversation }));

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConversationsSidebar));
    });

    const rowTrigger = tree.root.findByProps({
      "data-testid": "conv-select",
    });
    await act(async () => {
      rowTrigger.props.onContextMenu({
        preventDefault: () => { },
        stopPropagation: () => { },
        clientX: 40,
        clientY: 60,
      });
    });

    const deleteMenuItem = tree.root.findByProps({
      "data-testid": "conv-menu-delete",
    });
    await act(async () => {
      deleteMenuItem.props.onClick();
    });

    const yesButton = findButtonByText(tree, "conversations.deleteYes");
    await act(async () => {
      yesButton.props.onClick();
      await Promise.resolve();
    });

    expect(handleDeleteConversation).toHaveBeenCalledTimes(1);
    expect(handleDeleteConversation).toHaveBeenCalledWith("conv-1");
  });

  it("starts a draft chat instead of creating a persisted conversation immediately", async () => {
    const handleStartDraftConversation = vi.fn(async () => { });
    const handleNewConversation = vi.fn(async () => { });
    mockUseApp.mockReturnValue(
      createContext({
        handleStartDraftConversation,
        handleNewConversation,
      }),
    );

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConversationsSidebar));
    });

    const newChatButton = findButtonByText(tree, "conversations.newChat");
    await act(async () => {
      newChatButton.props.onClick();
    });

    expect(handleStartDraftConversation).toHaveBeenCalledTimes(1);
    expect(handleNewConversation).not.toHaveBeenCalled();
  });
});
