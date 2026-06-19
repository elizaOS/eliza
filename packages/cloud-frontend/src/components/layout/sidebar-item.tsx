"use client";

import {
  type DashboardSidebarItem,
  type DashboardSidebarLinkRenderProps,
  DashboardSidebarNavigationItem,
} from "@elizaos/ui";
import { useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import type { SidebarItem } from "./sidebar-data";

interface SidebarNavigationItemProps {
  item: SidebarItem;
  isCollapsed?: boolean;
}

export function SidebarNavigationItem({
  item,
  isCollapsed = false,
}: SidebarNavigationItemProps) {
  const activePath = useLocation().pathname;
  const { authenticated } = useSessionAuth();

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

  const getLoginHref = useCallback(
    (sidebarItem: DashboardSidebarItem) =>
      `/login?returnTo=${encodeURIComponent(sidebarItem.href)}`,
    [],
  );

  return (
    <DashboardSidebarNavigationItem
      item={item}
      activePath={activePath}
      authenticated={authenticated}
      isCollapsed={isCollapsed}
      renderLink={renderLink}
      getLoginHref={getLoginHref}
    />
  );
}
