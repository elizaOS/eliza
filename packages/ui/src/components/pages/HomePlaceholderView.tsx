import { Button, ContentLayout, PagePanel } from "@elizaos/ui";
import type { ReactNode } from "react";
import { useApp } from "../../state";

/**
 * Placeholder rendered when no installed app declares
 * `elizaos.app.mainTab: true` — i.e. the shell has no default landing
 * surface to mount. Phase 1 of the agent + app-core extraction plumbs
 * the discovery seam; until an app like `app-chat` claims the seam,
 * the shell still falls back to the legacy chat tab so this view is
 * not yet reachable in practice. It exists so subsequent phases can
 * drop the chat fallback without leaving the user staring at a blank
 * panel.
 */
export function HomePlaceholderView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  const { setTab } = useApp();
  return (
    <ContentLayout contentHeader={contentHeader} inModal={inModal}>
      <PagePanel>
        <div className="flex flex-col items-center justify-center gap-4 px-8 py-16 text-center">
          <h2 className="text-lg font-medium">No main app installed yet</h2>
          <p className="text-sm opacity-70 max-w-md">
            Install an app from the Apps tab and mark it as your main tab to see
            it here.
          </p>
          <Button onClick={() => setTab("apps")}>Browse apps</Button>
        </div>
      </PagePanel>
    </ContentLayout>
  );
}
