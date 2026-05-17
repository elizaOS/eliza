import { type ReactNode } from "react";
import type {
  DashboardSidebarItem,
  DashboardSidebarLinkRenderer,
  DashboardSidebarSection,
} from "./dashboard-sidebar-types";
export interface DashboardSidebarProps {
  sections: DashboardSidebarSection[];
  activePath: string;
  authenticated: boolean;
  className?: string;
  isOpen?: boolean;
  isAdmin?: boolean;
  adminRole?: string | null;
  onToggle?: () => void;
  isFeatureEnabled?: (featureFlag: string) => boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  logo?: ReactNode;
  footer?: ReactNode;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}
declare function DashboardSidebarComponent({
  sections,
  activePath,
  authenticated,
  className,
  isOpen,
  isAdmin,
  adminRole,
  onToggle,
  isFeatureEnabled,
  renderLink,
  logo,
  footer,
  getLoginHref,
  isItemActive,
}: DashboardSidebarProps): import("react/jsx-runtime").JSX.Element;
export declare const DashboardSidebar: import("react").MemoExoticComponent<
  typeof DashboardSidebarComponent
>;
//# sourceMappingURL=dashboard-sidebar.d.ts.map
