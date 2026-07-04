/**
 * Knowledge — a top-level nav view that renders the standalone documents
 * manager under a chromeless "Knowledge" header, outside the character editor
 * chrome.
 */

import { ViewHeader } from "../shared/ViewHeader";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { DocumentsView } from "./DocumentsView";

export function KnowledgeView() {
  return (
    <ShellViewAgentSurface viewId="documents">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader title="Knowledge" />
        <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col px-4 pb-4 sm:px-5 lg:px-6">
          <DocumentsView />
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
