import type * as React from "react";

import type { SidebarProps } from "../../components/composites/sidebar";

export type WorkspaceLayoutHeaderPlacement = "inside" | "outside";

export interface WorkspaceLayoutProps
  extends React.HTMLAttributes<HTMLDivElement> {
  sidebar?: React.ReactElement<SidebarProps> | null;
  contentHeader?: React.ReactNode;
  contentHeaderClassName?: string;
  contentClassName?: string;
  contentInnerClassName?: string;
  contentRef?: React.Ref<HTMLElement>;
  sidebarCollapsible?: boolean;
  mobileSidebarLabel?: React.ReactNode;
  mobileSidebarTriggerClassName?: string;
  contentPadding?: boolean;
  headerPlacement?: WorkspaceLayoutHeaderPlacement;
  footer?: React.ReactNode;
  footerClassName?: string;
}
