/**
 * Knowledge — the top-level `/documents` route: the folded multimedia hub
 * (#13594). A thin host that mounts the standalone {@link DocumentsView} (which
 * owns its own "Knowledge" header, media-format facets, and pushed reader)
 * inside the shell's agent surface, outside the character-editor chrome.
 */

import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { DocumentsView } from "./DocumentsView";

export function KnowledgeView() {
  return (
    <ShellViewAgentSurface viewId="documents">
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-4xl flex-1 flex-col px-4 pb-[var(--view-pad-bottom)] sm:px-5 lg:px-6">
          <DocumentsView standalone fileInputId="knowledge-hub-upload" />
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
