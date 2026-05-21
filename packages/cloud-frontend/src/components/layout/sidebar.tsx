"use client";

import {
  DashboardSidebar,
  type DashboardSidebarItem,
  type DashboardSidebarLinkRenderProps,
  ElizaCloudLockup,
} from "@elizaos/ui";
import { memo, useCallback, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import type { FeatureFlag } from "@/lib/config/feature-flags";
import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { useAdmin } from "@/lib/hooks/use-admin";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { useT } from "@/providers/I18nProvider";
import { SidebarBottomPanel } from "./sidebar-bottom-panel";
import { getSidebarSections } from "./sidebar-data";

interface SidebarProps {
  className?: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

function SidebarComponent({
  className,
  isOpen = false,
  onToggle,
}: SidebarProps) {
  const activePath = useLocation().pathname;
  const { authenticated } = useSessionAuth();
  const { isAdmin, adminRole } = useAdmin();
  const t = useT();
  const sections = useMemo(() => getSidebarSections(t), [t]);

  const renderLink = useCallback(
    ({
      href,
      className: linkClassName,
      style,
      children,
    }: DashboardSidebarLinkRenderProps) => {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={linkClassName}
            style={style}
          >
            {children}
          </a>
        );
      }
      return (
        <Link to={href} className={linkClassName} style={style}>
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
    <DashboardSidebar
      sections={sections}
      activePath={activePath}
      authenticated={authenticated}
      className={className}
      isOpen={isOpen}
      isAdmin={isAdmin}
      adminRole={adminRole}
      onToggle={onToggle}
      isFeatureEnabled={featureEnabled}
      renderLink={renderLink}
      getLoginHref={getLoginHref}
      logo={
        <Link
          to="/dashboard"
          className="relative z-10 flex items-center gap-2 hover:opacity-80"
        >
          <ElizaCloudLockup
            logoClassName="h-4 md:h-5"
            textClassName="text-[9px] md:text-[10px]"
          />
        </Link>
      }
      footer={<SidebarBottomPanel />}
    />
  );
}

const Sidebar = memo(SidebarComponent);
export default Sidebar;
