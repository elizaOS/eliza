import * as React from "react";
import { type SidebarRailItemProps } from "./sidebar-content";
export interface SidebarAutoRailItem {
  key: string;
  label: string;
  active: boolean;
  disabled: boolean;
  contentKind: "icon" | "monogram";
  indicatorTone?: SidebarRailItemProps["indicatorTone"];
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  content: React.ReactNode;
}
export declare function buildSidebarAutoRailItems(
  children: React.ReactNode,
): SidebarAutoRailItem[];
export declare function buildSidebarAutoRailItemsFromDom(
  container: HTMLElement,
): SidebarAutoRailItem[];
//# sourceMappingURL=sidebar-auto-rail.d.ts.map
