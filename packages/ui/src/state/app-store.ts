/**
 * App selector store — a `useSyncExternalStore`-backed mirror of the AppContext
 * value that gives consumers FIELD-LEVEL subscriptions.
 *
 * The problem it solves: `useApp()` returns one monolithic context value
 * (~300 fields). Plain `useContext` re-renders every consumer whenever ANY field
 * changes. `useAppSelector(s => s.tab)` re-renders only when the *selected* slice
 * changes, killing the monolithic-context re-render class without a new
 * dependency (`useSyncExternalStore` is a React built-in / peer dep).
 *
 * Wiring (done once, in AppContext): `seedAppValue(value)` is called during the
 * provider's render so the snapshot is fresh before any child reads it (no
 * null-window on mount, since the provider renders top-down before its
 * children), and `publishAppValue(value)` is called from a commit-time effect so
 * subscribers are notified *after* render (never a setState-during-render).
 *
 * Singleton: the store hangs off `globalThis` (same trick as `useApp.ts`) so a
 * single instance is shared across the host app and externalized plugin view
 * bundles, which resolve `@elizaos/ui`/`react` to the host singletons.
 *
 * Migration seam: consumers can move from `useApp()` to `useAppSelector` one
 * file at a time. The store backing can later be swapped (e.g. to zustand)
 * behind this hook with zero consumer churn.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { AppContextValue } from "./internal";

type Listener = () => void;

interface AppSelectorStore {
  value: AppContextValue | null;
  listeners: Set<Listener>;
}

const appStoreGlobal = globalThis as typeof globalThis & {
  __ELIZAOS_UI_APP_STORE__?: AppSelectorStore;
};

if (!appStoreGlobal.__ELIZAOS_UI_APP_STORE__) {
  appStoreGlobal.__ELIZAOS_UI_APP_STORE__ = {
    value: null,
    listeners: new Set<Listener>(),
  };
}

const store = appStoreGlobal.__ELIZAOS_UI_APP_STORE__;

/**
 * Keep the snapshot fresh during the provider's render (top-down, before any
 * child reads it). Render-safe: it only writes a module field, never notifies.
 */
export function seedAppValue(value: AppContextValue): void {
  store.value = value;
}

/**
 * Notify subscribers of a new value. Call this from a commit-time effect so the
 * notification (which schedules subscriber re-renders) never runs during render.
 */
export function publishAppValue(value: AppContextValue): void {
  if (store.value === value && store.listeners.size === 0) return;
  store.value = value;
  for (const listener of store.listeners) listener();
}

function subscribe(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

// In tests a component may render outside <AppProvider> and without a barrel
// mock, relying on the same inert proxy useApp() returns. Mirror that proxy here
// (cached so its function/value refs are STABLE across getSnapshot calls — fresh
// refs would loop useSyncExternalStore). Production always seeds the store, so
// this only triggers under NODE_ENV=test.
let testFallbackValue: AppContextValue | null = null;
function getTestFallbackValue(): AppContextValue {
  if (!testFallbackValue) {
    const noop = () => {};
    const identityT = (k: string) => k;
    const navigation = {
      scheduleAfterTabCommit: (fn: () => void) => {
        queueMicrotask(fn);
      },
    };
    testFallbackValue = new Proxy({} as AppContextValue, {
      get(_target, prop) {
        if (prop === "t") return identityT;
        if (prop === "uiLanguage") return "en";
        if (prop === "navigation") return navigation;
        return noop;
      },
    });
  }
  return testFallbackValue;
}

function readAppValue(): AppContextValue {
  const value = store.value;
  if (value != null) return value;
  if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
    return getTestFallbackValue();
  }
  throw new Error(
    "useAppSelector used before AppProvider rendered — wrap the consumer in <AppProvider>.",
  );
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe to a slice of the AppContext value. Re-renders only when the
 * selected value changes per `isEqual` (default `Object.is`). For object/array
 * selections, pass `shallowEqual` (or use {@link useAppSelectorShallow}) so a
 * fresh-but-equal object reference does not force a re-render.
 *
 * Prefer a stable (module-level or `useCallback`'d) selector; an inline selector
 * still works correctly (the snapshot is memoized in a ref).
 */
export function useAppSelector<T>(
  selector: (value: AppContextValue) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // Memoize the selected snapshot so getSnapshot returns a referentially-stable
  // value when nothing relevant changed — required to avoid useSyncExternalStore
  // infinite loops and to bail out of re-renders on equal slices.
  const lastRef = useRef<{
    value: AppContextValue;
    selector: (value: AppContextValue) => T;
    isEqual: (a: T, b: T) => boolean;
    selected: T;
  } | null>(null);

  const getSnapshot = useCallback((): T => {
    const value = readAppValue();
    const last = lastRef.current;
    if (
      last &&
      last.value === value &&
      last.selector === selector &&
      last.isEqual === isEqual
    ) {
      // Same value identity → selected slice cannot have changed.
      return last.selected;
    }
    const selected = selector(value);
    if (last && isEqual(last.selected, selected)) {
      // Value changed but the selected slice is equal → keep the prior ref.
      lastRef.current = {
        value,
        selector,
        isEqual,
        selected: last.selected,
      };
      return last.selected;
    }
    lastRef.current = { value, selector, isEqual, selected };
    return selected;
  }, [selector, isEqual]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** {@link useAppSelector} with shallow equality — use for object/array slices. */
export function useAppSelectorShallow<T>(
  selector: (value: AppContextValue) => T,
): T {
  return useAppSelector<T>(selector, shallowEqual as (a: T, b: T) => boolean);
}

/** Test-only: seed the store and notify subscribers (mirrors a publish). */
export function __setAppValueForTests(value: AppContextValue | null): void {
  store.value = value;
  for (const listener of store.listeners) listener();
}

export { shallowEqual as __appShallowEqual };
