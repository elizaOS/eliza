/**
 * PageLayout: a WorkspaceLayout with the header placed outside the content pane.
 */

import type { ComponentProps, ReactElement } from "react";
import type { SidebarProps } from "../../components/composites/sidebar/sidebar-types";
import { WorkspaceLayout } from "../workspace-layout/workspace-layout";

export interface PageLayoutProps
  extends Omit<
    ComponentProps<typeof WorkspaceLayout>,
    "headerPlacement" | "sidebar"
  > {
  sidebar?: ReactElement<SidebarProps>;
}

export function PageLayout(props: PageLayoutProps) {
  return <WorkspaceLayout {...props} headerPlacement="outside" />;
}
