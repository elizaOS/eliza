import type {
  DashboardSidebarItem,
  DashboardSidebarLinkRenderer,
} from "./dashboard-sidebar-types";
export interface DashboardSidebarNavigationItemProps {
  item: DashboardSidebarItem;
  activePath: string;
  authenticated: boolean;
  isCollapsed?: boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}
export declare function DashboardSidebarNavigationItem({
  item,
  activePath,
  authenticated,
  isCollapsed,
  renderLink,
  getLoginHref,
  isItemActive,
}: DashboardSidebarNavigationItemProps):
  | string
  | number
  | bigint
  | boolean
  | import("react/jsx-runtime").JSX.Element
  | Iterable<import("react").ReactNode>
  | Promise<
      | string
      | number
      | bigint
      | boolean
      | import("react").ReactPortal
      | import("react").ReactElement<
          unknown,
          string | import("react").JSXElementConstructor<any>
        >
      | Iterable<import("react").ReactNode>
      | null
      | undefined
    >
  | null
  | undefined;
//# sourceMappingURL=dashboard-sidebar-item.d.ts.map
