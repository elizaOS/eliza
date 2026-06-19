/**
 * Document-title setter for the API Explorer cloud route.
 *
 * cloud-frontend used `<Helmet>` for the page `<title>`, but `@elizaos/ui` has
 * no `react-helmet-async` dependency, and `useSetPageHeader` requires a
 * `PageHeaderProvider` ancestor (absent on a standalone cloud route). This sets
 * `document.title` while the route is mounted and restores the previous title on
 * unmount. Mirrors the api-keys and documents domains' `use-document-title`.
 */

import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
