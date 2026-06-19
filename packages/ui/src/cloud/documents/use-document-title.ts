/**
 * Document-title setter for the Documents (Knowledge) cloud route.
 *
 * cloud-frontend used `<Helmet>` for the page `<title>`, but `@elizaos/ui` has
 * no `react-helmet-async` dependency. This sets `document.title` while the route
 * is mounted and restores the previous title on unmount so navigating back to
 * the app shell doesn't leave the knowledge-page title behind. Mirrors the
 * api-keys domain's `use-document-title`.
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
