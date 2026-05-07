/**
 * Sidebar navigation section component with collapsible functionality.
 * Persists open/closed state to localStorage and provides color-coded sections.
 * Supports admin-only sections that are hidden from non-admin users.
 *
 * @param props - Sidebar section configuration
 * @param props.section - Section data including title, items, and metadata
 */

"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { useAdmin } from "@/lib/hooks/use-admin";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@elizaos/cloud-ui/components/collapsible";
import type { SidebarItem, SidebarSection } from "./sidebar-data";
import { SidebarNavigationItem } from "./sidebar-item";

interface SidebarNavigationSectionProps {
  section: SidebarSection;
  isCollapsed?: boolean;
}

export function SidebarNavigationSection({
  section,
  isCollapsed = false,
}: SidebarNavigationSectionProps) {
  // Use the centralized admin hook with request deduplication
  const { isAdmin, adminRole } = useAdmin();

  // Generate a storage key based on section title
  const storageKey = section.title
    ? `sidebar-section-${section.title.toLowerCase().replace(/\s+/g, "-")}`
    : null;

  // Initialize state from localStorage (default to open)
  // MUST be before any conditional returns to follow React hooks rules
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window === "undefined" || !storageKey) return true;
    const stored = localStorage.getItem(storageKey);
    return stored === null ? true : stored === "true";
  });

  // Persist state to localStorage
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(isOpen));
    }
  }, [isOpen, storageKey]);

  const filteredItems = useMemo(() => {
    return section.items.filter((item: SidebarItem) => {
      if (item.featureFlag && !isFeatureEnabled(item.featureFlag)) {
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
  }, [section.items, isAdmin, adminRole]);

  // Hide admin-only sections from non-admins
  if (section.adminOnly && !isAdmin) {
    return null;
  }

  if (filteredItems.length === 0) {
    return null;
  }

  const isComingSoon = false;

  // Hide coming soon sections when collapsed
  if (isCollapsed && isComingSoon) {
    return null;
  }

  // If collapsed, render just icons
  if (isCollapsed) {
    return (
      <nav className="space-y-1">
        {filteredItems.map((item) => (
          <SidebarNavigationItem key={item.id} item={item} isCollapsed />
        ))}
      </nav>
    );
  }

  // If there's no title, render without collapsible (e.g., Dashboard section)
  if (!section.title) {
    return (
      <nav className="space-y-1">
        {filteredItems.map((item) => (
          <SidebarNavigationItem key={item.id} item={item} />
        ))}
      </nav>
    );
  }

  // Render collapsed "coming soon" sections
  if (isComingSoon) {
    return (
      <div className="w-full mb-3 px-3 flex items-center opacity-50 select-none cursor-default">
        <h3 className="flex-1 text-sm font-mono text-white/50 text-left whitespace-nowrap">
          {section.title}
        </h3>
        <span
          className="text-[10px] font-medium uppercase tracking-wider text-white/40 bg-white/10 px-1.5 py-0.5 rounded"
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
      <CollapsibleTrigger className="group w-full mb-3 px-3 flex items-center hover:opacity-80 transition-opacity">
        <h3 className="flex-1 text-sm font-mono text-white/50 text-left whitespace-nowrap">
          {section.title}
        </h3>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-white/40 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <nav className="space-y-1">
          {filteredItems.map((item) => (
            <SidebarNavigationItem key={item.id} item={item} />
          ))}
        </nav>
      </CollapsibleContent>
    </Collapsible>
  );
}
