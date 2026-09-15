/**
 * Props for PageLayout, extending WorkspaceLayout with the sidebar shape.
 */
import type * as React from "react";

import type { SidebarProps } from "../../components/composites/sidebar";
import type { WorkspaceLayoutProps } from "../workspace-layout/workspace-layout-types";

export interface PageLayoutProps
  extends Omit<WorkspaceLayoutProps, "headerPlacement" | "sidebar"> {
  /** Optional master-navigation pane; omit it for loading and unavailable states. */
  sidebar?: React.ReactElement<SidebarProps>;
}

export interface PageLayoutMobileDrawerProps {
  isDesktop: boolean;
  mobileSidebarLabel?: React.ReactNode;
  mobileSidebarOpen: boolean;
  mobileSidebarTriggerClassName?: string;
  onMobileSidebarOpenChange: (open: boolean) => void;
  sidebar: React.ReactElement<SidebarProps>;
}
