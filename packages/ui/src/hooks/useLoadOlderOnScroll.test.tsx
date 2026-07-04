// @vitest-environment jsdom
//
// Unit coverage for the infinite upward scroll engine (#13532): scroll-anchor
// preservation on prepend (a viewport-anchored message stays put), the prefetch
// trigger firing before the literal top via the sentinel observer, and the
// in-flight guard blocking concurrent double-fetches. jsdom does not lay out, so
// the scroller geometry is stubbed and IntersectionObserver is a controllable
// fake whose callback we invoke by hand.

import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLoadOlderOnScroll } from "./useLoadOlderOnScroll";

// A controllable IntersectionObserver fake. Records constructor options and
// exposes a `fire()` that invokes the callback with a synthetic entry.
class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[] = [];
  disconnected = false;
  constructor(
    cb: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = cb;
    this.options = options;
    FakeIntersectionObserver.last = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
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

/** A scroller with a MUTABLE scrollHeight so a test can simulate an upward grow. */
function makeScroller(initialHeight: number, clientHeight: number) {
  const el = document.createElement("div");
  const state = { height: initialHeight, top: 0 };
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => state.height,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
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

interface HarnessProps {
  scroller: HTMLDivElement;
  sentinel: HTMLDivElement;
  onLoadOlder: () => Promise<void>;
  hasMore: boolean;
  topItemKey: string | number;
  enabled?: boolean;
}

function Harness(props: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement | null>(props.scroller);
  const sentinelRef = useRef<HTMLElement | null>(props.sentinel);
  useLoadOlderOnScroll({
    scrollRef,
    sentinelRef,
    onLoadOlder: props.onLoadOlder,
    hasMore: props.hasMore,
    topItemKey: props.topItemKey,
    enabled: props.enabled,
  });
  return null;
}

let originalIO: typeof IntersectionObserver | undefined;

beforeEach(() => {
  originalIO = globalThis.IntersectionObserver;
  // @ts-expect-error test double
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  FakeIntersectionObserver.last = null;
});

afterEach(() => {
  cleanup();
  if (originalIO) {
    globalThis.IntersectionObserver = originalIO;
  }
  vi.restoreAllMocks();
});

describe("useLoadOlderOnScroll — prefetch trigger (#13532)", () => {
  it("subscribes the sentinel with a positive top rootMargin so it fires before the literal top", () => {
    const { el: scroller } = makeScroller(1000, 400);
    const sentinel = document.createElement("div");
    render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={async () => {}}
        hasMore
        topItemKey="a"
      />,
    );
    const io = FakeIntersectionObserver.last;
    expect(io).not.toBeNull();
    expect(io?.observed).toContain(sentinel);
    // A full viewport (clientHeight=400) of runway above the top.
    expect(io?.options?.rootMargin).toBe("400px 0px 0px 0px");
  });

  it("fires onLoadOlder when the sentinel intersects", async () => {
    const { el: scroller } = makeScroller(1000, 400);
    const sentinel = document.createElement("div");
    const onLoadOlder = vi.fn(async () => {});
    render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={onLoadOlder}
        hasMore
        topItemKey="a"
      />,
    );
    await act(async () => {
      FakeIntersectionObserver.last?.fire(true);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("never fires when hasMore is false (latched off at the true top)", () => {
    const { el: scroller } = makeScroller(1000, 400);
    const sentinel = document.createElement("div");
    const onLoadOlder = vi.fn(async () => {});
    render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={onLoadOlder}
        hasMore={false}
        topItemKey="a"
      />,
    );
    act(() => {
      FakeIntersectionObserver.last?.fire(true);
    });
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});

describe("useLoadOlderOnScroll — in-flight guard", () => {
  it("does not double-fetch while a page is in flight", async () => {
    const { el: scroller } = makeScroller(1000, 400);
    const sentinel = document.createElement("div");
    let resolveLoad: (() => void) | null = null;
    const onLoadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={onLoadOlder}
        hasMore
        topItemKey="a"
      />,
    );
    // First intersection starts a fetch.
    act(() => {
      FakeIntersectionObserver.last?.fire(true);
    });
    // A concurrent intersection mid-fetch must be ignored.
    act(() => {
      FakeIntersectionObserver.last?.fire(true);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    // Once the fetch resolves, a later intersection can fetch again.
    await act(async () => {
      resolveLoad?.();
    });
    act(() => {
      FakeIntersectionObserver.last?.fire(true);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});

describe("useLoadOlderOnScroll — scroll-anchor preservation", () => {
  it("restores scrollTop by the grown height so the anchored message stays put", async () => {
    // Reader is 200px down a 1000px-tall scroller (viewport 400).
    const { el: scroller, state } = makeScroller(1000, 400);
    state.top = 200;
    const sentinel = document.createElement("div");

    // onLoadOlder simulates an upward grow: the older page adds 600px of height.
    const onLoadOlder = vi.fn(async () => {
      state.height = 1600;
    });

    const { rerender } = render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={onLoadOlder}
        hasMore
        topItemKey="first-old-key"
      />,
    );

    // Trigger the load: this captures the pre-grow height (1000) and grows.
    await act(async () => {
      FakeIntersectionObserver.last?.fire(true);
    });

    // The prepend changed the first item; re-render with the new top key so the
    // preservation layout effect runs.
    act(() => {
      rerender(
        <Harness
          scroller={scroller}
          sentinel={sentinel}
          onLoadOlder={onLoadOlder}
          hasMore
          topItemKey="new-first-key"
        />,
      );
    });

    // scrollTop was 200; height grew by 600 (1000 → 1600); so scrollTop must be
    // 200 + 600 = 800 to keep the previously-visible content at the same place.
    expect(state.top).toBe(800);
  });

  it("drops a stale anchor when a load prepends nothing, so a later unrelated top-key change never shoves the viewport", async () => {
    // Reader parked mid-scroller. A load fires but the older page is empty /
    // fully deduped: onLoadOlder resolves WITHOUT growing the DOM and without
    // changing topItemKey. The captured anchor must not survive to corrupt a
    // later unrelated top-key change (e.g. a conversation switch).
    const { el: scroller, state } = makeScroller(1000, 400);
    state.top = 300;
    const sentinel = document.createElement("div");

    // No-op load: no growth, no prepend.
    const onLoadOlder = vi.fn(async () => {});

    const { rerender } = render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={onLoadOlder}
        hasMore
        topItemKey="same"
      />,
    );

    // Fire the load; it resolves with no growth. Flush the finally rAF that
    // clears the un-consumed anchor.
    await act(async () => {
      FakeIntersectionObserver.last?.fire(true);
    });
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });

    // Now grow the scroller and change the top key for an UNRELATED reason
    // (not a prepend). scrollTop must stay put.
    state.height = 1800;
    act(() => {
      rerender(
        <Harness
          scroller={scroller}
          sentinel={sentinel}
          onLoadOlder={onLoadOlder}
          hasMore
          topItemKey="changed"
        />,
      );
    });

    expect(state.top).toBe(300);
  });

  it("does not adjust scrollTop on a top-key change with no pending prepend", () => {
    const { el: scroller, state } = makeScroller(1000, 400);
    state.top = 200;
    const sentinel = document.createElement("div");

    const { rerender } = render(
      <Harness
        scroller={scroller}
        sentinel={sentinel}
        onLoadOlder={async () => {}}
        hasMore
        topItemKey="a"
      />,
    );
    // A top-key change WITHOUT a preceding load (e.g. a message deleted at the
    // top) must not shove the viewport.
    act(() => {
      rerender(
        <Harness
          scroller={scroller}
          sentinel={sentinel}
          onLoadOlder={async () => {}}
          hasMore
          topItemKey="b"
        />,
      );
    });
    expect(state.top).toBe(200);
  });
});
