"use client";

import { Lock } from "lucide-react";
import type { CSSProperties } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import type {
  DashboardSidebarItem,
  DashboardSidebarLinkRenderer,
} from "./dashboard-sidebar-types";

export interface DashboardSidebarNavigationItemProps {
  item: DashboardSidebarItem;
  activePath: string;
  authenticated: boolean;
  isCollapsed?: boolean;
  renderLink?: DashboardSidebarLinkRenderer;
  getLoginHref?: (item: DashboardSidebarItem) => string;
  isItemActive?: (item: DashboardSidebarItem, activePath: string) => boolean;
}

const itemTextStyle = {
  fontFamily: "var(--font-roboto-mono)",
  fontWeight: 400,
  fontSize: "14px",
  lineHeight: "18px",
  letterSpacing: "-0.003em",
} as const satisfies CSSProperties;

function defaultIsItemActive(item: DashboardSidebarItem, activePath: string) {
  if (item.href === "/dashboard" || item.href === "/dashboard/admin") {
    return activePath === item.href;
  }

  return (
    activePath === item.href ||
    (activePath.startsWith(`${item.href}/`) &&
      !activePath.startsWith(`${item.href}/create`))
  );
}

function defaultRenderLink({
  href,
  className,
  style,
  children,
}: Parameters<DashboardSidebarLinkRenderer>[0]) {
  return (
    <a href={href} className={className} style={style}>
      {children}
    </a>
  );
}

export function DashboardSidebarNavigationItem({
  item,
  activePath,
  authenticated,
  isCollapsed = false,
  renderLink = defaultRenderLink,
  getLoginHref = (sidebarItem) =>
    `/login?returnTo=${encodeURIComponent(sidebarItem.href)}`,
  isItemActive = defaultIsItemActive,
}: DashboardSidebarNavigationItemProps) {
  const isActive = isItemActive(item, activePath);
  const Icon = item.icon;

  if (item.comingSoon) {
    if (isCollapsed) return null;

    return (
      <div
        className={cn(
          "relative flex items-center gap-3 border-l-2 border-l-transparent px-3 py-2.5",
          "cursor-default select-none text-white/40 opacity-60",
        )}
        style={itemTextStyle}
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

  const isLocked = !authenticated && item.freeAllowed === false;

  if (isLocked) {
    const lockedButton = renderLink({
      href: getLoginHref(item),
      className: cn(
        "relative flex w-full items-center border-l-2 border-l-transparent transition-colors duration-150",
        "hover:bg-white/[0.06] hover:text-white",
        "cursor-pointer text-white/50",
        isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
      ),
      style: itemTextStyle,
      children: (
        <>
          <Icon className="h-4 w-4 shrink-0 opacity-50" />
          {!isCollapsed && (
            <>
              <span className="flex-1 whitespace-nowrap">{item.label}</span>
              <Lock className="h-3 w-3 shrink-0 text-white/54" />
            </>
          )}
        </>
      ),
    });

    if (isCollapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{lockedButton}</TooltipTrigger>
          <TooltipContent
            side="right"
            className="border-white/10 bg-neutral-800 text-white"
          >
            {item.label}
          </TooltipContent>
        </Tooltip>
      );
    }

    return lockedButton;
  }

  const linkClasses = cn(
    "relative flex items-center border-l-2 transition-colors duration-150",
    "hover:bg-white/[0.06] hover:text-white",
    isActive
      ? "border-l-[#FF5800] bg-white/[0.06] text-white"
      : "border-l-transparent text-white/70",
    isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
  );

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
                backgroundColor: "rgba(255, 138, 36, 0.2)",
                color: "#fff7ee",
                border: "1px solid rgba(255, 255, 255, 0.28)",
              }}
            >
              NEW
            </span>
          )}
          {item.badge && !item.isNew && (
            <span className="rounded-sm bg-white/18 px-2 py-0.5 text-[10px] font-semibold text-white/70">
              {item.badge}
            </span>
          )}
        </>
      )}
    </>
  );

  const linkElement = renderLink({
    href: item.href,
    className: linkClasses,
    style: itemTextStyle,
    children: linkContents,
  });

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
        <TooltipContent
          side="right"
          className="border-white/10 bg-neutral-800 text-white"
        >
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkElement;
}
