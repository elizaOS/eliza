/**
 * Provider that scopes the mobile-sidebar controls to a subtree so nested
 * layouts don't cross-drive each other's drawers.
 */
import type * as React from "react";

import {
  type WorkspaceMobileSidebarControls,
  WorkspaceMobileSidebarControlsContext,
} from "./workspace-mobile-sidebar-controls.hooks";

/**
 * Moves a PageLayout/WorkspaceLayout mobile drawer trigger out of the content
 * flow. Any layout inside the scope registers its mobile drawer with
 * `controls` (from `useWorkspaceMobileSidebarHeader`) instead of rendering the
 * inline `page-layout-mobile-sidebar-trigger` button between the view header
 * and the content, so the owning view renders a compact
 * `ViewHeaderSidebarTrigger` in its `ViewHeader` `right` slot instead.
 */
export function WorkspaceMobileSidebarScope({
  controls,
  children,
}: {
  controls: WorkspaceMobileSidebarControls;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <WorkspaceMobileSidebarControlsContext.Provider value={controls}>
      {children}
    </WorkspaceMobileSidebarControlsContext.Provider>
  );
}
