/**
 * Unit tests for the browser `use-sync-external-store-with-selector` shim.
 * The suite drives the real hook through `renderHook` (not a mock of React or
 * the store) and records named vs default export identity, slice selection,
 * same-snapshot memoization, optional `isEqual` ties, first-commit vs
 * post-commit reuse of the cached selection, omitted vs provided
 * `getServerSnapshot`, subscribe/unsubscribe, and NaN / +0 / -0 comparator
 * edges as implemented. There is no queue, capacity, or item-removal API.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import withSelectorDefault, {
  useSyncExternalStoreWithSelector,
} from "./use-sync-external-store-with-selector.js";

type Snapshot = { extra: string; n: number };

function createStore<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): T => snapshot,
    subscribe: (onStoreChange: () => void): (() => void) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    set: (next: T): void => {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: (): number => listeners.size,
  };
}

afterEach(() => {
  cleanup();
});

describe("useSyncExternalStoreWithSelector exports", () => {
  it("exposes the same function on the default object and as a named export", () => {
    expect(useSyncExternalStoreWithSelector).toBeTypeOf("function");
    expect(withSelectorDefault.useSyncExternalStoreWithSelector).toBe(
      useSyncExternalStoreWithSelector,
    );
    expect(Object.keys(withSelectorDefault)).toEqual([
      "useSyncExternalStoreWithSelector",
    ]);
  });
});

describe("slice selection", () => {
  it("returns the selected primitive from a single-field snapshot", () => {
    const store = createStore({ n: 3 });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      ),
    );
    expect(result.current).toBe(3);
  });

  it("returns the selected object from an otherwise empty extra field", () => {
    const store = createStore({ extra: "", n: 1 });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot,
      ),
    );
    expect(result.current).toEqual({ extra: "", n: 1 });
  });

  it("returns undefined when the selector yields undefined", () => {
    const store = createStore({ extra: "x", n: 0 });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (_snapshot: Snapshot) => undefined,
      ),
    );
    expect(result.current).toBeUndefined();
  });
});

describe("subscribe and unsubscribe", () => {
  it("subscribes on mount and unsubscribes on unmount", () => {
    const store = createStore({ n: 1 });
    const { unmount } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      ),
    );
    expect(store.listenerCount()).toBe(1);
    unmount();
    expect(store.listenerCount()).toBe(0);
  });
});

describe("same-snapshot memoization", () => {
  it("does not re-invoke the selector when the snapshot identity is unchanged", () => {
    const initial: Snapshot = { extra: "a", n: 1 };
    const store = createStore(initial);
    let selectorCalls = 0;
    renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => {
          selectorCalls += 1;
          return snapshot.n;
        },
      ),
    );
    const callsAfterMount = selectorCalls;
    expect(callsAfterMount).toBeGreaterThan(0);

    act(() => {
      store.set(initial);
    });
    expect(selectorCalls).toBe(callsAfterMount);
  });

  it("does not consult isEqual when the snapshot identity is unchanged", () => {
    const initial: Snapshot = { extra: "a", n: 1 };
    const store = createStore(initial);
    let equalCalls = 0;
    renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
        (left, right) => {
          equalCalls += 1;
          return left === right;
        },
      ),
    );
    const equalsAfterMount = equalCalls;

    act(() => {
      store.set(initial);
    });
    expect(equalCalls).toBe(equalsAfterMount);
  });
});

describe("snapshot changes without isEqual", () => {
  it("does not re-render when the selected primitive is Object.is-equal", () => {
    const store = createStore({ extra: "a", n: 4 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      );
    });
    const rendersAfterMount = renders;
    expect(result.current).toBe(4);

    act(() => {
      store.set({ extra: "b", n: 4 });
    });
    expect(result.current).toBe(4);
    expect(renders).toBe(rendersAfterMount);
  });

  it("re-renders when the selected primitive changes", () => {
    const store = createStore({ extra: "a", n: 1 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      );
    });
    const rendersAfterMount = renders;

    act(() => {
      store.set({ extra: "a", n: 2 });
    });
    expect(result.current).toBe(2);
    expect(renders).toBeGreaterThan(rendersAfterMount);
  });

  it("re-renders on a new object selection even when the contents match", () => {
    const store = createStore({ extra: "a", n: 1 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => ({ n: snapshot.n }),
      );
    });
    const first = result.current;
    const rendersAfterMount = renders;

    act(() => {
      store.set({ extra: "b", n: 1 });
    });
    expect(result.current).toEqual({ n: 1 });
    expect(result.current).not.toBe(first);
    expect(renders).toBeGreaterThan(rendersAfterMount);
  });
});

describe("optional isEqual comparator", () => {
  it("does not call isEqual with the uninitialized cache on first commit", () => {
    const store = createStore({ extra: "a", n: 1 });
    const seen: Array<[unknown, unknown]> = [];
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
        (left, right) => {
          seen.push([left, right]);
          return left === right;
        },
      ),
    );
    expect(result.current).toBe(1);
    for (const [left, right] of seen) {
      expect(typeof left).toBe("number");
      expect(typeof right).toBe("number");
    }
  });

  it("keeps the previous selection identity when isEqual reports a tie", () => {
    const store = createStore({ extra: "a", n: 1 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => ({ n: snapshot.n }),
        (left, right) => left.n === right.n,
      );
    });
    const first = result.current;
    const rendersAfterMount = renders;

    act(() => {
      store.set({ extra: "b", n: 1 });
    });
    expect(result.current).toBe(first);
    expect(renders).toBe(rendersAfterMount);
  });

  it("replaces the selection when isEqual reports a difference", () => {
    const store = createStore({ extra: "a", n: 1 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => ({ n: snapshot.n }),
        (left, right) => left.n === right.n,
      );
    });
    const first = result.current;
    const rendersAfterMount = renders;

    act(() => {
      store.set({ extra: "a", n: 9 });
    });
    expect(result.current).toEqual({ n: 9 });
    expect(result.current).not.toBe(first);
    expect(renders).toBeGreaterThan(rendersAfterMount);
  });

  it("reuses the committed selection when a new selector isEqual to it", () => {
    const store = createStore({ extra: "a", n: 1 });
    const { result, rerender } = renderHook(
      ({ selector }: { selector: (snapshot: Snapshot) => { n: number } }) =>
        useSyncExternalStoreWithSelector(
          store.subscribe,
          store.getSnapshot,
          undefined,
          selector,
          (left, right) => left.n === right.n,
        ),
      {
        initialProps: {
          selector: (snapshot: Snapshot) => ({ n: snapshot.n }),
        },
      },
    );
    const committed = result.current;
    expect(committed).toEqual({ n: 1 });

    rerender({
      selector: (snapshot: Snapshot) => ({ n: snapshot.n }),
    });
    expect(result.current).toBe(committed);
  });

  it("does not reuse the committed identity when isEqual is omitted after a selector change", () => {
    const store = createStore({ extra: "a", n: 1 });
    const { result, rerender } = renderHook(
      ({ selector }: { selector: (snapshot: Snapshot) => { n: number } }) =>
        useSyncExternalStoreWithSelector(
          store.subscribe,
          store.getSnapshot,
          undefined,
          selector,
        ),
      {
        initialProps: {
          selector: (snapshot: Snapshot) => ({ n: snapshot.n }),
        },
      },
    );
    const committed = result.current;

    rerender({
      selector: (snapshot: Snapshot) => ({ n: snapshot.n }),
    });
    expect(result.current).toEqual({ n: 1 });
    expect(result.current).not.toBe(committed);
  });
});

describe("getServerSnapshot", () => {
  it("returns the client snapshot when getServerSnapshot is omitted", () => {
    const store = createStore({ n: 5 });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      ),
    );
    expect(result.current).toBe(5);
  });

  it("returns the client snapshot when getServerSnapshot is provided on the client", () => {
    const store = createStore({ n: 7 });
    const { result } = renderHook(() =>
      useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        () => ({ n: -1 }),
        (snapshot) => snapshot.n,
      ),
    );
    expect(result.current).toBe(7);
  });
});

describe("NaN and signed-zero edges", () => {
  it("does not re-render when successive selections are NaN", () => {
    const store = createStore({ extra: "a", n: Number.NaN });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      );
    });
    const rendersAfterMount = renders;
    expect(Number.isNaN(result.current)).toBe(true);

    act(() => {
      store.set({ extra: "b", n: Number.NaN });
    });
    expect(Number.isNaN(result.current)).toBe(true);
    expect(renders).toBe(rendersAfterMount);
  });

  it("re-renders when the selected number changes from +0 to -0 without isEqual", () => {
    const store = createStore({ extra: "a", n: 0 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
      );
    });
    const rendersAfterMount = renders;
    expect(Object.is(result.current, 0)).toBe(true);

    act(() => {
      store.set({ extra: "a", n: -0 });
    });
    expect(Object.is(result.current, -0)).toBe(true);
    expect(renders).toBeGreaterThan(rendersAfterMount);
  });

  it("treats +0 and -0 as a tie when isEqual uses ===", () => {
    const store = createStore({ extra: "a", n: 0 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSyncExternalStoreWithSelector(
        store.subscribe,
        store.getSnapshot,
        undefined,
        (snapshot) => snapshot.n,
        (left, right) => left === right,
      );
    });
    const rendersAfterMount = renders;

    act(() => {
      store.set({ extra: "a", n: -0 });
    });
    expect(Object.is(result.current, 0)).toBe(true);
    expect(renders).toBe(rendersAfterMount);
  });
});
