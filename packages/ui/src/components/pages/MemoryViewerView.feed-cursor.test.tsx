/**
 * Keyset-cursor coverage for the Memories feed under a multi-type filter. With
 * two or more types selected the server filter is dropped and the page is
 * filtered on the client, so the "Load older" cursor must come from the raw
 * server page tail — deriving it from the filtered list stalls paging on any
 * page that holds none of the selected types. Real MemoryViewerView in jsdom
 * against an in-memory keyset server; only the API client and store are mocked.
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
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
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

const SELECTED_A = "messages";
const SELECTED_B = "documents";
const OTHER = "facts";

type Item = {
  id: string;
  type: string;
  text: string;
  createdAt: number;
  entityId: null;
  roomId: null;
  agentId: null;
  metadata: null;
  source: null;
};

function item(index: number, type: string): Item {
  return {
    id: `mem-${index}`,
    type,
    text: `memory ${index}`,
    createdAt: 10_000 - index,
    entityId: null,
    roomId: null,
    agentId: null,
    metadata: null,
    source: null,
  };
}

// Newest first. The first server page (50 items) holds none of the selected
// types; the selected items only exist on the second page.
const DATASET: Item[] = [
  ...Array.from({ length: 50 }, (_, i) => item(i, OTHER)),
  ...Array.from({ length: 10 }, (_, i) => item(50 + i, SELECTED_A)),
];

function keysetServer(params: { limit?: number; before?: number }) {
  const before = params.before;
  const older =
    before === undefined
      ? DATASET
      : DATASET.filter((m) => m.createdAt < before);
  const limit = params.limit ?? 50;
  const page = older.slice(0, limit);
  return Promise.resolve({
    memories: page,
    count: page.length,
    limit,
    hasMore: older.length > limit,
  });
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
  clientMock.getMemoryStats.mockResolvedValue({
    total: 61,
    byType: { [SELECTED_A]: 10, [SELECTED_B]: 1, [OTHER]: 50 },
  });
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [] });
  clientMock.getMemoryFeed.mockImplementation(keysetServer);
  clientMock.browseMemories.mockResolvedValue({
    memories: [],
    total: 0,
    totalIsExact: true,
    hasMore: false,
    limit: 50,
    offset: 0,
  });
  clientMock.getMemoriesByEntity.mockResolvedValue({
    memories: [],
    total: 0,
    totalIsExact: true,
    hasMore: false,
    limit: 50,
    offset: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const mock of Object.values(clientMock)) mock.mockReset();
});

describe("Memories feed keyset cursor under a multi-type filter", () => {
  it("pages past a server page that holds none of the selected types", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<MemoryViewerView />);

    const trigger = await screen.findByTestId("memory-type-filter-trigger");
    await user.click(trigger);
    await user.click(
      await screen.findByTestId(`memory-type-filter-${SELECTED_A}`),
    );
    // Checkbox items prevent the default select, so the menu stays open.
    await user.click(
      await screen.findByTestId(`memory-type-filter-${SELECTED_B}`),
    );

    // Two types selected: the server-side type param is dropped and the first
    // page (all OTHER) filters to nothing on the client while hasMore stays true.
    await waitFor(() => {
      expect(
        clientMock.getMemoryFeed.mock.calls.some(
          ([params]) => params.type === undefined,
        ),
      ).toBe(true);
    });
    // Close the filter menu: while it is open Radix marks the rest of the page
    // aria-hidden, which hides the feed's controls from role queries.
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Load older" }));

    // The next request must advance from the raw server tail (mem-49,
    // createdAt 9951), not from the empty filtered list.
    await waitFor(() => {
      expect(
        clientMock.getMemoryFeed.mock.calls.some(
          ([params]) => params.before === 10_000 - 49,
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId("memory-card-mem-50")).toBeTruthy();
  });
});
