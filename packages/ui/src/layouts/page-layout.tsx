/**
 * PageLayout: a WorkspaceLayout with the header placed outside the content pane.
 */

import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import type { SidebarProps } from "../components/composites/sidebar/sidebar-types";
import { cn } from "../utils/cn";
import { WorkspaceLayout } from "./workspace-layout/workspace-layout";

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

export type PageLayoutHeaderProps = HTMLAttributes<HTMLDivElement>;

export function PageLayoutHeader({
  className,
  ...props
}: PageLayoutHeaderProps) {
  return <div className={cn("mb-4 shrink-0", className)} {...props} />;
}
