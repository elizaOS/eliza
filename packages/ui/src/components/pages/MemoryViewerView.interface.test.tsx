/**
 * Deterministic checks for Memories feed cards, type filters, and empty
 * actions through the package's configured jsdom harness.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetResourceCache } from "../../hooks/resource-cache";

const clientMock = vi.hoisted(() => ({
  getMemoryStats: vi.fn(),
  getRelationshipsPeople: vi.fn(),
  getMemoryFeed: vi.fn(),
  browseMemories: vi.fn(),
  getMemoriesByEntity: vi.fn(),
}));

const dispatchChatOpen = vi.hoisted(() => vi.fn());

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../events", () => ({ dispatchChatOpen }));

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
  vi.restoreAllMocks();
  clientMock.getMemoryStats.mockReset();
  clientMock.getRelationshipsPeople.mockReset();
  clientMock.getMemoryFeed.mockReset();
  clientMock.browseMemories.mockReset();
  clientMock.getMemoriesByEntity.mockReset();
});

describe("MemoryViewerView interface contract", () => {
  it("keeps memory content scrollable above the persistent chat overlay", async () => {
    const { container } = render(<MemoryViewerView />);

    await screen.findByTestId("memory-card-mem-1");

    const scroller = container.querySelector(".eliza-chat-scroll");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain(
      "pb-[var(--eliza-chat-clearance,5.25rem)]",
    );
    expect(scroller?.className).toContain(
      "pe-[var(--eliza-chat-side-clearance,0px)]",
    );
  });

  it("stacks memory cards and exposes expand state", async () => {
    render(<MemoryViewerView />);

    const card = await screen.findByTestId("memory-card-mem-1");
    expect(card.className).toContain("flex-col");
    expect(card.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Entity")).not.toBeNull();
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
