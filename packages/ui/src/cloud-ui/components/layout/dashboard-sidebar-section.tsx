"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../collapsible";
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
  adminRole?: string | null;
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

  const isComingSoon = false;

  if (isCollapsed && isComingSoon) {
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

  if (isComingSoon) {
    return (
      <div className="mb-3 flex w-full cursor-default select-none items-center px-3 opacity-50">
        <h3 className="flex-1 whitespace-nowrap text-left font-mono text-sm text-white/62">
          {section.title}
        </h3>
        <span
          className="rounded-sm bg-white/18 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/58"
          style={{
            fontFamily: "var(--font-roboto-mono)",
          }}
        >
          soon
        </span>
      </div>
    );
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
