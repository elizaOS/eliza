// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ConversationStub = {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
};

type SidebarContextStub = {
  conversations: ConversationStub[];
  activeConversationId: string | null;
  unreadConversations: Set<string>;
  handleStartDraftConversation: () => Promise<void>;
  handleNewConversation: () => Promise<void>;
  handleSelectConversation: (id: string) => Promise<void>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleRenameConversation: (id: string, title: string) => Promise<void>;
  uiLanguage: "en" | "zh-CN";
  t: (k: string) => string;
};

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

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getAgentSelfStatus: vi.fn(async () => null),
    onWsEvent: vi.fn(() => () => { }),
  },
}));

import { ConversationsSidebar } from "../../src/components/ConversationsSidebar";

function createContext(
  overrides?: Partial<SidebarContextStub>,
): SidebarContextStub {
  const now = Date.now();
  return {
    t: (k: string) => k,
    conversations: [
      {
        id: "conv-1",
        title: "First room",
        roomId: "room-1",
        createdAt: new Date(now - 30_000).toISOString(),
        updatedAt: new Date(now - 30_000).toISOString(),
      },
      {
        id: "conv-2",
        title: "Newest room",
        roomId: "room-2",
        createdAt: new Date(now - 10_000).toISOString(),
        updatedAt: new Date(now - 10_000).toISOString(),
      },
    ],
    activeConversationId: "conv-2",
    unreadConversations: new Set(["conv-1"]),
    handleStartDraftConversation: vi.fn(async () => { }),
    handleNewConversation: vi.fn(async () => { }),
    handleSelectConversation: vi.fn(async () => { }),
    handleDeleteConversation: vi.fn(async () => { }),
    handleRenameConversation: vi.fn(async () => { }),
    uiLanguage: "en",
    ...overrides,
  };
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

describe("ConversationsSidebar game-modal variant", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    vi.clearAllMocks();
  });

  it("renders game-modal list and keeps new/select/delete actions working", async () => {
    const handleStartDraftConversation = vi.fn(async () => { });
    const handleNewConversation = vi.fn(async () => { });
    const handleSelectConversation = vi.fn(async () => { });
    const handleDeleteConversation = vi.fn(async () => { });

    mockUseApp.mockReturnValue(
      createContext({
        handleStartDraftConversation,
        handleNewConversation,
        handleSelectConversation,
        handleDeleteConversation,
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ConversationsSidebar, { variant: "game-modal" }),
      );
    });

    const roots = tree?.root.findAll(
      (node) =>
        node.props["data-testid"] === "conversations-sidebar" &&
        node.props["data-variant"] === "game-modal",
    );
    expect(roots.length).toBe(1);

    const newChatButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        textOf(node).trim() === "conversations.newChat",
    );
    expect(newChatButtons.length).toBe(1);
    await act(async () => {
      newChatButtons[0].props.onClick();
    });
    expect(handleStartDraftConversation).toHaveBeenCalledTimes(1);
    expect(handleNewConversation).not.toHaveBeenCalled();

    const convItems = tree?.root.findAll(
      (node) =>
        node.props["data-testid"] === "conv-item" &&
        typeof node.type !== "function",
    );
    expect(convItems.length).toBe(2);

    const selectBtn = convItems[1].find(
      (node) =>
        node.type === "button" &&
        String(node.props.className).includes("flex-1"),
    );
    expect(String(selectBtn.props.className)).toContain("w-full");
    expect(String(selectBtn.props.className)).toContain("!text-left");
    const title = selectBtn.find(
      (node) => node.type === "span" && textOf(node).trim() === "First room",
    );
    expect(String(title.props.className)).toContain("block");
    expect(String(title.props.className)).toContain("text-left");
    await act(async () => {
      selectBtn.props.onClick();
    });
    expect(handleSelectConversation).toHaveBeenCalledWith("conv-1");

    const rowTrigger = tree?.root.findAllByProps({
      "data-testid": "conv-select",
    })[0];
    await act(async () => {
      rowTrigger.props.onContextMenu({
        preventDefault: () => { },
        stopPropagation: () => { },
        clientX: 32,
        clientY: 48,
      });
    });

    const deleteMenuItem = tree?.root.findByProps({
      "data-testid": "conv-menu-delete",
    });
    await act(async () => {
      deleteMenuItem.props.onClick();
    });

    const confirmYes = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        textOf(node).trim() === "conversations.deleteYes",
    );
    expect(confirmYes.length).toBe(1);
    await act(async () => {
      confirmYes[0].props.onClick();
    });
    expect(handleDeleteConversation).toHaveBeenCalledWith("conv-2");
  });

  it("supports inline rename in game-modal variant", async () => {
    const handleRenameConversation = vi.fn(async () => { });
    mockUseApp.mockReturnValue(
      createContext({
        handleRenameConversation,
      }),
    );

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(ConversationsSidebar, { variant: "game-modal" }),
      );
    });

    const rowTrigger = tree?.root.findAllByProps({
      "data-testid": "conv-select",
    })[0];
    await act(async () => {
      rowTrigger.props.onContextMenu({
        preventDefault: () => { },
        stopPropagation: () => { },
        clientX: 24,
        clientY: 40,
      });
    });

    const editMenuItem = tree?.root.findByProps({
      "data-testid": "conv-menu-edit",
    });
    await act(async () => {
      editMenuItem.props.onClick();
    });

    const input = tree?.root.findAll((node) => node.type === "input")[0];
    expect(input).toBeTruthy();

    await act(async () => {
      input?.props.onChange({ target: { value: "Renamed room" } });
    });
    await act(async () => {
      input?.props.onKeyDown({
        key: "Enter",
        preventDefault: () => { },
      });
    });

    expect(handleRenameConversation).toHaveBeenCalledWith(
      "conv-2",
      "Renamed room",
    );
  });
});
