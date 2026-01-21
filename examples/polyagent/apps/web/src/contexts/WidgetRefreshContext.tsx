/**
 * Widget Refresh Context Provider
 *
 * Provides a centralized refresh mechanism for widgets.
 * Allows widgets to register refresh functions that can be
 * triggered globally (e.g., pull-to-refresh gesture).
 */

"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useRef } from "react";

/**
 * Widget refresh context interface.
 * Manages registration and execution of widget refresh functions.
 */
interface WidgetRefreshContextType {
  /** Register a refresh function for a widget by name */
  registerRefresh: (name: string, refreshFn: () => void) => void;
  /** Unregister a widget's refresh function */
  unregisterRefresh: (name: string) => void;
  /** Execute all registered refresh functions */
  refreshAll: () => void;
}

const WidgetRefreshContext = createContext<WidgetRefreshContextType | null>(
  null,
);

/**
 * Widget refresh context provider component.
 * Manages widget refresh function registry.
 *
 * @param children - React children to wrap with widget refresh context
 */
export function WidgetRefreshProvider({ children }: { children: ReactNode }) {
  const refreshFunctions = useRef<Map<string, () => void>>(new Map());

  const registerRefresh = (name: string, refreshFn: () => void) => {
    refreshFunctions.current.set(name, refreshFn);
  };

  const unregisterRefresh = (name: string) => {
    refreshFunctions.current.delete(name);
  };

  const refreshAll = () => {
    refreshFunctions.current.forEach((refreshFn) => {
      refreshFn();
    });
  };

  return (
    <WidgetRefreshContext.Provider
      value={{ registerRefresh, unregisterRefresh, refreshAll }}
    >
      {children}
    </WidgetRefreshContext.Provider>
  );
}

/**
 * Hook to access widget refresh context.
 *
 * @returns Widget refresh context with registration and refresh functions
 * @throws Error if used outside WidgetRefreshProvider
 *
 * @example
 * ```typescript
 * const { registerRefresh, refreshAll } = useWidgetRefresh();
 * useEffect(() => {
 *   registerRefresh('myWidget', () => refetch());
 * }, []);
 * ```
 */
export function useWidgetRefresh() {
  const context = useContext(WidgetRefreshContext);
  if (!context) {
    throw new Error(
      "useWidgetRefresh must be used within WidgetRefreshProvider",
    );
  }
  return context;
}
