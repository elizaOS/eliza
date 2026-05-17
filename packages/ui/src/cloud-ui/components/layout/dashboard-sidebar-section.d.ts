import type {
  DashboardSidebarItem,
  DashboardSidebarLinkRenderer,
  DashboardSidebarSection as DashboardSidebarSectionData,
} from "./dashboard-sidebar-types";
export interface DashboardSidebarNavigationSectionProps {
  section: DashboardSidebarSectionData;
  activePath: string;
  authenticated: boolean;
  isAdmin?: boolean;
  adminRole?: string | null;
  isCollapsed?: boolean;
  isFeatureEnabled?: (featureFlag: string) => boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}
export declare function DashboardSidebarNavigationSection({
  section,
  activePath,
  authenticated,
  isAdmin,
  adminRole,
  isCollapsed,
  isFeatureEnabled,
  renderLink,
  getLoginHref,
  isItemActive,
}: DashboardSidebarNavigationSectionProps):
  | import("react/jsx-runtime").JSX.Element
  | null;
//# sourceMappingURL=dashboard-sidebar-section.d.ts.map
