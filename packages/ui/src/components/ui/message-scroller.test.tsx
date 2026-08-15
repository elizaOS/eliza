/**
 * Verifies the locally owned message-scroller hooks retain the dependency's
 * real provider behavior while keeping stable elizaOS declaration provenance.
 */

// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "./message-scroller";

type Controls = ReturnType<typeof useMessageScroller>;
type ScrollableState = ReturnType<typeof useMessageScrollerScrollable>;
type VisibilityState = ReturnType<typeof useMessageScrollerVisibility>;

describe("message-scroller public hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates controls and live state transitions through the real provider", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    let controls: Controls | null = null;
    let scrollable: ScrollableState | null = null;
    let visibility: VisibilityState | null = null;

    function HookProbe() {
      controls = useMessageScroller();
      scrollable = useMessageScrollerScrollable();
      visibility = useMessageScrollerVisibility();
      return null;
    }

    render(
      <MessageScrollerProvider>
        <HookProbe />
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="message-1" scrollAnchor>
                Message
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>,
    );

    expect(controls).toEqual({
      scrollToEnd: expect.any(Function),
      scrollToMessage: expect.any(Function),
      scrollToStart: expect.any(Function),
    });
    expect(scrollable).toEqual({ start: false, end: false });
    expect(visibility).toEqual({
      currentAnchorId: null,
      visibleMessageIds: [],
    });

    const viewport = screen.getByRole("region", { name: "Messages" });
    const item = screen.getByText("Message");
    if (!(viewport instanceof HTMLElement) || !(item instanceof HTMLElement)) {
      throw new Error("message scroller test DOM did not mount");
    }

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 240 },
      scrollTop: { configurable: true, value: 20, writable: true },
    });
    viewport.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 });
    item.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 200 });
    function scrollTo(options?: ScrollToOptions): void;
    function scrollTo(x: number, y: number): void;
    function scrollTo(first?: ScrollToOptions | number, y?: number): void {
      viewport.scrollTop =
        typeof first === "number"
          ? (y ?? viewport.scrollTop)
          : (first?.top ?? viewport.scrollTop);
    }
    viewport.scrollTo = scrollTo;

    fireEvent.scroll(viewport);
    await waitFor(() => {
      expect(scrollable).toEqual({ start: true, end: true });
      expect(visibility).toEqual({
        currentAnchorId: "message-1",
        visibleMessageIds: ["message-1"],
      });
    });

    await act(async () => {
      expect(controls?.scrollToStart({ behavior: "instant" })).toBe(true);
      expect(viewport.scrollTop).toBe(0);
      expect(
        controls?.scrollToMessage("message-1", {
          align: "start",
          behavior: "instant",
          scrollMargin: 4,
        }),
      ).toBe(true);
      expect(controls?.scrollToEnd({ behavior: "instant" })).toBe(true);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
  });
});
