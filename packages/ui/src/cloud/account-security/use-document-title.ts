/**
 * Document-title setter for the account/security cloud routes.
 *
 * cloud-frontend used `<Helmet>` for the page `<title>`, but `@elizaos/ui` has
 * no `react-helmet-async` dependency. This sets `document.title` while the route
 * is mounted and restores the previous title on unmount, matching the api-keys /
 * documents domains' `use-document-title`.
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
