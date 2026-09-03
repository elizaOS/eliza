/**
 * Feed-cursor regression: with two or more memory types selected, server
 * pages arrive unfiltered and narrow on the client. A page holding none of
 * the selected types must still advance past it via "Load older" (#30294).
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const NOW = 1_700_000_000_000;

function factRow(index: number) {
  return {
    id: `fact-${index}`,
    type: "facts",
    text: `fact ${index}`,
    source: "client_chat",
    createdAt: NOW - index * 1_000,
    entityId: "entity-1",
    roomId: "room-1",
  };
}

function messageRow(index: number) {
  return {
    id: `msg-${index}`,
    type: "messages",
    text: `message ${index}`,
    source: "client_chat",
    // Older than the whole facts page: reachable only via page two.
    createdAt: NOW - 50_000 - index * 1_000,
    entityId: "entity-1",
    roomId: "room-1",
  };
}

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
    total: 60,
    byType: { facts: 50, messages: 10 },
  });
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [] });
  const factsPage = Array.from({ length: 50 }, (_, index) => factRow(index));
  const messagesPage = Array.from({ length: 10 }, (_, index) =>
    messageRow(index),
  );
  // Minimal keyset server: unfiltered reads return page one (facts) then,
  // once keyed past its tail, page two (messages); a single-type read
  // filters server-side exactly as the real endpoint does.
  clientMock.getMemoryFeed.mockImplementation(
    (args?: { type?: string; before?: number; limit?: number }) => {
      if (args?.before !== undefined) {
        return Promise.resolve({
          memories: messagesPage,
          count: 60,
          limit: 50,
          hasMore: false,
        });
      }
      if (args?.type) {
        const matching = [...factsPage, ...messagesPage].filter(
          (row) => row.type === args.type,
        );
        return Promise.resolve({
          memories: matching,
          count: 60,
          limit: 50,
          hasMore: false,
        });
      }
      return Promise.resolve({
        memories: factsPage,
        count: 60,
        limit: 50,
        hasMore: true,
      });
    },
  );
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

describe("MemoryViewerView feed cursor across filtered pages", () => {
  it("pages past a server page that holds none of the selected types", async () => {
    const user = userEvent.setup();
    render(<MemoryViewerView />);

    await screen.findByTestId("memory-card-fact-0");

    const trigger = screen.getByTestId("memory-type-filter-trigger");
    await user.click(trigger);
    await user.click(await screen.findByTestId("memory-type-filter-messages"));
    await user.click(await screen.findByTestId("memory-type-filter-documents"));
    // Dismiss the open menu: Radix hides the app tree behind aria-hidden
    // while it is open, which blinds role queries to the feed beneath.
    await user.keyboard("{Escape}");

    // Page one holds only facts: the filtered feed is empty, but ten
    // matching memories wait on page two, so "Load older" must be offered.
    const loadOlder = await screen.findByRole("button", { name: "Load older" });
    await user.click(loadOlder);

    // The cursor must come from the raw page tail: the paging fetch asks
    // for memories older than the last fact, not the (empty) filtered list.
    await waitFor(() => {
      expect(
        clientMock.getMemoryFeed.mock.calls.some(
          (call) => call[0]?.before !== undefined,
        ),
      ).toBe(true);
    });
    const pagedCall = clientMock.getMemoryFeed.mock.calls.find(
      (call) => call[0]?.before !== undefined,
    )?.[0] as { before?: number; beforeId?: string } | undefined;
    expect(pagedCall?.before).toBe(factRow(49).createdAt);
    expect(pagedCall?.beforeId).toBe("fact-49");

    await screen.findByTestId("memory-card-msg-0");
    expect(screen.queryByText("No memories yet")).toBeNull();
  });
});
