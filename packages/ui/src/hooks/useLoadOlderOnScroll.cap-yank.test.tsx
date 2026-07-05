// @vitest-environment jsdom
//
// Regression for the #13532 scroll-yank: on a long thread (>500 turns) a
// load-older prepend must NOT yank the viewport downward. Drives the REAL
// useChatState reducer through prependConversationMessages together with the
// REAL useLoadOlderOnScroll anchor math against a scroller whose scrollHeight
// tracks the retained message count. Before the fix the reducer trimmed the
// newest tail in the same commit as the top-prepend, so the anchor restore
// (scrollTop += scrollHeight delta) absorbed the removed bottom height and the
// reader was yanked down by the trimmed height. jsdom does not lay out, so the
// scroller geometry is modelled as rows × count and IntersectionObserver is a
// controllable fake.

import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationMessage } from "../api";
import { useChatState } from "../state/useChatState";
import { useLoadOlderOnScroll } from "./useLoadOlderOnScroll";

const ROW_PX = 20;
const VIEWPORT_PX = 400;

class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIntersectionObserver.last = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function msg(id: string, timestamp: number): ConversationMessage {
  return { id, role: "user", text: `m-${id}`, timestamp };
}

/**
 * A scroller whose scrollHeight is `rowCountRef.current * ROW_PX` — read live at
 * getter time so it reflects whatever the reducer has committed. This is what
 * lets the hook's pre-grow capture (old count) and post-grow restore (new count)
 * see the true height delta the DOM would have produced.
 */
function makeCountBackedScroller(rowCountRef: { current: number }) {
  const el = document.createElement("div");
  const state = { top: 0 };
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => rowCountRef.current * ROW_PX,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT_PX,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  return { el, state };
}

interface HarnessHandle {
  setInitial: (messages: ConversationMessage[]) => void;
  prependOlder: (older: ConversationMessage[]) => void;
  latestId: () => string | undefined;
  retainedCount: () => number;
}

function Harness({
  scroller,
  sentinel,
  rowCountRef,
  handleRef,
}: {
  scroller: HTMLDivElement;
  sentinel: HTMLDivElement;
  rowCountRef: { current: number };
  handleRef: { current: HarnessHandle | null };
}) {
  const chat = useChatState();
  const scrollRef = useRef<HTMLDivElement | null>(scroller);
  const sentinelRef = useRef<HTMLElement | null>(sentinel);

  const messages = chat.state.conversationMessages;
  // Keep the modelled scroll geometry in step with committed state BEFORE the
  // hook's own layout effect runs (declaration order = run order), so the
  // anchor restore reads the grown height.
  useLayoutEffect(() => {
    rowCountRef.current = messages.length;
  });

  useLoadOlderOnScroll<HTMLDivElement>({
    scrollRef,
    sentinelRef,
    onLoadOlder: async () => {},
    hasMore: true,
    topItemKey: messages[0]?.id ?? "",
  });

  handleRef.current = {
    setInitial: chat.setConversationMessages,
    prependOlder: chat.prependConversationMessages,
    latestId: () => messages[messages.length - 1]?.id,
    retainedCount: () => messages.length,
  };
  return null;
}

let originalIO: typeof IntersectionObserver | undefined;

beforeEach(() => {
  window.localStorage.clear();
  originalIO = globalThis.IntersectionObserver;
  // @ts-expect-error test double
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  FakeIntersectionObserver.last = null;
});

afterEach(() => {
  cleanup();
  if (originalIO) globalThis.IntersectionObserver = originalIO;
});

describe("useLoadOlderOnScroll × reducer cap (#13532 scroll-yank)", () => {
  it("keeps the anchored message put and retains the newest tail when a long thread pages older past 500", async () => {
    const initialCount = 500;
    const initial = Array.from({ length: initialCount }, (_, i) =>
      msg(`new-${i}`, 1_000_000 + i),
    );
    const rowCountRef = { current: 0 };
    const { el: scroller, state } = makeCountBackedScroller(rowCountRef);
    const sentinel = document.createElement("div");
    const handleRef: { current: HarnessHandle | null } = { current: null };

    render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        rowCountRef={rowCountRef}
        handleRef={handleRef}
      />,
    );

    act(() => {
      handleRef.current?.setInitial(initial);
    });
    expect(rowCountRef.current).toBe(initialCount);

    // Reader is parked near the top, one viewport down — where the prefetch
    // fires and where a downward yank would be most jarring.
    state.top = VIEWPORT_PX;
    const prevTop = state.top;

    const olderPage = Array.from({ length: 25 }, (_, i) => msg(`old-${i}`, i));

    // The sentinel intersecting captures the pre-grow height, then onLoadOlder
    // resolves; we prepend the real older page inside the same act so the
    // reducer commit + anchor restore run before the act flushes.
    await act(async () => {
      FakeIntersectionObserver.last?.fire(true);
      handleRef.current?.prependOlder(olderPage);
    });

    // 25 older rows grew the scroller upward by 25 × ROW; the anchor restore
    // must move scrollTop by exactly that so the previously-visible content
    // stays put. The bug (trim-newest) made the delta zero → prevTop → a
    // 25-row downward yank.
    expect(state.top).toBe(prevTop + 25 * ROW_PX);

    // The newest turn survives the prepend: no trim stranded the true latest.
    expect(handleRef.current?.retainedCount()).toBe(initialCount + 25);
    expect(handleRef.current?.latestId()).toBe(`new-${initialCount - 1}`);
  });
});
