/**
 * Sidebar navigation item component displaying individual navigation links.
 * Supports active state highlighting, locked state for anonymous users, and badges.
 *
 * @param props - Sidebar navigation item configuration
 * @param props.item - Sidebar item data including label, href, icon, and permissions
 */

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarItem } from "./sidebar-data";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarNavigationItemProps {
  item: SidebarItem;
  isCollapsed?: boolean;
}

export function SidebarNavigationItem({
  item,
  isCollapsed = false,
}: SidebarNavigationItemProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { authenticated } = usePrivy();
  // Use exact match for dashboard, startsWith for other routes (excluding /create sub-paths)
  const isActive =
    item.href === "/dashboard"
      ? pathname === item.href
      : pathname === item.href ||
        (pathname?.startsWith(item.href + "/") &&
          !pathname?.startsWith(item.href + "/create"));
  const Icon = item.icon;

  // Check if this item is coming soon (disabled)
  if (item.comingSoon) {
    // Hide coming soon items when collapsed
    if (isCollapsed) return null;

    return (
      <div
        className={cn(
          "relative flex items-center gap-3 rounded-lg px-3 py-2.5",
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

  // Check if this item is locked for anonymous users
  const isLocked = !authenticated && item.freeAllowed === false;

  // If item is locked, show as button with login prompt
  // Use returnTo to redirect back to the locked item after login
  if (isLocked) {
    const lockedButton = (
      <button
        onClick={(e) => {
          e.preventDefault();
          router.push(`/login?returnTo=${encodeURIComponent(item.href)}`);
        }}
        className={cn(
          "relative flex w-full items-center rounded-lg transition-all duration-200",
          "hover:bg-white/5 hover:text-white/80",
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
      </button>
    );

    if (isCollapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{lockedButton}</TooltipTrigger>
          <TooltipContent
            side="right"
            className="bg-neutral-800 text-white border-white/10"
          >
            {item.label}
          </TooltipContent>
        </Tooltip>
      );
    }

    return lockedButton;
  }

  // Regular accessible link
  const linkElement = (
    <Link
      href={item.href}
      className={cn(
        "relative flex items-center rounded-lg transition-all duration-200",
        "hover:bg-white/5 hover:text-white",
        isActive ? "bg-white/10 text-white" : "text-white/60",
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
      <Icon className="h-4 w-4 shrink-0 transition-colors" />
      {!isCollapsed && (
        <>
          <span className="flex-1 whitespace-nowrap">{item.label}</span>
          {item.isNew && (
            <span
              className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
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
            <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/60">
              {item.badge}
            </span>
          )}
        </>
      )}
    </Link>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
        <TooltipContent
          side="right"
          className="bg-neutral-800 text-white border-white/10"
        >
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkElement;
}
