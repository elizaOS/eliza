// @vitest-environment jsdom
//
// Behavioral coverage for MemoryViewerView — the "memory viewer" data surface.
// This view is READ-ONLY: it has no delete/mutate affordance (the FOCUS brief
// mentions delete, but MemoryViewerView never calls a delete endpoint — the only
// data seams are getMemoryFeed / browseMemories / getMemoryStats /
// getRelationshipsPeople). These tests drive the real interactions that exist:
//   - Feed rendering + empty / loading / error states.
//   - Load-older pagination (append with `before`) + double-click idempotency.
//   - Browse type-filter round-trip (filter → typed query param → back to all).
//   - Browse free-text search via the view chat-binding (only matching rows,
//     round-trip, clear restores) with exact call payloads.
//   - Prev/Next offset pagination + range label.
//   - Rapid feed<->browse toggling settling on a consistent final render.
//
// Collaborators mocked: the `client` singleton (the data boundary we drive),
// app-state/translation selectors (return a real interpolating `t`), the
// agent-surface + view-chat-binding + resource-cache + poll-interval glue.
// The units under test — MemoryViewerView and its Feed/Browse panels, MemoryCard,
// TypeFilterButton — stay real, as do the layout/PagePanel/SegmentedControl
// primitives, so filtered DOM is asserted against the genuine render.

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryBrowseItem,
  MemoryBrowseQuery,
  MemoryBrowseResponse,
  MemoryFeedQuery,
  MemoryFeedResponse,
  MemoryStatsResponse,
} from "../../api/client-types-chat";

// ── Translation: interpolate {{vars}} into defaultValue so page-range etc. render real text.
function translate(key: string, opts?: Record<string, unknown>): string {
  const template =
    typeof opts?.defaultValue === "string" ? opts.defaultValue : key;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    opts && name in opts ? String(opts[name]) : `{{${name}}}`,
  );
}

const store = vi.hoisted(() => ({
  value: { t: null as unknown, setTab: null as unknown },
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (s: typeof store.value) => T): T =>
    selector(store.value),
}));

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: store.value.t }),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-surface">{children}</div>
  ),
}));

// The floating chat IS the browse search box. Capture the registered binding so
// tests can drive `onQuery` exactly like typing in the composer would.
const chatBindingRef = vi.hoisted(() => ({
  current: null as null | { placeholder: string; onQuery: (q: string) => void },
}));
vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: (binding: typeof chatBindingRef.current) => {
    chatBindingRef.current = binding;
  },
}));

// Resource cache: force cold cache so loading states are deterministic and no
// cross-test bleed. setCached is a no-op sink.
vi.mock("../../hooks/resource-cache", () => ({
  getCached: () => undefined,
  setCached: () => {},
}));

// Kill the 30s background poll so it can't fire extra getMemoryFeed calls.
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => {},
}));

const clientMock = vi.hoisted(() => ({
  getMemoryFeed: vi.fn(),
  browseMemories: vi.fn(),
  getMemoriesByEntity: vi.fn(),
  getMemoryStats: vi.fn(),
  getRelationshipsPeople: vi.fn(),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));

import { MemoryViewerView } from "./MemoryViewerView";

// ── Fixtures ───────────────────────────────────────────────────────────────
function mem(overrides: Partial<MemoryBrowseItem> = {}): MemoryBrowseItem {
  return {
    id: "m-default",
    type: "messages",
    text: "default memory text",
    entityId: null,
    roomId: null,
    agentId: "agent-1",
    createdAt: 1_700_000_000_000,
    metadata: null,
    source: null,
    ...overrides,
  };
}

const FEED_ITEMS: MemoryBrowseItem[] = [
  mem({ id: "f1", type: "messages", text: "hello from the feed", createdAt: 1_700_000_003_000 }),
  mem({ id: "f2", type: "facts", text: "the user likes coffee", createdAt: 1_700_000_002_000 }),
  mem({ id: "f3", type: "memories", text: "a stored recollection", createdAt: 1_700_000_001_000 }),
];

const BROWSE_CORPUS: MemoryBrowseItem[] = [
  mem({ id: "b1", type: "facts", text: "coffee is preferred over tea" }),
  mem({ id: "b2", type: "messages", text: "meeting scheduled tomorrow" }),
  mem({ id: "b3", type: "memories", text: "coffee shop on main street" }),
];

const STATS: MemoryStatsResponse = {
  total: 3,
  byType: { messages: 1, facts: 1, memories: 1 },
};

function feedResponse(
  memories: MemoryBrowseItem[],
  hasMore = false,
): MemoryFeedResponse {
  return { memories, count: memories.length, limit: 50, hasMore };
}
function browseResponse(
  memories: MemoryBrowseItem[],
  total = memories.length,
  offset = 0,
): MemoryBrowseResponse {
  return { memories, total, limit: 50, offset };
}

beforeEach(() => {
  store.value.t = translate;
  store.value.setTab = vi.fn();
  chatBindingRef.current = null;
  clientMock.getMemoryFeed.mockReset();
  clientMock.browseMemories.mockReset();
  clientMock.getMemoriesByEntity.mockReset();
  clientMock.getMemoryStats.mockReset();
  clientMock.getRelationshipsPeople.mockReset();

  clientMock.getMemoryFeed.mockResolvedValue(feedResponse(FEED_ITEMS));
  clientMock.browseMemories.mockImplementation(async (q?: MemoryBrowseQuery) => {
    const term = q?.q?.toLowerCase();
    const typed = q?.type
      ? BROWSE_CORPUS.filter((m) => m.type === q.type)
      : BROWSE_CORPUS;
    const filtered = term
      ? typed.filter((m) => m.text.toLowerCase().includes(term))
      : typed;
    return browseResponse(filtered, filtered.length, q?.offset ?? 0);
  });
  clientMock.getMemoryStats.mockResolvedValue(STATS);
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [] });
});

afterEach(cleanup);

async function switchToBrowse(container: HTMLElement) {
  const browseTab = within(container).getByTestId("memory-view-browse");
  await act(async () => {
    fireEvent.click(browseTab);
  });
}

describe("MemoryViewerView — feed", () => {
  it("renders the fetched feed rows and hides the loading skeleton", async () => {
    const { container } = render(<MemoryViewerView />);

    // Before the promise resolves the feed grid is not painted.
    expect(container.querySelector('[data-testid="memory-feed"]')).toBeNull();

    const feed = await waitFor(() => {
      const el = container.querySelector('[data-testid="memory-feed"]');
      if (!el) throw new Error("feed not rendered yet");
      return el as HTMLElement;
    });

    for (const item of FEED_ITEMS) {
      expect(feed.querySelector(`[data-testid="memory-card-${item.id}"]`)).not.toBeNull();
    }
    expect(feed.textContent).toContain("hello from the feed");
    // Initial load is a base page (no `before`).
    expect(clientMock.getMemoryFeed).toHaveBeenCalledTimes(1);
    expect(clientMock.getMemoryFeed.mock.calls[0][0]).toMatchObject({
      limit: 50,
      before: undefined,
      type: undefined,
    });
  });

  it("shows the empty state when the feed comes back with zero memories", async () => {
    clientMock.getMemoryFeed.mockResolvedValue(feedResponse([]));
    const { container } = render(<MemoryViewerView />);

    await waitFor(() => {
      expect(container.textContent).toContain("No memories yet");
    });
    expect(container.querySelector('[data-testid="memory-feed"]')).toBeNull();
  });

  it("surfaces the error message when the feed fetch rejects", async () => {
    clientMock.getMemoryFeed.mockRejectedValue(new Error("boom: feed offline"));
    const { container } = render(<MemoryViewerView />);

    await waitFor(() => {
      expect(container.textContent).toContain("boom: feed offline");
    });
    expect(container.querySelector('[data-testid="memory-feed"]')).toBeNull();
  });

  it("appends older items via `before` on Load older and ignores a double-click", async () => {
    clientMock.getMemoryFeed.mockImplementation(async (q?: MemoryFeedQuery) => {
      if (q?.before === undefined) return feedResponse(FEED_ITEMS, true);
      // Never resolve the pagination call: keeps loadingMore latched so a
      // second synchronous click must be dropped by the ref guard.
      return new Promise<MemoryFeedResponse>(() => {});
    });

    const { container } = render(<MemoryViewerView />);
    const loadOlder = await waitFor(() => {
      const btn = within(container).getByText("Load older");
      return btn as HTMLElement;
    });

    await act(async () => {
      fireEvent.click(loadOlder);
      fireEvent.click(loadOlder);
    });

    const pagedCalls = clientMock.getMemoryFeed.mock.calls.filter(
      ([q]) => q?.before !== undefined,
    );
    expect(pagedCalls).toHaveLength(1);
    // Paginates from the oldest currently-held item's timestamp.
    expect(pagedCalls[0][0]).toMatchObject({
      before: FEED_ITEMS[FEED_ITEMS.length - 1].createdAt,
    });
  });
});

describe("MemoryViewerView — browse search & filter", () => {
  it("filters to only matching memories on search and restores on clear", async () => {
    const { container } = render(<MemoryViewerView />);
    await switchToBrowse(container);

    const browser = await waitFor(() => {
      const el = container.querySelector('[data-testid="memory-browser"]');
      if (!el) throw new Error("browser not rendered");
      return el as HTMLElement;
    });
    // All three corpus rows before searching.
    await waitFor(() => {
      expect(browser.querySelector('[data-testid="memory-card-b1"]')).not.toBeNull();
      expect(browser.querySelector('[data-testid="memory-card-b2"]')).not.toBeNull();
      expect(browser.querySelector('[data-testid="memory-card-b3"]')).not.toBeNull();
    });

    // The composer drives search via the captured chat binding.
    expect(chatBindingRef.current).not.toBeNull();
    act(() => {
      chatBindingRef.current?.onQuery("coffee");
    });

    // Only the two coffee rows survive; the meeting row is gone.
    await waitFor(() => {
      expect(browser.querySelector('[data-testid="memory-card-b1"]')).not.toBeNull();
      expect(browser.querySelector('[data-testid="memory-card-b3"]')).not.toBeNull();
      expect(browser.querySelector('[data-testid="memory-card-b2"]')).toBeNull();
    });
    // Exact query payload reached the client.
    expect(
      clientMock.browseMemories.mock.calls.some(([q]) => q?.q === "coffee"),
    ).toBe(true);

    // Clearing the search restores the full corpus.
    act(() => {
      chatBindingRef.current?.onQuery("");
    });
    await waitFor(() => {
      expect(browser.querySelector('[data-testid="memory-card-b2"]')).not.toBeNull();
    });
  });

  it("shows the browse empty state when a search matches nothing", async () => {
    const { container } = render(<MemoryViewerView />);
    await switchToBrowse(container);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="memory-browser"]')).not.toBeNull(),
    );

    act(() => {
      chatBindingRef.current?.onQuery("zzz-no-such-memory");
    });

    await waitFor(() => {
      expect(container.textContent).toContain("No memories found");
    });
    expect(container.querySelector('[data-testid="memory-card-b1"]')).toBeNull();
  });

  it("passes the selected type as a typed query param and drops it when toggled off", async () => {
    const { container } = render(<MemoryViewerView />);
    // The "Facts" type-filter button lives in the sidebar once stats load
    // (the same label also appears in the stats rows as a plain span, so pick
    // the occurrence that is inside a <button>).
    const factsBtn = await waitFor(() => {
      const target = within(container)
        .queryAllByText("Facts")
        .map((n) => n.closest("button"))
        .find((b): b is HTMLButtonElement => b != null);
      if (!target) throw new Error("facts filter button not rendered");
      return target;
    });

    await switchToBrowse(container);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="memory-browser"]')).not.toBeNull(),
    );
    clientMock.browseMemories.mockClear();

    await act(async () => {
      fireEvent.click(factsBtn);
    });
    await waitFor(() => {
      expect(
        clientMock.browseMemories.mock.calls.some(([q]) => q?.type === "facts"),
      ).toBe(true);
    });
    // Only the facts row is shown.
    const browser = container.querySelector('[data-testid="memory-browser"]') as HTMLElement;
    await waitFor(() => {
      expect(browser.querySelector('[data-testid="memory-card-b1"]')).not.toBeNull();
      expect(browser.querySelector('[data-testid="memory-card-b2"]')).toBeNull();
    });

    // Toggling the same filter off returns to an untyped query.
    clientMock.browseMemories.mockClear();
    await act(async () => {
      fireEvent.click(factsBtn);
    });
    await waitFor(() => {
      expect(
        clientMock.browseMemories.mock.calls.some(
          ([q]) => q?.type === undefined,
        ),
      ).toBe(true);
    });
  });

  it("pages forward with the right offset and renders the range label", async () => {
    // 60 total > page size 50, so Next is enabled and offset advances.
    clientMock.browseMemories.mockImplementation(async (q?: MemoryBrowseQuery) => {
      const offset = q?.offset ?? 0;
      const page = offset === 0 ? [mem({ id: "p-a", text: "first page row" })] : [mem({ id: "p-b", text: "second page row" })];
      return browseResponse(page, 60, offset);
    });

    const { container } = render(<MemoryViewerView />);
    await switchToBrowse(container);

    const browser = await waitFor(() => {
      const el = container.querySelector('[data-testid="memory-browser"]');
      if (!el?.querySelector('[data-testid="memory-card-p-a"]'))
        throw new Error("first page not ready");
      return el as HTMLElement;
    });
    expect(browser.textContent).toContain("1–1 of 60");

    const nextBtn = within(browser).getByText("Next").closest("button") as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(nextBtn);
    });

    await waitFor(() => {
      expect(
        clientMock.browseMemories.mock.calls.some(([q]) => q?.offset === 50),
      ).toBe(true);
      expect(browser.querySelector('[data-testid="memory-card-p-b"]')).not.toBeNull();
    });
    expect(browser.textContent).toContain("51–51 of 60");
  });
});

describe("MemoryViewerView — rapid toggling idempotency", () => {
  it("settles on the browser after rapid feed<->browse toggling", async () => {
    const { container } = render(<MemoryViewerView />);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="memory-feed"]')).not.toBeNull(),
    );

    const feedTab = within(container).getByTestId("memory-view-feed");
    const browseTab = within(container).getByTestId("memory-view-browse");
    await act(async () => {
      fireEvent.click(browseTab);
      fireEvent.click(feedTab);
      fireEvent.click(browseTab);
      fireEvent.click(feedTab);
      fireEvent.click(browseTab);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="memory-browser"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="memory-feed"]')).toBeNull();
    });
    // Final browse render reflects real data, not a stuck skeleton.
    await waitFor(() => {
      const browser = container.querySelector('[data-testid="memory-browser"]') as HTMLElement;
      expect(browser.querySelector('[data-testid="memory-card-b1"]')).not.toBeNull();
    });
  });
});
