/**
 * Page header context provider and hooks for managing page header information.
 * Provides centralized header state management across the application.
 */

"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  type ReactNode,
  type DependencyList,
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

const PageHeaderContext = createContext<PageHeaderContextValue | undefined>(
  undefined,
);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [pageInfo, setPageInfo] = useState<PageHeaderInfo | null>(null);

  const contextValue = useMemo(() => ({ pageInfo, setPageInfo }), [pageInfo]);

  return (
    <PageHeaderContext.Provider value={contextValue}>
      {children}
    </PageHeaderContext.Provider>
  );
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
 * @param pageInfo - The page header information to set
 * @param deps - Dependencies array for the effect (similar to useEffect)
 */
export function useSetPageHeader(
  pageInfo: PageHeaderInfo | null,
  deps: DependencyList = [],
) {
  const { setPageInfo } = usePageHeader();

  useEffect(() => {
    setPageInfo(pageInfo);
    return () => setPageInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPageInfo, ...deps]);
}
