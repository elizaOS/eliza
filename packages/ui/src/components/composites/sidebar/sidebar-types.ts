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
  showExpandedCollapseButton?: boolean;
  collapseButtonTestId?: string;
  expandButtonTestId?: string;
  collapseButtonAriaLabel?: string;
  expandButtonAriaLabel?: string;
  bodyClassName?: string;
  headerClassName?: string;
  footerClassName?: string;
  collapsedContentClassName?: string;
  collapseButtonClassName?: string;
  /** Desktop-only: enable drag-to-resize on the inside edge. */
  resizable?: boolean;
  /** Current width in pixels when resizable. Overrides the default width. */
  width?: number;
  /** Fired while the user drags the resize handle. */
  onWidthChange?: (width: number) => void;
  /** Min width in px (default 200). Drag below this and onCollapseRequest fires. */
  minWidth?: number;
  /** Max width in px (default 560). */
  maxWidth?: number;
  /**
   * Called when the user drags the resize handle to or past the collapse
   * threshold (default: minWidth - 40). Caller should collapse the sidebar.
   */
  onCollapseRequest?: () => void;
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
