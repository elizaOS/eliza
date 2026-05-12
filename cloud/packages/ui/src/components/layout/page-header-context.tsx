/**
 * Page header context provider and hooks for managing page header information.
 * Provides centralized header state management across the application.
 */

"use client";

import {
  createContext,
  type DependencyList,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface PageHeaderInfo {
  title: string;
  description?: string;
  actions?: ReactNode;
}

interface PageHeaderContextValue {
  pageInfo: PageHeaderInfo | null;
  setPageInfo: (info: PageHeaderInfo | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | undefined>(undefined);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [pageInfo, setPageInfoRaw] = useState<PageHeaderInfo | null>(null);

  // Wrap setter to skip no-op updates (prevents context churn when same title/description
  // is set repeatedly, which would otherwise re-render all consumers).
  const setPageInfo = useMemo(
    () => (info: PageHeaderInfo | null) => {
      setPageInfoRaw((prev) => {
        if (prev === info) return prev;
        if (prev === null || info === null) return info;
        if (
          prev.title === info.title &&
          prev.description === info.description &&
          prev.actions === info.actions
        ) {
          return prev; // same content → keep old reference → no re-render
        }
        return info;
      });
    },
    [],
  );

  const contextValue = useMemo(() => ({ pageInfo, setPageInfo }), [pageInfo, setPageInfo]);

  return <PageHeaderContext.Provider value={contextValue}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeader() {
  const context = useContext(PageHeaderContext);
  if (context === undefined) {
    throw new Error("usePageHeader must be used within a PageHeaderProvider");
  }
  return context;
}

/**
 * Custom hook to set page header info and automatically clean it up on unmount.
 * This eliminates the need to manually call setPageInfo(null) in a cleanup function.
 *
 * Stabilizes the pageInfo reference by comparing primitive fields (title, description)
 * so that callers can safely pass inline object literals without causing infinite
 * re-render loops from new references on every render.
 *
 * @param pageInfo - The page header information to set
 * @param deps - Dependencies array for the effect (similar to useEffect)
 */
export function useSetPageHeader(pageInfo: PageHeaderInfo | null, deps: DependencyList = []) {
  const { setPageInfo } = usePageHeader();

  // Extract primitives so effect deps are stable across re-renders.
  const title = pageInfo?.title ?? null;
  const description = pageInfo?.description ?? null;
  // actions is a ReactNode — tracked via the caller's `deps` if it changes.
  const actionsRef = useRef(pageInfo?.actions);
  actionsRef.current = pageInfo?.actions;

  useEffect(() => {
    if (title !== null) {
      setPageInfo({
        title,
        description: description ?? undefined,
        actions: actionsRef.current,
      });
    } else {
      setPageInfo(null);
    }
    return () => setPageInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPageInfo, title, description, ...deps]);
}
