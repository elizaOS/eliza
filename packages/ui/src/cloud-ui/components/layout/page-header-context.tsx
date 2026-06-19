/**
 * Page header context provider for managing page header information across the
 * application. The context object and the usePageHeader / useSetPageHeader hooks
 * live in ./page-header-context.hooks so this file can export only the
 * PageHeaderProvider component (React Fast Refresh-compatible).
 */

"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
  PageHeaderContext,
  type PageHeaderInfo,
} from "./page-header-context.hooks";

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

  const contextValue = useMemo(
    () => ({ pageInfo, setPageInfo }),
    [pageInfo, setPageInfo],
  );

  return (
    <PageHeaderContext.Provider value={contextValue}>
      {children}
    </PageHeaderContext.Provider>
  );
}
