/**
 * Set `document.title` while a cloud route is mounted and restore the previous
 * title on unmount. cloud-frontend used react-helmet-async `<Helmet>`; `@elizaos/ui`
 * has no such dependency, so the cloud domains set the title imperatively.
 *
 * Canonical shared copy for all cloud route domains.
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
