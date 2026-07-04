/**
 * Page header context provider for managing page header information across the
 * application. The context object and the usePageHeader / useSetPageHeader hooks
 * live in ./page-header-context.hooks so this file can export only the
 * PageHeaderProvider component (React Fast Refresh-compatible).
 */

"use client";

import { type ReactNode, useContext, useMemo, useState } from "react";
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

/**
 * Provide a page-header context ONLY when there isn't one already.
 *
 * Standalone cloud routes need their own {@link PageHeaderProvider} (mounted
 * directly by `CloudRouterShell` / natively in the app, they have no ancestor
 * provider and `useSetPageHeader` would throw). But the SAME routes also render
 * inside `ConsoleShell`, which already provides one and reads it to draw the
 * top-bar title. An unconditional inner provider SHADOWS the shell's, so
 * `useSetPageHeader` writes to a dead context and the top bar shows no title
 * (and any in-page heading then reads as a second, competing title).
 *
 * Wrapping a route body in this component defers to the shell's provider when
 * present, and supplies its own otherwise — so the title always reaches
 * whichever header is actually rendered.
 */
export function EnsurePageHeaderProvider({
  children,
}: {
  children: ReactNode;
}) {
  const hasAncestorProvider = useContext(PageHeaderContext) !== undefined;
  if (hasAncestorProvider) {
    return <>{children}</>;
  }
  return <PageHeaderProvider>{children}</PageHeaderProvider>;
}
