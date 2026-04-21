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
    setTab: vi.fn(),
    setState: vi.fn(),
    tab: "chat",
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
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
    Sidebar: passthrough,
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
  };
});

import { ConversationsSidebar } from "./ConversationsSidebar";

function renderSidebar() {
  return render(<ConversationsSidebar />);
}

describe("ConversationsSidebar — Terminal channel", () => {
  beforeEach(() => {
    clientMock.getInboxChats.mockReset();
    clientMock.spawnShellSession.mockReset();
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

  it("auto-spawns a terminal when the Terminal scope is clicked with no sessions", async () => {
    const setState = vi.fn();
    appState.value = buildAppState({ setState });

    renderSidebar();

    await waitFor(() => {
      // Terminal scope button is always rendered
      expect(screen.getByTitle("Terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Terminal"));
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

  it("does not auto-spawn if a PTY session already exists", async () => {
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
      expect(screen.getByTitle("Terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Terminal"));
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
      expect(screen.getByTitle("Terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Terminal"));
    });

    // Row for existing session should now be rendered; click it. Terminal
    // rows get a "terminal:" prefix applied by the sidebar's rowListId.
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
      expect(screen.getByTitle("Terminal")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Terminal"));
    });

    // The sidebar uses `conversations.newTerminalShort` (default "New") as
    // the button label when the Terminal channel is active.
    await waitFor(() => {
      expect(screen.getByText("New")).toBeDefined();
    });

    const firstCalls = clientMock.spawnShellSession.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByText("New"));
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
});
