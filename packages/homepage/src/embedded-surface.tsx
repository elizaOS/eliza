/**
 * Shared provider boundary for marketing pages embedded in the unified Eliza
 * web shell. The host owns routing; this boundary owns only homepage language,
 * metadata, and styling.
 */
/// <reference path="./types/speech-recognition.d.ts" />
import type { ReactNode } from "react";
import { DocumentMetaManager } from "./components/DocumentMetaManager";
import { I18nProvider } from "./providers/I18nProvider";
import "./index.css";

export function EmbeddedMarketingSurface({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <I18nProvider>
      <DocumentMetaManager />
      {children}
    </I18nProvider>
  );
}
