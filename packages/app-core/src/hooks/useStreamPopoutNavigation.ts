import { useEffect } from "react";

export function getNextTabForStreamPopoutEvent<TTab extends string>(
  _detail: unknown,
): TTab | null {
  return null;
}

export function useStreamPopoutNavigation<TTab extends string>(
  setTab: (tab: TTab) => void,
): void {
  useEffect(() => {
    const target =
      typeof window !== "undefined" ? window : (globalThis as EventTarget);
    const handler = (event: Event) => {
      const nextTab = getNextTabForStreamPopoutEvent<TTab>(
        (event as CustomEvent).detail,
      );
      if (nextTab) {
        setTab(nextTab);
      }
    };

    target.addEventListener("stream-popout", handler);
    return () => target.removeEventListener("stream-popout", handler);
  }, [setTab]);
}
