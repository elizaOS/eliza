/**
 * Sidebar navigation section component with collapsible functionality.
 * Persists open/closed state to localStorage and provides color-coded sections.
 * Supports admin-only sections that are hidden from non-admin users.
 *
 * @param props - Sidebar section configuration
 * @param props.section - Section data including title, items, and metadata
 */

"use client";

import { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { SidebarNavigationItem } from "./sidebar-item";
import type { SidebarSection, SidebarItem } from "./sidebar-data";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { isFeatureEnabled } from "@/lib/config/feature-flags";
import { useAdmin } from "@/lib/hooks/use-admin";

interface SidebarNavigationSectionProps {
  section: SidebarSection;
  isCollapsed?: boolean;
}

export function SidebarNavigationSection({
  section,
  isCollapsed = false,
}: SidebarNavigationSectionProps) {
  // Use the centralized admin hook with request deduplication
  const { isAdmin } = useAdmin();

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
      // Check feature flag
      if (item.featureFlag && !isFeatureEnabled(item.featureFlag)) {
        return false;
      }
      // Check admin-only items
      if (item.adminOnly && !isAdmin) {
        return false;
      }
      return true;
    });
  }, [section.items, isAdmin]);

  // Hide admin-only sections from non-admins
  if (section.adminOnly && !isAdmin) {
    return null;
  }

  if (filteredItems.length === 0) {
    return null;
  }

  // Check if this section is "coming soon" (disabled)
  const isComingSoon =
    section.title?.toLowerCase() === "monetization" ||
    section.title?.toLowerCase() === "admin";

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
