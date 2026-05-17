/**
 * Page header context provider and hooks for managing page header information.
 * Provides centralized header state management across the application.
 */
import { type DependencyList, type ReactNode } from "react";

interface PageHeaderInfo {
  title: string;
  description?: string;
  actions?: ReactNode;
}
interface PageHeaderContextValue {
  pageInfo: PageHeaderInfo | null;
  setPageInfo: (info: PageHeaderInfo | null) => void;
}
export declare function PageHeaderProvider({
  children,
}: {
  children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function usePageHeader(): PageHeaderContextValue;
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
export declare function useSetPageHeader(
  pageInfo: PageHeaderInfo | null,
  deps?: DependencyList,
): void;
//# sourceMappingURL=page-header-context.d.ts.map
