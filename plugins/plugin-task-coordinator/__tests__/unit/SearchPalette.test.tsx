// @vitest-environment jsdom
//
// Behavioral tests for the Ctrl+K SearchPalette (src/odysseus/SearchPalette.tsx).
//
// The palette's real logic is: (1) debounce the query and call
// client.listCodingAgentTaskThreads({ search }); (2) render each returned
// thread as a row with the query highlighted via <mark>; (3) drive a keyboard
// selection cursor (ArrowDown/Up clamp at the ends, Enter opens the selected
// thread, Escape closes); (4) mouse hover moves the cursor; (5) distinguish an
// empty result from a failed lookup. We mock the ui `client` so the component's
// own behavior is what's under test, not the backend.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component does `import { client } from "@elizaos/ui"`. Mock the module so
// we control what the search endpoint returns without needing a built dist.
const listThreads = vi.fn();
vi.mock("@elizaos/ui", () => ({
  client: {
    listCodingAgentTaskThreads: (...args: unknown[]) => listThreads(...args),
  },
}));

import { SearchPalette } from "../../src/odysseus/SearchPalette";

type Thread = {
  id: string;
  title: string;
  originalRequest: string;
  summary?: string | null;
  latestActivityAt?: string | number | null;
  updatedAt?: string | number | null;
};

const thread = (over: Partial<Thread> & { id: string }): Thread => ({
  title: "Untitled",
  originalRequest: "",
  summary: "",
  latestActivityAt: null,
  updatedAt: null,
  ...over,
});

// jsdom doesn't implement scrollIntoView; the selection effect calls it.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  listThreads.mockReset();
  // Default: resolve to an empty list so the debounce effect always settles.
  listThreads.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Advance fake timers and flush the resolving/rejecting fetch promise, with the
// resulting React state updates wrapped in act() so the DOM commits before we
// assert on it.
async function flushDebounce(ms = 120) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Render with fake timers and flush the 120ms debounce + the resolved promise.
async function renderOpen(
  props?: Partial<Parameters<typeof SearchPalette>[0]>,
) {
  vi.useFakeTimers();
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <SearchPalette open onClose={onClose} onSelect={onSelect} {...props} />,
  );
  // First (empty-query) fetch fires after the 120ms debounce.
  await flushDebounce();
  return { ...utils, onClose, onSelect };
}

// The dialog container and the input share aria-label="Search conversations",
// so address the input by its unique placeholder instead.
function searchInput(): HTMLInputElement {
  return screen.getByPlaceholderText(
    "Search conversations…",
  ) as HTMLInputElement;
}

// Type into the search box and flush the debounce + the resolving fetch.
async function type(value: string) {
  fireEvent.change(searchInput(), { target: { value } });
  await flushDebounce();
}

describe("SearchPalette", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <SearchPalette open={false} onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("queries the thread search with the trimmed input (undefined when blank)", async () => {
    await renderOpen();
    // Opening fires a blank-query fetch: search must be undefined, not "".
    expect(listThreads).toHaveBeenCalledWith({
      search: undefined,
      includeArchived: true,
      limit: 20,
    });

    listThreads.mockResolvedValue([]);
    await type("  hello  ");
    expect(listThreads).toHaveBeenLastCalledWith({
      search: "hello",
      includeArchived: true,
      limit: 20,
    });
  });

  it("debounces: rapid keystrokes within the window issue one fetch for the last value", async () => {
    await renderOpen();
    listThreads.mockClear();

    const input = searchInput();
    fireEvent.change(input, { target: { value: "a" } });
    await flushDebounce(50);
    fireEvent.change(input, { target: { value: "ab" } });
    await flushDebounce(50);
    fireEvent.change(input, { target: { value: "abc" } });
    // Not yet — only 50ms since the last keystroke.
    expect(listThreads).not.toHaveBeenCalled();
    await flushDebounce(120);
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ search: "abc" }),
    );
  });

  it("renders one row per thread, with the snippet and a relative time", async () => {
    const now = Date.now();
    listThreads.mockResolvedValue([
      thread({
        id: "t1",
        title: "Fix the build",
        originalRequest: "Please fix the broken CI build",
        latestActivityAt: now,
      }),
      thread({ id: "t2", title: "Other", originalRequest: "Other" }),
    ]);
    await renderOpen();

    expect(screen.getByText("Fix the build")).toBeTruthy();
    // originalRequest differs from title → shown as the snippet.
    expect(screen.getByText("Please fix the broken CI build")).toBeTruthy();
    // A same-day timestamp renders as a clock time (HH:MM), so a row time exists.
    const rows = document.querySelectorAll(".od-search-item");
    expect(rows.length).toBe(2);
    expect(
      rows[0].querySelector(".od-search-item-time")?.textContent,
    ).toBeTruthy();
  });

  it("omits the snippet when originalRequest only repeats the title", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "Same", originalRequest: "Same", summary: "" }),
    ]);
    await renderOpen();
    expect(screen.getByText("Same")).toBeTruthy();
    expect(document.querySelector(".od-search-item-snippet")).toBeNull();
  });

  it("wraps the matched substring of the title in a <mark> highlight", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "Refactor the parser", originalRequest: "x" }),
    ]);
    await renderOpen();
    await type("parser");

    const mark = document.querySelector("mark.od-search-highlight");
    expect(mark).not.toBeNull();
    // Highlight preserves the source casing of the matched slice.
    expect(mark?.textContent).toBe("parser");
    // And the surrounding text is intact around the mark.
    expect(screen.getByText(/Refactor the/)).toBeTruthy();
  });

  it("highlights case-insensitively while preserving the original casing", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "PARSER bug", originalRequest: "x" }),
    ]);
    await renderOpen();
    await type("parser");
    const mark = document.querySelector("mark.od-search-highlight");
    expect(mark?.textContent).toBe("PARSER");
  });

  it("clicking a row calls onSelect with its id then closes", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "abc", title: "Pick me", originalRequest: "y" }),
    ]);
    const { onSelect, onClose } = await renderOpen();
    fireEvent.click(screen.getByText("Pick me"));
    expect(onSelect).toHaveBeenCalledWith("abc");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown/ArrowUp move a clamped selection cursor over the rows", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "One", originalRequest: "a" }),
      thread({ id: "t2", title: "Two", originalRequest: "b" }),
    ]);
    await renderOpen();
    const input = searchInput();
    const rows = () => document.querySelectorAll(".od-search-item");
    const selectedIdx = () =>
      [...rows()].findIndex((r) => r.classList.contains("od-selected"));

    // Nothing selected initially.
    expect(selectedIdx()).toBe(-1);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedIdx()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedIdx()).toBe(1);
    // Clamp at the bottom — does not wrap past the last row.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedIdx()).toBe(1);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedIdx()).toBe(0);
    // Clamp at the top.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selectedIdx()).toBe(0);
  });

  it("Enter opens the currently selected thread", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "One", originalRequest: "a" }),
      thread({ id: "t2", title: "Two", originalRequest: "b" }),
    ]);
    const { onSelect, onClose } = await renderOpen();
    const input = searchInput();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // select index 1 → t2
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("t2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter with no row selected is a no-op (does not open or close)", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "One", originalRequest: "a" }),
    ]);
    const { onSelect, onClose } = await renderOpen();
    fireEvent.keyDown(searchInput(), {
      key: "Enter",
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hovering a row moves the selection cursor to it", async () => {
    listThreads.mockResolvedValue([
      thread({ id: "t1", title: "One", originalRequest: "a" }),
      thread({ id: "t2", title: "Two", originalRequest: "b" }),
    ]);
    await renderOpen();
    const rows = document.querySelectorAll(".od-search-item");
    fireEvent.mouseEnter(rows[1]);
    expect(rows[1].classList.contains("od-selected")).toBe(true);
    expect(rows[0].classList.contains("od-selected")).toBe(false);
  });

  it("Escape closes the palette", async () => {
    const { onClose } = await renderOpen();
    fireEvent.keyDown(searchInput(), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the palette", async () => {
    const { onClose } = await renderOpen();
    fireEvent.click(screen.getByLabelText("Close search"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the blank-query empty copy when there are no results and no query", async () => {
    listThreads.mockResolvedValue([]);
    await renderOpen();
    expect(screen.getByText("No conversations found.")).toBeTruthy();
  });

  it("shows the no-match copy once a query is typed but nothing matches", async () => {
    listThreads.mockResolvedValue([]);
    await renderOpen();
    await type("zzz-nothing");
    expect(screen.getByText("No results found")).toBeTruthy();
  });

  it("surfaces a distinct error state (role=alert) when the lookup rejects", async () => {
    listThreads.mockRejectedValue(new Error("network down"));
    // renderOpen advances the 120ms debounce and flushes the rejected promise's
    // microtasks, so the .catch() state update has already applied.
    await renderOpen();
    expect(
      screen.getByText(/Search failed\. Check your connection/),
    ).toBeTruthy();
    const empty = document.querySelector(".od-search-empty");
    expect(empty?.getAttribute("role")).toBe("alert");
    expect(empty?.classList.contains("od-search-error")).toBe(true);
  });
});
