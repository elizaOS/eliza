/**
 * Set `document.title` for an admin cloud page.
 *
 * The cloud-frontend admin pages used react-helmet-async `<Helmet>`; the
 * app-hosted cloud surfaces set the title imperatively instead (matching the
 * sibling `account-security` / `api-keys` `use-document-title.ts` pattern), so
 * the admin domain carries no Helmet dependency.
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
