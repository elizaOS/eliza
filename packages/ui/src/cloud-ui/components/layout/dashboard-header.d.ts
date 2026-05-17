import { type ReactNode } from "react";
export interface DashboardHeaderPageInfo {
  title: string;
  actions?: ReactNode;
}
export interface DashboardHeaderProps {
  onToggleSidebar: () => void;
  pageInfo?: DashboardHeaderPageInfo | null;
  isAnonymous?: boolean;
  loginHref?: string;
  anonymousCta?: ReactNode;
  rightContent?: ReactNode;
  children?: ReactNode;
}
declare function DashboardHeaderComponent({
  onToggleSidebar,
  pageInfo,
  isAnonymous,
  loginHref,
  anonymousCta,
  rightContent,
  children,
}: DashboardHeaderProps): import("react/jsx-runtime").JSX.Element;
export declare const DashboardHeader: import("react").MemoExoticComponent<
  typeof DashboardHeaderComponent
>;
//# sourceMappingURL=dashboard-header.d.ts.map
