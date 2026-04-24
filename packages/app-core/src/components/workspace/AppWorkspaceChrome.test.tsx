// @vitest-environment jsdom

import { useWorkspaceMobileSidebarControls } from "@elizaos/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppWorkspaceChrome,
  useAppWorkspaceChatChrome,
} from "./AppWorkspaceChrome";

var useMediaQueryMock = vi.fn();

vi.mock("../../hooks", () => ({
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock("../pages/ChatView.js", () => ({
  ChatView: () => <div data-testid="default-chat" />,
}));

vi.mock("../pages/PageScopedChatPane.js", () => ({
  PageScopedChatPane: ({
    footerActions,
    scope,
  }: {
    footerActions?: ReactNode;
    scope: string;
  }) => (
    <div data-testid="page-scoped-chat">
      <span>{scope}</span>
      {footerActions ? (
        <div data-testid="page-scoped-chat-footer-actions">{footerActions}</div>
      ) : null}
    </div>
  ),
}));

describe("AppWorkspaceChrome", () => {
  beforeEach(() => {
    useMediaQueryMock.mockReset();
    useMediaQueryMock.mockReturnValue(false);
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("keeps page controls in the main pane beside the full-height chat sidebar", () => {
    render(
      <AppWorkspaceChrome
        testId="browser-shell"
        nav={<div data-testid="browser-controls">Browser controls</div>}
        main={<div data-testid="browser-main">Browser content</div>}
        chat={<div data-testid="browser-chat">Chat content</div>}
      />,
    );

    const root = screen.getByTestId("browser-shell");
    const leftPane = root.firstElementChild;
    const chatSidebar = screen.getByTestId("browser-shell-chat-sidebar");
    const browserControls = screen.getByTestId("browser-controls");
    const browserMain = screen.getByTestId("browser-main");

    expect(leftPane).not.toBeNull();
    expect(leftPane?.contains(browserControls)).toBe(true);
    expect(leftPane?.contains(browserMain)).toBe(true);
    expect(chatSidebar.parentElement).toBe(root);
    expect(chatSidebar.previousElementSibling).toBe(leftPane);
    expect(chatSidebar.contains(browserControls)).toBe(false);

    const resizeHandle = screen.getByTestId("browser-shell-chat-resize-handle");
    expect(resizeHandle.tagName).toBe("HR");
    expect(resizeHandle.className).toContain("inset-y-0");
  });

  it("renders page-scoped chat when a chat scope is provided", () => {
    render(
      <AppWorkspaceChrome
        testId="apps-shell"
        chatScope="page-apps"
        main={<div data-testid="apps-main">Apps</div>}
      />,
    );

    expect(screen.queryByTestId("default-chat")).toBeNull();
    expect(screen.getByTestId("page-scoped-chat").textContent).toBe(
      "page-apps",
    );
    expect(screen.queryByTestId("page-scoped-chat-footer-actions")).toBeNull();
    const collapseButton = screen.getByTestId("apps-shell-chat-collapse");
    expect(collapseButton.className).toContain("bottom-2");
    expect(collapseButton.className).toContain("right-2");
    expect(collapseButton.className).toContain("h-6");
    expect(collapseButton.className).toContain("w-6");
    expect(collapseButton.className).toContain("bg-transparent");
    expect(collapseButton.className).not.toContain("bg-card/85");
    expect(collapseButton.className).not.toContain("shadow-md");
    expect(collapseButton.className).not.toContain("border-border/40");

    fireEvent.click(collapseButton);

    const collapsedSidebar = screen.getByTestId("apps-shell-chat-sidebar");
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    const expandButton = screen.getByTestId("apps-shell-chat-expand");
    expect(expandButton.className).toContain("bottom-2");
    expect(expandButton.className).toContain("right-2");
    expect(expandButton.className).toContain("h-6");
    expect(expandButton.className).toContain("w-6");
    expect(expandButton.className).toContain("bg-transparent");
    expect(expandButton.className).not.toContain("bg-card/85");
    expect(expandButton.className).not.toContain("shadow-md");
    expect(expandButton.className).not.toContain("border-border/40");
  });

  it("omits the right chat rail when the main surface owns chat", () => {
    render(
      <AppWorkspaceChrome
        testId="game-shell"
        chatScope="page-apps"
        chatDisabled
        main={<div data-testid="game-main">Game content</div>}
      />,
    );

    expect(screen.getByTestId("game-main")).toBeTruthy();
    expect(screen.queryByTestId("page-scoped-chat")).toBeNull();
    expect(screen.queryByTestId("game-shell-chat-sidebar")).toBeNull();
    expect(screen.queryByTestId("game-shell-chat-collapse")).toBeNull();
  });

  it("does not reserve right-chat width on mobile until the user opens it", () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    render(
      <AppWorkspaceChrome
        testId="mobile-shell"
        main={<div data-testid="mobile-main">Mobile content</div>}
        chat={<div data-testid="mobile-chat">Chat content</div>}
      />,
    );

    const collapsedSidebar = screen.getByTestId("mobile-shell-chat-sidebar");
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    expect(screen.getByTestId("mobile-main")).toBeTruthy();
    expect(screen.queryByTestId("mobile-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-shell-chat-resize-handle")).toBeNull();

    expect(
      screen.getByTestId("app-workspace-mobile-pane-switcher"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("app-workspace-mobile-pane-chat"));

    const openSidebar = screen.getByTestId("mobile-shell-chat-sidebar");
    expect(openSidebar.className).toContain("w-full");
    expect(openSidebar.className).toContain("flex-1");
    expect(openSidebar.getAttribute("style") ?? "").not.toContain("width");
    expect(screen.queryByTestId("mobile-shell-chat-backdrop")).toBeNull();
    expect(screen.getByTestId("mobile-chat")).toBeTruthy();

    fireEvent.click(screen.getByTestId("app-workspace-mobile-pane-main"));

    const closedSidebar = screen.getByTestId("mobile-shell-chat-sidebar");
    expect(closedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    expect(screen.queryByTestId("mobile-chat")).toBeNull();
    expect(screen.getByTestId("app-workspace-mobile-pane-chat")).toBeTruthy();
  });

  it("splits mobile controls into left sidebar, content, and right chat", async () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    function RegisteredSidebar() {
      const controls = useWorkspaceMobileSidebarControls();
      const [open, setOpen] = useState(false);

      useEffect(() => {
        return controls?.register({
          id: "test-sidebar",
          label: "Test sidebar",
          open,
          setOpen,
        });
      }, [controls, open]);

      return (
        <div data-testid={open ? "registered-sidebar-open" : "main-content"}>
          {open ? "Sidebar" : "Main"}
        </div>
      );
    }

    render(
      <AppWorkspaceChrome
        testId="three-pane-shell"
        main={<RegisteredSidebar />}
        chat={<div data-testid="three-pane-chat">Chat content</div>}
      />,
    );

    const leftButton = await screen.findByTestId(
      "app-workspace-mobile-pane-left",
    );
    expect(screen.getByTestId("app-workspace-mobile-pane-main")).toBeTruthy();
    expect(screen.getByTestId("app-workspace-mobile-pane-chat")).toBeTruthy();

    fireEvent.click(leftButton);

    expect(screen.getByTestId("registered-sidebar-open")).toBeTruthy();
    expect(leftButton.getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByTestId("app-workspace-mobile-pane-main"));

    expect(screen.getByTestId("main-content")).toBeTruthy();
    expect(
      screen
        .getByTestId("app-workspace-mobile-pane-main")
        .getAttribute("aria-current"),
    ).toBe("page");

    fireEvent.click(screen.getByTestId("app-workspace-mobile-pane-chat"));

    expect(screen.getByTestId("three-pane-chat")).toBeTruthy();
    expect(screen.queryByTestId("registered-sidebar-open")).toBeNull();
    expect(
      screen
        .getByTestId("app-workspace-mobile-pane-chat")
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("omits the mobile right pane button when chat is disabled", async () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    function RegisteredSidebar() {
      const controls = useWorkspaceMobileSidebarControls();
      const [open, setOpen] = useState(false);

      useEffect(() => {
        return controls?.register({
          id: "disabled-chat-sidebar",
          open,
          setOpen,
        });
      }, [controls, open]);

      return (
        <div data-testid={open ? "disabled-chat-sidebar-open" : "main-only"}>
          {open ? "Sidebar" : "Main"}
        </div>
      );
    }

    render(
      <AppWorkspaceChrome
        chatDisabled
        testId="disabled-chat-shell"
        main={<RegisteredSidebar />}
      />,
    );

    const leftButton = await screen.findByTestId(
      "app-workspace-mobile-pane-left",
    );

    expect(screen.getByTestId("app-workspace-mobile-pane-main")).toBeTruthy();
    expect(screen.queryByTestId("app-workspace-mobile-pane-chat")).toBeNull();

    fireEvent.click(leftButton);
    expect(screen.getByTestId("disabled-chat-sidebar-open")).toBeTruthy();

    fireEvent.click(screen.getByTestId("app-workspace-mobile-pane-main"));
    expect(screen.getByTestId("main-only")).toBeTruthy();
    expect(screen.queryByTestId("disabled-chat-shell-chat-sidebar")).toBeNull();
  });

  it("lets main-pane content open chat through the workspace chrome context", () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    function OpenChatFromMain() {
      const chatChrome = useAppWorkspaceChatChrome();

      return (
        <button
          type="button"
          data-testid="main-open-chat"
          onClick={() => chatChrome?.openChat()}
        >
          Open chat
        </button>
      );
    }

    render(
      <AppWorkspaceChrome
        testId="main-chat-shell"
        main={<OpenChatFromMain />}
        chat={<div data-testid="main-chat">Chat content</div>}
      />,
    );

    expect(screen.queryByTestId("main-chat")).toBeNull();

    fireEvent.click(screen.getByTestId("main-open-chat"));

    expect(screen.getByTestId("main-chat")).toBeTruthy();
    expect(screen.queryByTestId("main-chat-shell-chat-backdrop")).toBeNull();
    expect(
      screen
        .getByTestId("app-workspace-mobile-pane-chat")
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("lets chat content own the collapse control row", () => {
    function InlineCollapseOwner() {
      const chatChrome = useAppWorkspaceChatChrome();

      return (
        <button
          type="button"
          data-testid="inline-chat-collapse"
          onClick={() => chatChrome?.collapseChat()}
        >
          Collapse inline
        </button>
      );
    }

    render(
      <AppWorkspaceChrome
        testId="owned-footer-shell"
        hideCollapseButton
        main={<div data-testid="owned-footer-main">Owned footer content</div>}
        chat={<InlineCollapseOwner />}
      />,
    );

    expect(screen.queryByTestId("owned-footer-shell-chat-collapse")).toBeNull();

    fireEvent.click(screen.getByTestId("inline-chat-collapse"));

    const collapsedSidebar = screen.getByTestId(
      "owned-footer-shell-chat-sidebar",
    );
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    expect(screen.getByTestId("owned-footer-shell-chat-expand")).toBeTruthy();
  });
});
