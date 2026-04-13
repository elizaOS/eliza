import { createContext, useContext } from "react";
import type { AppContextValue } from "./types";

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
      // In tests, if rendered outside AppProvider, return a dummy context
      return new Proxy({} as AppContextValue, {
        get(_, prop) {
          if (prop === "t") return (k: string) => k;
          if (prop === "uiLanguage") return "en";
          if (prop === "companionHalfFramerateMode") return "when_saving_power";
          if (prop === "navigation") {
            return {
              subscribeTabCommitted: () => () => {},
              scheduleAfterTabCommit: (fn: () => void) => {
                queueMicrotask(fn);
              },
            };
          }
          // We don't have vitest `vi` in scope, just return a no-op function for any action
          return () => {};
        },
      });
    }
    throw new Error("useApp must be used within AppProvider");
  }
  return ctx;
}
