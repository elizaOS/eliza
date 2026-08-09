/** Verifies MessageSearchPanel through the package's configured test harness. */
// @vitest-environment jsdom
//
// Render test for MessageSearchPanel: min-query gating, debounced search with
// ranked snippet results, jump-to-result (closes the panel), empty/error
// states, and Escape-to-close. jsdom + Testing Library with the search API
// mocked — no network.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessageSearchResult } from "../../../api/client-types-chat";
import { MessageSearchPanel } from "./MessageSearchPanel";

afterEach(cleanup);

function result(
  over: Partial<ConversationMessageSearchResult> = {},
): ConversationMessageSearchResult {
  return {
    messageId: "m1",
    conversationId: "c1",
    roomId: "r1",
    role: "user",
    text: "we shipped the webxr runtime",
    snippet: "…shipped the webxr runtime…",
    createdAt: 1,
    score: 5,
    ...over,
  };
}

describe("MessageSearchPanel", () => {
  it("keeps its text field above Mobile Safari's focus-zoom threshold", () => {
    render(
      <MessageSearchPanel
        search={vi.fn()}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("message-search-input").className).toContain(
      "pointer-coarse:text-base",
    );
  });

  it("does not search until the query reaches the minimum length", async () => {
    const search = vi.fn(async () => [result()]);
    render(
      <MessageSearchPanel search={search} onJump={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "a" },
    });
    expect(screen.getByText(/at least 2 characters/i)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(search).not.toHaveBeenCalled();
  });

  it("debounced-searches and renders ranked result snippets", async () => {
    const search = vi.fn(async () => [
      result({ messageId: "m1", snippet: "…webxr one…" }),
      result({ messageId: "m2", snippet: "…webxr two…", role: "assistant" }),
    ]);
    render(
      <MessageSearchPanel search={search} onJump={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "webxr" },
    });
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith("webxr", expect.any(AbortSignal)),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("message-search-result")).toHaveLength(2),
    );
    expect(screen.getByText("…webxr one…")).toBeTruthy();
    expect(screen.getByText(/Agent ·/)).toBeTruthy();
  });

  it("owns scrolling for long keyboard-anchored result lists", async () => {
    const search = vi.fn(async () =>
      Array.from({ length: 18 }, (_, index) =>
        result({
          messageId: `m${index}`,
          snippet: `result ${index}`,
        }),
      ),
    );
    render(
      <MessageSearchPanel
        search={search}
        onJump={vi.fn()}
        onClose={vi.fn()}
        layout="keyboard-anchored"
      />,
    );

    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "history" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("message-search-result")).toHaveLength(18),
    );

    const scroller = screen.getByTestId("message-search-scroll");
    const list = screen.getByTestId("message-search-results");
    const input = screen.getByTestId("message-search-input");
    expect(scroller.hasAttribute("data-chat-sheet-scroll-region")).toBe(true);
    expect(scroller.className).toContain("touch-pan-y");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).not.toContain("justify-end");
    expect(input.className).not.toContain("backdrop-blur");
    for (const searchResult of screen.getAllByTestId("message-search-result")) {
      expect(searchResult.className).not.toContain("backdrop-blur");
    }
    // Auto margin bottom-aligns a short list, but collapses to zero once the
    // list overflows so its first result remains reachable by native scrolling.
    expect(list.className).toContain("mt-auto");
  });

  it("jumps to a result and closes", async () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const search = vi.fn(async () => [result({ messageId: "m1" })]);
    render(
      <MessageSearchPanel search={search} onJump={onJump} onClose={onClose} />,
    );
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "webxr" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("message-search-result")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("message-search-result"));
    expect(onJump).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an empty state and surfaces failures", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const { rerender } = render(
      <MessageSearchPanel
        search={failing}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "webxr" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("message-search-error")).toBeTruthy(),
    );

    const empty = vi.fn(async () => []);
    rerender(
      <MessageSearchPanel search={empty} onJump={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "nomatch" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("message-search-empty")).toBeTruthy(),
    );
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <MessageSearchPanel
        search={vi.fn()}
        onJump={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("message-search-panel"), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
