/**
 * Lightweight document-title setter for the app-hosted public cloud pages.
 *
 * `@elizaos/ui` does not depend on `react-helmet-async`, and these public
 * routes only need to set the page title
 * (and occasionally a robots/description meta) while mounted. On unmount the
 * previous title is restored so navigating away (back to the app shell) doesn't
 * leave the public page's title behind.
 */

import { useEffect } from "react";

/** Set `document.title` while the calling component is mounted. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * Set a `<meta>` value (e.g. `name="robots"` → `noindex`) while mounted, then
 * remove it on unmount. Only used by the public shared-chat page to keep
 * not-found agent pages out of the index.
 */
export function useMetaTag(name: string, content: string | null): void {
  useEffect(() => {
    if (typeof document === "undefined" || content === null) return;
    const meta = document.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, [name, content]);
}
