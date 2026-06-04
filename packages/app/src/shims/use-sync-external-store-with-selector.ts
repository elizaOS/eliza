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
  getServerSnapshot: (() => Snapshot) | null | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: EqualityFn<Selection>,
): Selection {
  const instanceRef = useRef<{
    hasValue: boolean;
    value: Selection | null;
  } | null>(null);

  if (instanceRef.current === null) {
    instanceRef.current = { hasValue: false, value: null };
  }

  const instance = instanceRef.current;
  const [getSelectedSnapshot, getSelectedServerSnapshot] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;

        const nextSelection = selector(nextSnapshot);
        if (isEqual && instance.hasValue) {
          const currentSelection = instance.value as Selection;
          if (isEqual(currentSelection, nextSelection)) {
            memoizedSelection = currentSelection;
            return currentSelection;
          }
        }

        memoizedSelection = nextSelection;
        return nextSelection;
      }

      const previousSelection = memoizedSelection;
      if (Object.is(memoizedSnapshot, nextSnapshot)) {
        return previousSelection;
      }

      const nextSelection = selector(nextSnapshot);
      if (isEqual?.(previousSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return previousSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    return [
      () => memoizedSelector(getSnapshot()),
      getServerSnapshot
        ? () => memoizedSelector(getServerSnapshot())
        : undefined,
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, instance]);

  const value = useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedServerSnapshot,
  );

  useEffect(() => {
    instance.hasValue = true;
    instance.value = value;
  }, [instance, value]);

  useDebugValue(value);
  return value;
}

export default { useSyncExternalStoreWithSelector };
