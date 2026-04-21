import type * as React from "react";

export type SidebarVariant = "default" | "game-modal" | "mobile";

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  testId?: string;
  variant?: SidebarVariant;
  collapsible?: boolean;
  contentIdentity?: string;
  syncId?: string;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  collapsedContent?: React.ReactNode;
  collapsedRailAction?: React.ReactNode;
  collapsedRailItems?: React.ReactNode;
  collapseButtonLeading?: React.ReactNode;
  onMobileClose?: () => void;
  mobileTitle?: React.ReactNode;
  mobileMeta?: React.ReactNode;
  mobileCloseLabel?: string;
  collapseButtonTestId?: string;
  expandButtonTestId?: string;
  collapseButtonAriaLabel?: string;
  expandButtonAriaLabel?: string;
  bodyClassName?: string;
  headerClassName?: string;
  footerClassName?: string;
  collapsedContentClassName?: string;
}

export interface SidebarScrollRegionProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SidebarVariant;
}

export interface SidebarPanelProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SidebarVariant;
}

export interface SidebarBodyProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface SidebarHeaderStackProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export interface SidebarFilterBarOption {
  value: string;
  label: React.ReactNode;
}

export interface SidebarFilterBarProps
  extends React.HTMLAttributes<HTMLDivElement> {
  selectValue: string;
  selectOptions: SidebarFilterBarOption[];
  onSelectValueChange: (value: string) => void;
  selectAriaLabel: string;
  selectTestId?: string;
  sortDirection: "asc" | "desc";
  onSortDirectionToggle: () => void;
  sortDirectionButtonTestId?: string;
  sortAscendingLabel?: string;
  sortDescendingLabel?: string;
  refreshButtonTestId?: string;
  refreshLabel?: string;
  onRefresh: () => void;
}
