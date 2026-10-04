/**
 * Set `document.title` while a cloud route is mounted and restore the previous
 * title on unmount. `@elizaos/ui` has no react-helmet dependency, so the cloud
 * domains set the title imperatively. Canonical shared copy for all cloud
 * route domains.
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
