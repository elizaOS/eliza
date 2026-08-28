/**
 * Deterministic checks for Memories feed cards, type filters, and empty
 * actions through the package's configured jsdom harness.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { __resetResourceCache, getCached } from "../../hooks/resource-cache";

const clientMock = vi.hoisted(() => ({
  getMemoryStats: vi.fn(),
  getRelationshipsPeople: vi.fn(),
  getMemoryFeed: vi.fn(),
  browseMemories: vi.fn(),
  getMemoriesByEntity: vi.fn(),
}));

const dispatchChatOpen = vi.hoisted(() => vi.fn());
const authorityMock = vi.hoisted(() => ({ value: "agent-a" }));

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../events", () => ({ dispatchChatOpen }));
vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityMock.value,
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (s: {
      t: (key: string, options?: { defaultValue?: string }) => string;
      setTab: () => void;
    }) => unknown,
  ) =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
      setTab: vi.fn(),
    }),
}));

import { MemoryViewerView } from "./MemoryViewerView";

function mockDesktopViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  mockDesktopViewport();
  __resetResourceCache();
  authorityMock.value = "agent-a";
  dispatchChatOpen.mockReset();
  clientMock.getMemoryStats.mockResolvedValue({
    total: 1,
    byType: { messages: 1 },
  });
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [] });
  clientMock.getMemoryFeed.mockResolvedValue({
    memories: [
      {
        id: "mem-1",
        type: "messages",
        text: "hello from the feed",
        source: "client_chat",
        createdAt: Date.now(),
        entityId: "entity-1",
        roomId: "room-1",
      },
    ],
    count: 1,
    limit: 50,
    hasMore: false,
  });
  clientMock.browseMemories.mockResolvedValue({
    memories: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
  clientMock.getMemoriesByEntity.mockResolvedValue({
    memories: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clientMock.getMemoryStats.mockReset();
  clientMock.getRelationshipsPeople.mockReset();
  clientMock.getMemoryFeed.mockReset();
  clientMock.browseMemories.mockReset();
  clientMock.getMemoriesByEntity.mockReset();
});

describe("MemoryViewerView interface contract", () => {
  it("leaves persistent chat clearance to the shared shell", async () => {
    render(<MemoryViewerView />);

    await screen.findByTestId("memory-card-mem-1");

    const workspace = screen.getByTestId("memory-viewer-view");
    const workspaceMain = workspace.querySelector("main");
    const scroller = screen.getByTestId("memory-content-scroll-region");
    expect(workspaceMain).not.toBeNull();
    expect(workspaceMain?.className).toContain("overflow-y-hidden");
    expect(workspaceMain?.className).not.toContain("overflow-y-auto");
    expect(workspaceMain?.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
    expect(workspaceMain?.querySelector(".overflow-y-auto")).toBe(scroller);
    expect(scroller.className).not.toContain("eliza-chat-scroll");
    expect(scroller.className).not.toContain("--eliza-chat-clearance");
    expect(scroller.className).not.toContain("--eliza-chat-side-clearance");
  });

  it("stacks memory cards and exposes expand state", async () => {
    render(<MemoryViewerView />);

    const card = await screen.findByTestId("memory-card-mem-1");
    expect(card.className).toContain("flex-col");
    expect(card.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Created")).not.toBeNull();
    expect(screen.queryByText("entity-1")).toBeNull();
    expect(screen.queryByText("client_chat")).toBeNull();
  });

  it("filters the feed from the type dropdown", async () => {
    const user = userEvent.setup();
    render(<MemoryViewerView />);

    const trigger = await screen.findByTestId("memory-type-filter-trigger");
    expect(trigger.textContent).toContain("All types");

    await user.click(trigger);
    await user.click(await screen.findByTestId("memory-type-filter-messages"));

    await waitFor(() => expect(trigger.textContent).toContain("Messages"));
    expect(clientMock.getMemoryFeed).toHaveBeenCalledWith(
      expect.objectContaining({ type: "messages" }),
    );
  });

  it("shows the seeded library as readable documents without machine labels", async () => {
    const documents = Array.from({ length: 13 }, (_, index) => ({
      id: `doc-${index + 1}`,
      type: "documents",
      text:
        index === 0
          ? "Eliza help: getting started\n\nQ: Where do I begin?\nA: Start with a conversation."
          : `Reference document ${index + 1}`,
      source: "eliza-default-documents",
      createdAt: Date.now() - index,
      entityId: null,
      roomId: null,
    }));
    clientMock.getMemoryStats.mockResolvedValue({
      total: 14,
      byType: { documents: 13, messages: 1 },
    });
    clientMock.getMemoryFeed.mockResolvedValue({
      memories: [
        {
          id: "greeting",
          type: "messages",
          text: "Welcome back",
          source: "agent_greeting",
          createdAt: Date.now(),
          entityId: null,
          roomId: null,
        },
        ...documents,
      ],
      count: 14,
      limit: 50,
      hasMore: false,
    });

    render(<MemoryViewerView />);

    expect(
      await screen.findByText("Eliza help: getting started"),
    ).not.toBeNull();
    expect(screen.getAllByTestId(/^memory-card-/)).toHaveLength(14);
    expect(screen.getByText(/Where do I begin\?/)).not.toBeNull();
    expect(screen.queryByText("agent_greeting")).toBeNull();
    expect(screen.queryByText("eliza-default-documents")).toBeNull();
  });

  it("keeps raw server errors out of the page state", async () => {
    clientMock.getMemoryFeed.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/memories/feed",
        message: "relation secret_memory_rows does not exist",
        status: 500,
      }),
    );

    render(<MemoryViewerView />);

    expect(
      await screen.findByText("Memories are temporarily unavailable"),
    ).not.toBeNull();
    expect(screen.queryByText(/secret_memory_rows/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
  });

  it("uses all identities when browsing a selected person's memories", async () => {
    const person = {
      groupId: "group-1",
      primaryEntityId: "entity-1",
      memberEntityIds: ["entity-1", "entity-alias"],
      displayName: "Ada Lovelace",
      aliases: [],
      platforms: [],
      identities: [],
      emails: [],
      phones: [],
      websites: [],
      preferredCommunicationChannel: null,
      categories: [],
      tags: [],
      factCount: 1,
      relationshipCount: 1,
    };
    clientMock.getRelationshipsPeople.mockResolvedValue({ people: [person] });
    clientMock.getMemoriesByEntity.mockResolvedValue({
      memories: [
        {
          id: "ada-memory",
          type: "facts",
          text: "Ada prefers concise updates",
          source: null,
          createdAt: Date.now(),
          entityId: "entity-1",
          roomId: null,
        },
      ],
      total: 1,
      totalIsExact: true,
      hasMore: false,
      limit: 50,
      offset: 0,
    });

    const user = userEvent.setup();
    render(<MemoryViewerView />);
    await user.click(await screen.findByTestId("memory-person-picker-trigger"));
    await user.click(await screen.findByText("Ada Lovelace"));

    await waitFor(() =>
      expect(clientMock.getMemoriesByEntity).toHaveBeenCalledWith(
        "entity-1",
        expect.objectContaining({
          entityIds: ["entity-1", "entity-alias"],
        }),
      ),
    );
    expect(
      await screen.findByText("Ada prefers concise updates"),
    ).not.toBeNull();
  });

  it("drops the selected person synchronously when the active authority changes", async () => {
    const person = {
      groupId: "group-a",
      primaryEntityId: "entity-a",
      memberEntityIds: ["entity-a"],
      displayName: "Agent A person",
      aliases: [],
      platforms: [],
      identities: [],
      emails: [],
      phones: [],
      websites: [],
      preferredCommunicationChannel: null,
      categories: [],
      tags: [],
      factCount: 1,
      relationshipCount: 1,
    };
    clientMock.getRelationshipsPeople.mockImplementation(() =>
      authorityMock.value === "agent-a"
        ? Promise.resolve({ people: [person] })
        : new Promise(() => undefined),
    );

    const user = userEvent.setup();
    const rendered = render(<MemoryViewerView />);
    await user.click(await screen.findByTestId("memory-person-picker-trigger"));
    await user.click(await screen.findByText("Agent A person"));
    await waitFor(() =>
      expect(clientMock.getMemoriesByEntity).toHaveBeenCalledWith(
        "entity-a",
        expect.any(Object),
      ),
    );
    clientMock.getMemoriesByEntity.mockClear();

    authorityMock.value = "agent-b";
    rendered.rerender(<MemoryViewerView />);
    await act(async () => undefined);

    expect(screen.queryByText("Agent A person")).toBeNull();
    expect(clientMock.getMemoriesByEntity).not.toHaveBeenCalled();
  });

  it("cancels an agent-A warm-up retry before the client repoints to agent B", async () => {
    vi.useFakeTimers();
    const requestedAuthorities: string[] = [];
    const agentBFeed = {
      memories: [
        {
          id: "agent-b-memory",
          type: "messages",
          text: "agent B only",
          source: "client_chat",
          createdAt: 2,
          entityId: "entity-b",
          roomId: "room-b",
        },
      ],
      count: 1,
      limit: 50,
      hasMore: false,
    };
    clientMock.getMemoryFeed.mockImplementation(() => {
      requestedAuthorities.push(authorityMock.value);
      if (authorityMock.value === "agent-a") {
        return Promise.reject(
          new ApiError({
            kind: "http",
            path: "/api/memories/feed",
            message: "Not found",
            status: 404,
          }),
        );
      }
      return Promise.resolve(agentBFeed);
    });

    const rendered = render(<MemoryViewerView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestedAuthorities).toEqual(["agent-a"]);

    authorityMock.value = "agent-b";
    rendered.rerender(<MemoryViewerView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(requestedAuthorities).toEqual(["agent-a", "agent-b"]);
    expect(getCached("memory:agent-a:feed:all")).toBeUndefined();
    expect(getCached("memory:agent-b:feed:all")?.data).toEqual(agentBFeed);
  });

  it("loads older tied-timestamp rows with the full tuple cursor", async () => {
    clientMock.getMemoryFeed
      .mockResolvedValueOnce({
        memories: [
          {
            id: "feed-newer",
            type: "messages",
            text: "newer tied row",
            source: "client_chat",
            createdAt: 200,
            entityId: "entity-1",
            roomId: "room-1",
          },
          {
            id: "feed-cursor",
            type: "messages",
            text: "cursor tied row",
            source: "client_chat",
            createdAt: 200,
            entityId: "entity-1",
            roomId: "room-1",
          },
        ],
        count: 2,
        limit: 50,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        memories: [
          {
            id: "feed-older-tie",
            type: "messages",
            text: "older tied row",
            source: "client_chat",
            createdAt: 200,
            entityId: "entity-1",
            roomId: "room-1",
          },
        ],
        count: 1,
        limit: 50,
        hasMore: false,
      });

    const user = userEvent.setup();
    render(<MemoryViewerView />);
    await user.click(await screen.findByRole("button", { name: "Load older" }));

    await waitFor(() =>
      expect(clientMock.getMemoryFeed).toHaveBeenCalledTimes(2),
    );
    expect(clientMock.getMemoryFeed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ before: 200, beforeId: "feed-cursor" }),
    );
    expect(await screen.findByText("older tied row")).not.toBeNull();
  });

  it("points the empty feed forward with Ask Eliza", async () => {
    clientMock.getMemoryStats.mockResolvedValue({ total: 0, byType: {} });
    clientMock.getMemoryFeed.mockResolvedValue({
      memories: [],
      count: 0,
      limit: 50,
      hasMore: false,
    });

    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(screen.getByText("No memories yet")).not.toBeNull(),
    );
    expect(
      screen.getByText("Chat with Eliza and memories will show up here."),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Eliza" }));
    expect(dispatchChatOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps pagination enabled while presenting an incomplete total honestly", async () => {
    clientMock.browseMemories.mockResolvedValue({
      memories: [
        {
          id: "mem-browse-1",
          type: "messages",
          text: "bounded browse result",
          source: "client_chat",
          createdAt: Date.now(),
          entityId: "entity-1",
          roomId: "room-1",
        },
      ],
      total: 51,
      totalIsExact: false,
      hasMore: true,
      limit: 50,
      offset: 0,
    });

    const user = userEvent.setup();
    render(<MemoryViewerView />);
    await user.click(await screen.findByTestId("memory-view-browse"));

    expect(await screen.findByText("bounded browse result")).not.toBeNull();
    expect(screen.getByText("1–1 of at least 51")).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
