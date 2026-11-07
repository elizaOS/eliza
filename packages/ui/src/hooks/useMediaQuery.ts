/**
 * Reactive matchMedia hook subscribing to a media query via useSyncExternalStore
 * (SSR-safe: false when window/matchMedia is absent).
 */
import { useCallback, useSyncExternalStore } from "react";

function getMediaQueryMatch(query: string): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }

  return window.matchMedia(query).matches;
}

export function useMediaQuery(
  query: string,
  options?: { defaultValue?: boolean },
): boolean {
  const defaultValue = options?.defaultValue ?? false;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return () => {};
      }

      const mediaQuery = window.matchMedia(query);
      const handleChange = () => {
        onStoreChange();
      };

      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => getMediaQueryMatch(query), [query]);
  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
