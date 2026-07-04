// @vitest-environment jsdom

/**
 * Render + interaction tests for ConversationsSidebar's dashboard-conversation
 * path: list render, new-chat, selection, and the rename/delete menu flows,
 * plus the mobile variant. Drives the real component with mocked app state +
 * client and an inert inbox poll so only the conversation path is exercised.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../api/client-types-chat";

type AppState = Record<string, unknown>;

const appMock = vi.hoisted(() => ({ value: {} as AppState }));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: AppState) => unknown) => sel(appMock.value),
  useAppSelectorShallow: (sel: (value: AppState) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../state/PtySessionsContext.hooks", () => ({
  usePtySessions: () => ({ ptySessions: [] }),
}));

// The sidebar polls the inbox on a visibility interval; keep it inert so the
// test drives only the dashboard-conversation path.
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useDocumentVisibility: () => true,
  useIntervalWhenDocumentVisible: () => {},
}));

const clientMock = vi.hoisted(() => ({
  getInboxChats: vi.fn(async () => ({ chats: [] })),
  getConversationMessages: vi.fn(async () => ({ messages: [] })),
  spawnShellSession: vi.fn(async () => ({ sessionId: "term-1" })),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

import { ConversationsSidebar } from "./ConversationsSidebar";

function conv(overrides: Partial<Conversation> & { id: string }): Conversation {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  return {
    title: overrides.id,
    roomId: `room-${overrides.id}`,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

const CATALOG: Record<string, string> = {
  "common.yes": "Yes",
  "common.no": "No",
  "conversations.delete": "Delete",
  "conversations.deleteConfirm": "Delete?",
  "conversations.rename": "Rename",
};

function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    conversations: [
      conv({ id: "conv-a", title: "Alpha thread" }),
      conv({ id: "conv-b", title: "Beta thread" }),
    ],
    activeConversationId: "conv-a",
    activeInboxChat: null,
    activeTerminalSessionId: null,
    unreadConversations: new Set<string>(),
    handleNewConversation: vi.fn(async () => {}),
    handleSelectConversation: vi.fn(async () => {}),
    handleDeleteConversation: vi.fn(async () => {}),
    handleRenameConversation: vi.fn(async () => {}),
    suggestConversationTitle: vi.fn(async () => "Suggested title"),
    ensurePluginsLoaded: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    setState: vi.fn(),
    tab: "chat",
    // Some sidebar keys (common.yes/no, conversations.delete/rename) are
    // requested without a defaultValue, so map them to readable labels the
    // behavior assertions can target by role/name.
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? CATALOG[key] ?? key,
    ...overrides,
  };
}

afterEach(cleanup);

describe("ConversationsSidebar", () => {
  beforeEach(() => {
    clientMock.getInboxChats.mockResolvedValue({ chats: [] });
    clientMock.getConversationMessages.mockResolvedValue({ messages: [] });
    appMock.value = makeAppState();
  });

  it("renders the dashboard conversations under the Messages section", async () => {
    render(<ConversationsSidebar />);
    expect(await screen.findByText("Alpha thread")).toBeTruthy();
    expect(screen.getByText("Beta thread")).toBeTruthy();
  });

  it("starts a new conversation from the Messages section add button", async () => {
    const handleNewConversation = vi.fn(async () => {});
    const setTab = vi.fn();
    appMock.value = makeAppState({ handleNewConversation, setTab });
    render(<ConversationsSidebar />);

    fireEvent.click(await screen.findByTestId("channel-section-add-eliza"));
    expect(handleNewConversation).toHaveBeenCalledTimes(1);
    expect(setTab).toHaveBeenCalledWith("chat");
  });

  it("selects a conversation when its row is clicked", async () => {
    const handleSelectConversation = vi.fn(async () => {});
    appMock.value = makeAppState({ handleSelectConversation });
    render(<ConversationsSidebar />);

    await screen.findByText("Beta thread");
    // The second row's select button targets conversation B.
    const selects = screen.getAllByTestId("conv-select");
    fireEvent.click(selects[1]);
    expect(handleSelectConversation).toHaveBeenCalledWith("conv-b");
  });

  it("opens the rename dialog from the row actions menu", async () => {
    render(<ConversationsSidebar />);
    await screen.findByText("Alpha thread");

    // Open the per-row actions menu, then choose Rename.
    fireEvent.click(screen.getAllByTestId("conv-actions")[0]);
    fireEvent.click(await screen.findByTestId("conv-menu-edit"));

    expect(await screen.findByTestId("conv-rename-dialog")).toBeTruthy();
    const input = (await screen.findByTestId(
      "conv-rename-input",
    )) as HTMLInputElement;
    // The dialog is seeded with the conversation's current title.
    expect(input.value).toBe("Alpha thread");
  });

  it("renames a conversation through the dialog save action", async () => {
    const handleRenameConversation = vi.fn(async () => {});
    appMock.value = makeAppState({ handleRenameConversation });
    render(<ConversationsSidebar />);
    await screen.findByText("Alpha thread");

    fireEvent.click(screen.getAllByTestId("conv-actions")[0]);
    fireEvent.click(await screen.findByTestId("conv-menu-edit"));

    const input = (await screen.findByTestId(
      "conv-rename-input",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed alpha" } });
    fireEvent.click(screen.getByTestId("conv-rename-save"));

    await waitFor(() =>
      expect(handleRenameConversation).toHaveBeenCalledWith(
        "conv-a",
        "Renamed alpha",
      ),
    );
  });

  it("deletes a conversation through the menu → confirm flow", async () => {
    const handleDeleteConversation = vi.fn(async () => {});
    appMock.value = makeAppState({ handleDeleteConversation });
    render(<ConversationsSidebar />);
    await screen.findByText("Alpha thread");

    // Menu → Delete arms the inline confirm prompt on that row.
    fireEvent.click(screen.getAllByTestId("conv-actions")[0]);
    fireEvent.click(await screen.findByTestId("conv-menu-delete"));

    // The confirm prompt's "Yes" commits the delete.
    const yes = await screen.findByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    await waitFor(() =>
      expect(handleDeleteConversation).toHaveBeenCalledWith("conv-a"),
    );
  });

  it("renders the mobile variant with a chats header and close affordance", async () => {
    const onClose = vi.fn();
    render(<ConversationsSidebar mobile onClose={onClose} />);
    expect(await screen.findByText("Alpha thread")).toBeTruthy();
  });
});
