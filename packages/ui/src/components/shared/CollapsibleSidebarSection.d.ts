import * as React from "react";
export interface CollapsibleSidebarSectionProps {
  addLabel?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  collapsed: boolean;
  emptyClassName?: string;
  emptyLabel?: string;
  hoverActionsOnDesktop?: boolean;
  icon?: React.ReactNode;
  indicator?: React.ReactNode;
  label: React.ReactNode;
  onAdd?: () => void;
  onToggleCollapsed: (key: string) => void;
  sectionKey: string;
  testIdPrefix?: string;
}
export declare function CollapsibleSidebarSection({
  addLabel,
  bodyClassName,
  children,
  collapsed,
  emptyClassName,
  emptyLabel,
  hoverActionsOnDesktop,
  icon,
  indicator,
  label,
  onAdd,
  onToggleCollapsed,
  sectionKey,
  testIdPrefix,
}: CollapsibleSidebarSectionProps): React.JSX.Element;
//# sourceMappingURL=CollapsibleSidebarSection.d.ts.map
