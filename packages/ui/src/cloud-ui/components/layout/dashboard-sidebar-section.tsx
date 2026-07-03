"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { cn } from "../../lib/utils";
import type { AdminRole } from "../../types/cloud-api";
import { DashboardSidebarNavigationItem } from "./dashboard-sidebar-item";
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
  /** The resolved admin tier, or null when the user is not an admin. */
  adminRole?: AdminRole | null;
  isCollapsed?: boolean;
  isFeatureEnabled?: (featureFlag: string) => boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}

export function DashboardSidebarNavigationSection({
  section,
  activePath,
  authenticated,
  isAdmin = false,
  adminRole,
  isCollapsed = false,
  isFeatureEnabled,
  renderLink,
  getLoginHref,
  isItemActive,
}: DashboardSidebarNavigationSectionProps) {
  const storageKey = section.title
    ? `sidebar-section-${section.title.toLowerCase().replace(/\s+/g, "-")}`
    : null;

  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window === "undefined" || !storageKey) return true;
    const stored = localStorage.getItem(storageKey);
    return stored === null ? true : stored === "true";
  });

  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(isOpen));
    }
  }, [isOpen, storageKey]);

  const filteredItems = useMemo(() => {
    return section.items.filter((item) => {
      if (item.featureFlag && isFeatureEnabled?.(item.featureFlag) === false) {
        return false;
      }
      if (item.adminOnly && !isAdmin) {
        return false;
      }
      if (item.superAdminOnly && adminRole !== "super_admin") {
        return false;
      }
      return true;
    });
  }, [adminRole, isAdmin, isFeatureEnabled, section.items]);

  if (section.adminOnly && !isAdmin) {
    return null;
  }

  if (filteredItems.length === 0) {
    return null;
  }

  const renderItems = (collapsed = false) =>
    filteredItems.map((item) => (
      <DashboardSidebarNavigationItem
        key={item.id}
        item={item}
        activePath={activePath}
        authenticated={authenticated}
        isCollapsed={collapsed}
        renderLink={renderLink}
        getLoginHref={getLoginHref}
        isItemActive={isItemActive}
      />
    ));

  if (isCollapsed) {
    return <nav className="space-y-1">{renderItems(true)}</nav>;
  }

  if (!section.title) {
    return <nav className="space-y-1">{renderItems()}</nav>;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="group mb-3 flex w-full items-center px-3 transition-opacity hover:opacity-80">
        <h3 className="flex-1 whitespace-nowrap text-left font-mono text-sm text-white/62">
          {section.title}
        </h3>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-white/54 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <nav className="space-y-1">{renderItems()}</nav>
      </CollapsibleContent>
    </Collapsible>
  );
}
