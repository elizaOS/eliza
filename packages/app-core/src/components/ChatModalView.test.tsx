// @vitest-environment jsdom
import * as AppContext from "@elizaos/app-core/state";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ChatModalView } from "./ChatModalView";

vi.mock("@elizaos/app-core/state", () => ({
  useApp: vi.fn(),
}));

vi.mock("./ChatView.js", () => ({
  ChatView: ({ variant }: { variant?: string }) =>
    React.createElement("div", {
      "data-testid": "chat-view",
      "data-variant": variant,
    }),
}));

vi.mock("./ConversationsSidebar.js", () => ({
  ConversationsSidebar: ({
    mobile,
    variant,
  }: {
    mobile?: boolean;
    variant?: string;
  }) =>
    React.createElement("div", {
      "data-testid": "conversations-sidebar",
      "data-mobile": mobile ?? false,
      "data-variant": variant ?? "default",
    }),
}));

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe("ChatModalView", () => {
  it("reveals the desktop conversations rail in companion dock mode", async () => {
    mockMatchMedia(false);
    // @ts-expect-error - test only relies on the active conversation field.
    vi.spyOn(AppContext, "useApp").mockReturnValue({
      activeConversationId: null,
      conversations: [],
      unreadConversations: new Set(),
      handleNewConversation: vi.fn(),
      handleSelectConversation: vi.fn(),
      handleDeleteConversation: vi.fn(),
      handleRenameConversation: vi.fn(),
      t: (key: string) => key,
    });

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(
        <ChatModalView variant="companion-dock" showSidebar />,
      );
    });

    if (!testRenderer) {
      throw new Error("Failed to render ChatModalView");
    }

    const sidebarShell = testRenderer.root.findByProps({
      "data-chat-game-sidebar": true,
    });
    expect(String(sidebarShell.props.className)).toContain("md:flex");
  });

  it("renders a mobile conversations overlay when the companion rail is toggled on a narrow viewport", async () => {
    mockMatchMedia(true);
    // @ts-expect-error - test only relies on the active conversation field.
    vi.spyOn(AppContext, "useApp").mockReturnValue({
      activeConversationId: null,
      conversations: [],
      unreadConversations: new Set(),
      handleNewConversation: vi.fn(),
      handleSelectConversation: vi.fn(),
      handleDeleteConversation: vi.fn(),
      handleRenameConversation: vi.fn(),
      t: (key: string) => key,
    });

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(
        <ChatModalView
          variant="companion-dock"
          showSidebar
          onSidebarClose={vi.fn()}
        />,
      );
    });

    if (!testRenderer) {
      throw new Error("Failed to render ChatModalView");
    }

    const sidebarInstances = testRenderer.root.findAllByProps({
      "data-testid": "conversations-sidebar",
    });

    expect(
      sidebarInstances.some((node) => node.props["data-mobile"] === true),
    ).toBe(true);
  });
});
