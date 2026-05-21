"use client";

import {
  type DashboardSidebarItem,
  type DashboardSidebarLinkRenderProps,
  DashboardSidebarNavigationSection,
} from "@elizaos/ui";
import { useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import type { FeatureFlag } from "@/lib/config/feature-flags";
import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { useAdmin } from "@/lib/hooks/use-admin";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import type { SidebarSection } from "./sidebar-data";

interface SidebarNavigationSectionProps {
  section: SidebarSection;
  isCollapsed?: boolean;
}

export function SidebarNavigationSection({
  section,
  isCollapsed = false,
}: SidebarNavigationSectionProps) {
  const activePath = useLocation().pathname;
  const { authenticated } = useSessionAuth();
  const { isAdmin, adminRole } = useAdmin();

  const renderLink = useCallback(
    ({ href, className, style, children }: DashboardSidebarLinkRenderProps) => {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={className}
            style={style}
          >
            {children}
          </a>
        );
      }
      return (
        <Link to={href} className={className} style={style}>
          {children}
        </Link>
      );
    },
    [],
  );

  const featureEnabled = useCallback(
    (featureFlag: string) => isFeatureEnabled(featureFlag as FeatureFlag),
    [],
  );

  const getLoginHref = useCallback(
    (item: DashboardSidebarItem) =>
      `/login?returnTo=${encodeURIComponent(item.href)}`,
    [],
  );

  return (
    <DashboardSidebarNavigationSection
      section={section}
      activePath={activePath}
      authenticated={authenticated}
      isAdmin={isAdmin}
      adminRole={adminRole}
      isCollapsed={isCollapsed}
      isFeatureEnabled={featureEnabled}
      renderLink={renderLink}
      getLoginHref={getLoginHref}
    />
  );
}
