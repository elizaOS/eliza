/**
 * Relationships — a top-level nav view: a chromeless "Relationships" header over
 * the relationship-graph workspace. On mobile the people sidebar opens from a
 * compact "People" control in the header, never an inline trigger between the
 * header and the content.
 */

import type { ReactNode } from "react";
import { useWorkspaceMobileSidebarHeader } from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls.hooks";
import { WorkspaceMobileSidebarScope } from "../../layouts/workspace-layout/workspace-mobile-sidebar-scope";
import { ViewHeader } from "../shared/ViewHeader";
import { ViewHeaderSidebarTrigger } from "../shared/ViewHeaderSidebarTrigger";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { RelationshipsWorkspaceView } from "./relationships/RelationshipsWorkspaceView";
export function RelationshipsView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const mobileSidebarHeader = useWorkspaceMobileSidebarHeader();
  return (
    <ShellViewAgentSurface viewId="relationships">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader
          title="Relationships"
          right={
            <ViewHeaderSidebarTrigger control={mobileSidebarHeader.control} />
          }
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspaceMobileSidebarScope controls={mobileSidebarHeader.controls}>
            <RelationshipsWorkspaceView contentHeader={contentHeader} />
          </WorkspaceMobileSidebarScope>
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
