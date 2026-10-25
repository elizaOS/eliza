/**
 * The AppContext object and useApp() accessor. The context is pinned on
 * globalThis so a single instance survives HMR and duplicate module copies.
 */
import { createContext, useContext } from "react";
import type { AppContextValue } from "./types";

type AppContextObject = ReturnType<
  typeof createContext<AppContextValue | null>
>;

const appContextGlobal = globalThis as typeof globalThis & {
  __ELIZAOS_UI_APP_CONTEXT__?: AppContextObject;
};

if (!appContextGlobal.__ELIZAOS_UI_APP_CONTEXT__) {
  appContextGlobal.__ELIZAOS_UI_APP_CONTEXT__ =
    createContext<AppContextValue | null>(null);
}

export const AppContext = appContextGlobal.__ELIZAOS_UI_APP_CONTEXT__;

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
      // In tests, if rendered outside AppProvider, return a dummy context
      return new Proxy({} as AppContextValue, {
        get(_, prop) {
          if (prop === "t") return (k: string) => k;
          if (prop === "uiLanguage") return "en";
          if (prop === "navigation") {
            return {
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
