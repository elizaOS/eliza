/**
 * Sidebar navigation item component displaying individual navigation links.
 * Supports active state highlighting, locked state for anonymous users, and badges.
 *
 * @param props - Sidebar navigation item configuration
 * @param props.item - Sidebar item data including label, href, icon, and permissions
 */

"use client";

import { Lock } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/cloud-ui/components/tooltip";
import type { SidebarItem } from "./sidebar-data";

interface SidebarNavigationItemProps {
  item: SidebarItem;
  isCollapsed?: boolean;
}

export function SidebarNavigationItem({ item, isCollapsed = false }: SidebarNavigationItemProps) {
  const pathname = useLocation().pathname;
  const { authenticated } = useSessionAuth();
  // Use exact match for dashboard and admin root; startsWith for other routes
  const isActive =
    item.href === "/dashboard" || item.href === "/dashboard/admin"
      ? pathname === item.href
      : pathname === item.href ||
        (pathname?.startsWith(item.href + "/") && !pathname?.startsWith(item.href + "/create"));
  const Icon = item.icon;

  // Check if this item is coming soon (disabled)
  if (item.comingSoon) {
    // Hide coming soon items when collapsed
    if (isCollapsed) return null;

    return (
      <div
        className={cn(
          "relative flex items-center gap-3 border border-white/10 bg-white/[0.03] px-3 py-2.5",
          "text-white/40 cursor-default select-none opacity-50",
        )}
        style={{
          fontFamily: "var(--font-roboto-mono)",
          fontWeight: 400,
          fontSize: "14px",
          lineHeight: "18px",
          letterSpacing: "-0.003em",
        }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 whitespace-nowrap">{item.label}</span>
        <span
          className="bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/40"
          style={{
            fontFamily: "var(--font-roboto-mono)",
          }}
        >
          soon
        </span>
      </div>
    );
  }

  // Check if this item is locked for anonymous users
  const isLocked = !authenticated && item.freeAllowed === false;

  // If item is locked, show as button with login prompt
  // Use returnTo to redirect back to the locked item after login
  if (isLocked) {
    const loginHref = `/login?returnTo=${encodeURIComponent(item.href)}`;
    const lockedButton = (
      <Link
        to={loginHref}
        className={cn(
          "relative flex w-full items-center border border-transparent transition-all duration-200",
          "hover:border-white/10 hover:bg-white/[0.04] hover:text-white/80",
          "text-white/40 cursor-pointer",
          isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
        )}
        style={{
          fontFamily: "var(--font-roboto-mono)",
          fontWeight: 400,
          fontSize: "14px",
          lineHeight: "18px",
          letterSpacing: "-0.003em",
        }}
      >
        <Icon className="h-4 w-4 opacity-50 shrink-0" />
        {!isCollapsed && (
          <>
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            <Lock className="h-3 w-3 text-white/40 shrink-0" />
          </>
        )}
      </Link>
    );

    if (isCollapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{lockedButton}</TooltipTrigger>
          <TooltipContent side="right" className="bg-neutral-800 text-white border-white/10">
            {item.label}
          </TooltipContent>
        </Tooltip>
      );
    }

    return lockedButton;
  }

  const linkClasses = cn(
    "relative flex items-center border transition-all duration-200",
    "hover:border-white/10 hover:bg-white/[0.04] hover:text-white",
    isActive
      ? "border-[#FF5800]/25 bg-[#FF5800]/10 text-white"
      : "border-transparent text-white/60",
    isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
  );

  const linkStyles = {
    fontFamily: "var(--font-roboto-mono)",
    fontWeight: 400,
    fontSize: "14px",
    lineHeight: "18px",
    letterSpacing: "-0.003em",
  } as const;

  const linkContents = (
    <>
      <Icon className="h-4 w-4 shrink-0 transition-colors" />
      {!isCollapsed && (
        <>
          <span className="flex-1 whitespace-nowrap">{item.label}</span>
          {item.isNew && (
            <span
              className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
              style={{
                backgroundColor: "#FF580020",
                color: "#FF5800",
                border: "1px solid #FF580040",
              }}
            >
              NEW
            </span>
          )}
          {item.badge && !item.isNew && (
            <span className="bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/60">
              {item.badge}
            </span>
          )}
        </>
      )}
    </>
  );

  const linkElement = (
    <Link to={item.href} className={linkClasses} style={linkStyles}>
      {linkContents}
    </Link>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
        <TooltipContent side="right" className="bg-neutral-800 text-white border-white/10">
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkElement;
}
