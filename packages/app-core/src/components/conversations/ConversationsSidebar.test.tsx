// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appState, clientMock, ptySessionsMock } = vi.hoisted(() => ({
  appState: {
    value: null as unknown,
  },
  clientMock: {
    getConversationMessages: vi.fn(),
    getInboxChats: vi.fn(),
    spawnShellSession: vi.fn(),
  },
  ptySessionsMock: {
    value: [] as Array<Record<string, unknown>>,
  },
}));

function buildAppState(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [],
    activeConversationId: null,
    activeInboxChat: null,
    activeTerminalSessionId: null,
    unreadConversations: new Set<string>(),
    handleNewConversation: vi.fn(),
    handleSelectConversation: vi.fn(),
    handleDeleteConversation: vi.fn(),
    plugins: [],
    ensurePluginsLoaded: vi.fn(async () => {}),
    handlePluginToggle: vi.fn(),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    setState: vi.fn(),
    tab: "chat",
    t: (
      key: string,
      options?: { defaultValue?: string } & Record<string, unknown>,
    ) =>
      (options?.defaultValue ?? key).replace(
        /\{\{(\w+)\}\}/g,
        (_match, token: string) =>
          typeof options?.[token] === "string" ? options[token] : "",
      ),
    ...overrides,
  };
}

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => appState.value,
}));

vi.mock("../../state/PtySessionsContext", () => ({
  usePtySessions: () => ({ ptySessions: ptySessionsMock.value }),
}));

vi.mock("../pages/plugin-list-utils", () => ({
  ALWAYS_ON_PLUGIN_IDS: new Set<string>(),
  iconImageSource: () => null,
  resolveIcon: () => null,
}));

vi.mock("./ConversationRenameDialog", () => ({
  ConversationRenameDialog: () => null,
}));

// Minimal stubs for @elizaos/ui composite primitives — we only care about
// the sidebar wiring, not the rendered chrome.
vi.mock("@elizaos/ui", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  const Button = ({
    children,
    onClick,
    "aria-label": ariaLabel,
    title,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    "aria-label"?: string;
    title?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
  const NewActionButton = ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" data-testid="new-action" onClick={onClick}>
      {children}
    </button>
  );
  const Sidebar = ({
    children,
    footer,
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <>
      {children}
      {footer ? <div data-testid="sidebar-footer">{footer}</div> : null}
    </>
  );
  const SidebarContentNS = {
    SectionLabel: passthrough,
    SectionHeader: passthrough,
    RailItem: ({
      children,
      onClick,
      title,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      title?: string;
    }) => (
      <button type="button" onClick={onClick} title={title}>
        {children}
      </button>
    ),
    EmptyState: passthrough,
    Item: passthrough,
    ItemButton: ({
      children,
      onClick,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    ItemIcon: passthrough,
    ItemBody: passthrough,
  };
  return {
    Button,
    getChatSourceMeta: (_source: string) => ({
      Icon: () => null,
      label: "",
      iconClassName: "",
      badgeClassName: "",
      borderClassName: "",
    }),
    ChatConversationItem: ({
      conversation,
      onSelect,
    }: {
      conversation: { id: string; title: string };
      onSelect?: () => void;
    }) => (
      <button
        type="button"
        data-testid={`row-${conversation.id}`}
        onClick={onSelect}
      >
        {conversation.title}
      </button>
    ),
    ChatSourceIcon: () => null,
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuTrigger: passthrough,
    NewActionButton,
    Select: passthrough,
    SelectContent: passthrough,
    SelectItem: passthrough,
    SelectTrigger: passthrough,
    SelectValue: () => null,
    Sidebar,
    SidebarCollapsedActionButton: ({
      children,
      onClick,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    SidebarContent: SidebarContentNS,
    SidebarPanel: passthrough,
    SidebarScrollRegion: passthrough,
    TooltipProvider: passthrough,
    useIntervalWhenDocumentVisible: vi.fn(),
  };
});

import { ConversationsSidebar } from "./ConversationsSidebar";

function renderSidebar() {
  return render(<ConversationsSidebar />);
}

describe("ConversationsSidebar — Terminal channel", () => {
  beforeEach(() => {
    clientMock.getConversationMessages.mockReset();
    clientMock.getInboxChats.mockReset();
    clientMock.spawnShellSession.mockReset();
    clientMock.getConversationMessages.mockResolvedValue({ messages: [] });
    clientMock.getInboxChats.mockResolvedValue({ chats: [] });
    clientMock.spawnShellSession.mockResolvedValue({
      sessionId: "fresh-session-1",
    });
    ptySessionsMock.value = [];
    appState.value = buildAppState();
  });

  afterEach(() => {
    cleanup();
  });

  it("spawns a terminal when the Terminal section add button is clicked with no sessions", async () => {
    const setState = vi.fn();
    appState.value = buildAppState({ setState });

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("channel-section-add-terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-section-add-terminal"));
    });

    await waitFor(() => {
      expect(clientMock.spawnShellSession).toHaveBeenCalledTimes(1);
    });

    const terminalSetCalls = setState.mock.calls.filter(
      ([key]) => key === "activeTerminalSessionId",
    );
    expect(terminalSetCalls.at(-1)).toEqual([
      "activeTerminalSessionId",
      "fresh-session-1",
    ]);
    const inboxClears = setState.mock.calls.filter(
      ([key, value]) => key === "activeInboxChat" && value === null,
    );
    expect(inboxClears.length).toBeGreaterThan(0);
  });

  it("does not auto-spawn when the Terminal section is rendered with an existing PTY session", async () => {
    ptySessionsMock.value = [
      {
        sessionId: "existing-1",
        agentType: "shell",
        label: "existing",
        originalTask: "",
        workdir: "",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
        lastActivity: "",
      },
    ];

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("row-terminal:existing-1")).toBeDefined();
    });

    // Give any effect a tick to settle without auto-spawning.
    await new Promise((r) => setTimeout(r, 20));
    expect(clientMock.spawnShellSession).not.toHaveBeenCalled();
  });

  it("selecting an existing terminal row sets activeTerminalSessionId and clears activeInboxChat", async () => {
    ptySessionsMock.value = [
      {
        sessionId: "existing-row",
        agentType: "shell",
        label: "Existing",
        originalTask: "",
        workdir: "",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
        lastActivity: "",
      },
    ];
    const setState = vi.fn();
    appState.value = buildAppState({ setState });

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("row-terminal:existing-row")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("row-terminal:existing-row"));
    });

    expect(setState).toHaveBeenCalledWith(
      "activeTerminalSessionId",
      "existing-row",
    );
    expect(setState).toHaveBeenCalledWith("activeInboxChat", null);
  });

  it("clicking + New Terminal spawns and selects it without going through the scope button again", async () => {
    ptySessionsMock.value = [
      {
        sessionId: "existing-n",
        agentType: "shell",
        label: "Existing",
        originalTask: "",
        workdir: "",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
        lastActivity: "",
      },
    ];
    const setState = vi.fn();
    appState.value = buildAppState({ setState });
    clientMock.spawnShellSession.mockResolvedValue({
      sessionId: "brand-new",
    });

    renderSidebar();
    await waitFor(() => {
      expect(screen.getByTestId("channel-section-add-terminal")).toBeDefined();
    });

    const firstCalls = clientMock.spawnShellSession.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-section-add-terminal"));
    });

    await waitFor(() => {
      expect(clientMock.spawnShellSession.mock.calls.length).toBeGreaterThan(
        firstCalls,
      );
    });
    expect(setState).toHaveBeenCalledWith(
      "activeTerminalSessionId",
      "brand-new",
    );
  });

  it("shows a visible notice when a terminal session cannot start", async () => {
    const setActionNotice = vi.fn();
    appState.value = buildAppState({ setActionNotice });
    clientMock.spawnShellSession.mockRejectedValueOnce(new Error("denied"));

    renderSidebar();
    await waitFor(() => {
      expect(screen.getByTestId("channel-section-add-terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("channel-section-add-terminal"));
    });

    await waitFor(() => {
      expect(setActionNotice).toHaveBeenCalledWith(
        "Failed to start terminal: denied",
        "error",
        4800,
      );
    });
  });

  it("hides legacy page-room titles and untitled empty stubs from Messages", async () => {
    appState.value = buildAppState({
      conversations: [
        {
          id: "legacy-settings",
          title: "Settings",
          roomId: "room-settings",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
        {
          id: "empty-default",
          title: "default",
          roomId: "room-default",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
        {
          id: "real-chat",
          title: "Project chat",
          roomId: "room-real",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
    });

    clientMock.getConversationMessages.mockImplementation(async (id: string) =>
      id === "empty-default"
        ? { messages: [{ id: "m1", role: "assistant", text: "hey" }] }
        : { messages: [{ id: "m2", role: "user", text: "hi" }] },
    );

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("row-real-chat")).toBeDefined();
    });

    expect(screen.queryByTestId("row-legacy-settings")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId("row-empty-default")).toBeNull();
    });
  });

  it("renders the manage footer control with a visible label", async () => {
    renderSidebar();

    const manageToggle = screen.getByTestId("chat-sidebar-manage-toggle");
    expect(manageToggle.textContent).toContain("Manage");
  });
});
