import { PagePanel, ShellViewAgentSurface } from "@elizaos/ui";

import { KnowledgeDocumentsView } from "./KnowledgeDocumentsView.js";

export function KnowledgeView() {
  return (
    <ShellViewAgentSurface viewId="documents">
      <div className="settings-surface settings-canvas flex h-full min-h-0 w-full flex-col overflow-hidden">
        <PagePanel.ContentRail
          width="compact"
          className="flex min-h-0 flex-1 flex-col pb-[var(--view-pad-bottom)]"
        >
          <KnowledgeDocumentsView fileInputId="knowledge-hub-upload" />
        </PagePanel.ContentRail>
      </div>
    </ShellViewAgentSurface>
  );
}
