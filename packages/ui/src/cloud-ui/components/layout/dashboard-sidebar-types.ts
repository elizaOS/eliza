/**
 * Types for the dashboard sidebar model (items, sections, icons).
 */
import type { ComponentType, CSSProperties, ReactNode } from "react";

export interface DashboardSidebarItem {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  badge?: string | number;
  isNew?: boolean;
  freeAllowed?: boolean;
  featureFlag?: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  comingSoon?: boolean;
}

export interface DashboardSidebarSection {
  title?: string;
  items: DashboardSidebarItem[];
  adminOnly?: boolean;
}

export interface DashboardSidebarLinkRenderProps {
  href: string;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
}

export type DashboardSidebarLinkRenderer = (
  props: DashboardSidebarLinkRenderProps,
) => ReactNode;
