import { useMemo, useRef, useSyncExternalStore } from "react";

type EqualityFn<T> = (left: T, right: T) => boolean;

const objectIs: EqualityFn<unknown> = Object.is;

export function useSyncExternalStoreWithSelector<TSnapshot, TSelection>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => TSnapshot,
  getServerSnapshot: (() => TSnapshot) | undefined,
  selector: (snapshot: TSnapshot) => TSelection,
  isEqual: EqualityFn<TSelection> = objectIs as EqualityFn<TSelection>,
): TSelection {
  const selectionRef = useRef<TSelection | undefined>(undefined);

  const selectedSnapshot = useSyncExternalStore(
    subscribe,
    () => selector(getSnapshot()),
    getServerSnapshot ? () => selector(getServerSnapshot()) : undefined,
  );

  return useMemo(() => {
    const previous = selectionRef.current;
    if (previous !== undefined && isEqual(previous, selectedSnapshot)) {
      return previous;
    }
    selectionRef.current = selectedSnapshot;
    return selectedSnapshot;
  }, [isEqual, selectedSnapshot]);
}

export default { useSyncExternalStoreWithSelector };
