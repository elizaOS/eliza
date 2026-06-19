/**
 * Document-title setter for the Instances cloud routes.
 *
 * cloud-frontend used `<Helmet>` for the page `<title>`, but `@elizaos/ui` has no
 * `react-helmet-async` dependency and the cloud shell mounts no `HelmetProvider`.
 * This sets `document.title` while a route is mounted and restores the previous
 * title on unmount so navigating back to the app shell doesn't leave a stale
 * Instances title behind. (The cloud-frontend `<meta robots noindex>` /
 * `<meta description>` tags are dropped — they were SEO hints irrelevant to the
 * in-app SPA route, which is auth-gated and never indexed.)
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
