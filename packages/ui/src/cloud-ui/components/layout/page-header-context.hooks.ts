/**
 * Page header context object + hooks. Kept out of page-header-context.tsx so
 * that file exports only the PageHeaderProvider component and stays React Fast
 * Refresh-compatible.
 */

"use client";

import {
  createContext,
  type DependencyList,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";

export interface PageHeaderInfo {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export interface PageHeaderContextValue {
  pageInfo: PageHeaderInfo | null;
  setPageInfo: (info: PageHeaderInfo | null) => void;
}

export const PageHeaderContext = createContext<
  PageHeaderContextValue | undefined
>(undefined);

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
export function useSetPageHeader(
  pageInfo: PageHeaderInfo | null,
  deps: DependencyList = [],
) {
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
