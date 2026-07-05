/**
 * Shared shell for the standalone console pages mounted by the cloud router at
 * the apex console (elizacloud.ai), where the in-app Settings view never
 * mounts. Every one of these pages was an independent thin wrapper that
 * repeated the exact same container (`mx-auto w-full max-w-4xl px-4 py-6
 * md:px-6 md:py-8`) around a self-loading surface, and most also repeated the
 * `useDocumentTitle(t(key, { defaultValue }))` boilerplate. Two copies of one
 * layout that can only drift; this centralizes both so the page container and
 * the title-setting convention live in a single place.
 *
 * Behavior-preserving: pages that set a document title pass `titleKey` +
 * `titleDefault`; pages whose surface sets its own title (or which have no
 * title) simply omit them — the title effect is not mounted at all in that
 * case, exactly as before (those pages never called `useDocumentTitle`). No
 * local `PageHeaderProvider` is introduced — the surface's `useSetPageHeader`
 * must reach `ConsoleShell`'s provider, exactly as before.
 */

import type { ReactNode } from "react";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "./CloudI18nProvider";

export interface ConsolePageProps {
  /**
   * i18n key for the document title. When provided the page sets
   * `document.title` while mounted. Omit when the surface sets its own title
   * (or the page has none).
   */
  titleKey?: string;
  /** Fallback copy for {@link titleKey} when the translation is missing. */
  titleDefault?: string;
  /** The surface body (plus any adjacent links the page renders). */
  children: ReactNode;
}

/**
 * Leaf that resolves the translated title and sets `document.title`. Rendered
 * only when a title key exists so `useDocumentTitle` is never mounted (and thus
 * never touches `document.title`) for the title-less pages.
 */
function ConsolePageTitle({
  titleKey,
  titleDefault,
}: {
  titleKey: string;
  titleDefault?: string;
}) {
  const t = useCloudT();
  useDocumentTitle(t(titleKey, { defaultValue: titleDefault ?? titleKey }));
  return null;
}

export function ConsolePage({
  titleKey,
  titleDefault,
  children,
}: ConsolePageProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      {children}
      {titleKey ? (
        <ConsolePageTitle titleKey={titleKey} titleDefault={titleDefault} />
      ) : null}
    </div>
  );
}

export default ConsolePage;
