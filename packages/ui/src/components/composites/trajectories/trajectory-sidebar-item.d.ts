import type * as React from "react";
export interface TrajectorySidebarItemProps {
  active?: boolean;
  callCount: React.ReactNode;
  durationLabel: React.ReactNode;
  onSelect?: () => void;
  sourceColor?: string;
  sourceLabel: React.ReactNode;
  statusColor?: string;
  statusLabel: React.ReactNode;
  title: React.ReactNode;
  tokenLabel: React.ReactNode;
}
export declare function TrajectorySidebarItem({
  active,
  callCount,
  durationLabel,
  onSelect,
  sourceColor,
  sourceLabel,
  statusColor,
  statusLabel,
  title,
  tokenLabel,
}: TrajectorySidebarItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=trajectory-sidebar-item.d.ts.map
