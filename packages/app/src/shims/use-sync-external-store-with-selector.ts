/**
 * Browser shim reimplementing `use-sync-external-store/shim/with-selector`.
 * Wraps React's native `useSyncExternalStore` with a memoized selector so a
 * store subscription only re-renders when the selected slice actually changes,
 * comparing successive selections with the optional `isEqual` equality fn and
 * caching the last committed value across snapshots. Lets the app depend on the
 * selector-aware store hook without bundling the upstream package.
 */
import {
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

type Subscribe = (onStoreChange: () => void) => () => void;
type EqualityFn<T> = (left: T, right: T) => boolean;

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: Subscribe,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: EqualityFn<Selection>,
): Selection {
  const instanceRef = useRef<{ hasValue: boolean; value: Selection | null }>(
    null,
  );
  if (instanceRef.current === null) {
    instanceRef.current = { hasValue: false, value: null };
  }
  const instance = instanceRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    function memoizedSelector(nextSnapshot: Snapshot): Selection {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);

        if (
          isEqual !== undefined &&
          instance.hasValue &&
          isEqual(instance.value as Selection, nextSelection)
        ) {
          memoizedSelection = instance.value as Selection;
          return memoizedSelection;
        }

        memoizedSelection = nextSelection;
        return memoizedSelection;
      }

      const currentSelection = memoizedSelection;
      if (Object.is(memoizedSnapshot, nextSnapshot)) {
        return currentSelection;
      }

      const nextSelection = selector(nextSnapshot);
      if (isEqual?.(currentSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return currentSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    }

    const maybeGetServerSnapshot =
      getServerSnapshot === undefined ? null : getServerSnapshot;

    return [
      () => memoizedSelector(getSnapshot()),
      maybeGetServerSnapshot === null
        ? undefined
        : () => memoizedSelector(maybeGetServerSnapshot()),
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, instance]);

  const value = useSyncExternalStore(
    subscribe,
    getSelection,
    getServerSelection,
  );

  useEffect(() => {
    instance.hasValue = true;
    instance.value = value;
  }, [instance, value]);

  useDebugValue(value);
  return value;
}

export default {
  useSyncExternalStoreWithSelector,
};
