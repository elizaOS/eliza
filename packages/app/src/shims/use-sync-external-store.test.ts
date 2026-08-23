/**
 * Unit tests for the browser `use-sync-external-store/shim` re-export. The
 * suite drives the real module (not a mock of `react`) and records that
 * `useSyncExternalStore` is React's native hook: export identity, client
 * snapshot reads, subscription, Object.is snapshot ties, and unsubscribe on
 * unmount. There is no comparator, queue, capacity, or removal API on the
 * shim itself — those belong to the store the caller supplies.
 */
import {
  act,
  createElement,
  useSyncExternalStore as reactUseSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import * as shim from "./use-sync-external-store.js";
import { useSyncExternalStore } from "./use-sync-external-store.js";

type Subscribe = (onStoreChange: () => void) => () => void;

type Store<T> = {
  getSnapshot: () => T;
  subscribe: Subscribe;
  set: (next: T) => void;
  notify: () => void;
  listenerCount: () => number;
};

function createStore<T>(initial: T): Store<T> {
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
    notify: (): void => {
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: (): number => listeners.size,
  };
}

type Harness<T> = {
  getValue: () => T;
  renderCount: () => number;
  unmount: () => void;
};

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount();
  }
});

function mountHook<T>(hook: () => T): Harness<T> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let latest: T | undefined;
  let renders = 0;

  function Probe(): null {
    latest = hook();
    renders += 1;
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  const unmount = (): void => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  mounted.push(unmount);

  return {
    getValue: (): T => {
      if (latest === undefined) {
        throw new Error("hook has not produced a value");
      }
      return latest;
    },
    renderCount: (): number => renders,
    unmount,
  };
}

describe("use-sync-external-store exports", () => {
  it("exports only useSyncExternalStore as a named function", () => {
    expect(Object.keys(shim)).toEqual(["useSyncExternalStore"]);
    expect(useSyncExternalStore).toBeTypeOf("function");
    expect(shim.useSyncExternalStore).toBe(useSyncExternalStore);
  });

  it("re-exports React's native useSyncExternalStore by identity", () => {
    expect(useSyncExternalStore).toBe(reactUseSyncExternalStore);
  });

  it("has no default export and no extra names", () => {
    expect(Object.hasOwn(shim, "default")).toBe(false);
    expect(Object.hasOwn(shim, "useSyncExternalStoreWithSelector")).toBe(false);
    expect(
      (
        shim as {
          default?: unknown;
          useSyncExternalStoreWithSelector?: unknown;
        }
      ).default,
    ).toBeUndefined();
  });
});

describe("client snapshot: empty, single, and updated values", () => {
  it("returns the initial snapshot for an empty listener set that then has one subscriber", () => {
    const empty: readonly number[] = [];
    const store = createStore(empty);
    expect(store.listenerCount()).toBe(0);

    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );

    expect(store.listenerCount()).toBe(1);
    expect(harness.getValue()).toBe(empty);
    expect(harness.getValue()).toEqual([]);
  });

  it("returns a single primitive snapshot unchanged", () => {
    const store = createStore(42);
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    expect(harness.getValue()).toBe(42);
  });

  it("re-renders with the next snapshot when the store notifies", () => {
    const store = createStore("idle");
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    expect(harness.getValue()).toBe("idle");
    const rendersBefore = harness.renderCount();

    act(() => {
      store.set("live");
    });

    expect(harness.getValue()).toBe("live");
    expect(harness.renderCount()).toBeGreaterThan(rendersBefore);
  });

  it("reads getSnapshot on the client even when getServerSnapshot differs", () => {
    const store = createStore(7);
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot, () => 0),
    );
    expect(harness.getValue()).toBe(7);
  });
});

describe("Object.is snapshot ties", () => {
  it("does not re-render when notify fires and getSnapshot is Object.is-equal", () => {
    const store = createStore(1);
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    const rendersBefore = harness.renderCount();

    act(() => {
      store.notify();
    });

    expect(harness.getValue()).toBe(1);
    expect(harness.renderCount()).toBe(rendersBefore);
  });

  it("does not re-render when set writes the same primitive", () => {
    const store = createStore("same");
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    const rendersBefore = harness.renderCount();

    act(() => {
      store.set("same");
    });

    expect(harness.getValue()).toBe("same");
    expect(harness.renderCount()).toBe(rendersBefore);
  });

  it("re-renders when a new object snapshot is not Object.is-equal", () => {
    const first = { n: 1 };
    const second = { n: 1 };
    const store = createStore(first);
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    expect(harness.getValue()).toBe(first);

    act(() => {
      store.set(second);
    });

    expect(harness.getValue()).toBe(second);
    expect(harness.getValue()).not.toBe(first);
  });
});

describe("subscribe, unsubscribe, and missing listeners", () => {
  it("unsubscribes on unmount so the listener set is empty again", () => {
    const store = createStore(0);
    const harness = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    expect(store.listenerCount()).toBe(1);

    harness.unmount();

    expect(store.listenerCount()).toBe(0);
    act(() => {
      store.set(99);
    });
    expect(store.listenerCount()).toBe(0);
  });

  it("treats a second delete of the same listener as a no-op", () => {
    const listeners = new Set<() => void>();
    const subscribe: Subscribe = (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
        listeners.delete(onStoreChange);
      };
    };
    let snapshot = "one";
    const getSnapshot = (): string => snapshot;

    const harness = mountHook(() =>
      useSyncExternalStore(subscribe, getSnapshot),
    );
    expect(listeners.size).toBe(1);
    expect(harness.getValue()).toBe("one");

    harness.unmount();

    expect(listeners.size).toBe(0);
    snapshot = "ignored";
    expect(listeners.size).toBe(0);
  });

  it("delivers the same snapshot to every subscriber after one notify", () => {
    const store = createStore("a");
    const first = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    const second = mountHook(() =>
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    );
    expect(store.listenerCount()).toBe(2);
    expect(first.getValue()).toBe("a");
    expect(second.getValue()).toBe("a");

    act(() => {
      store.set("b");
    });

    expect(first.getValue()).toBe("b");
    expect(second.getValue()).toBe("b");
  });
});
