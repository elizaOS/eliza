import * as React from "react";
import type { SidebarProps } from "../composites/sidebar/sidebar-types";
export interface AppPageSidebarProps
  extends Omit<SidebarProps, "defaultCollapsed" | "footer" | "width"> {
  bottomAction?: React.ReactNode;
  defaultCollapsed?: boolean;
  defaultWidth?: number;
  footer?: React.ReactNode;
  width?: number;
  widthStorageKey?: string;
}
export declare const AppPageSidebar: React.ForwardRefExoticComponent<
  AppPageSidebarProps & React.RefAttributes<HTMLElement>
>;
//# sourceMappingURL=AppPageSidebar.d.ts.map
