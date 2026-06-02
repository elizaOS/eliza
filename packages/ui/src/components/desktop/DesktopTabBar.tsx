/**
 * DesktopTabBar — horizontal native tab bar for the Electrobun desktop shell.
 *
 * Renders pinned and dynamically-opened view tabs above the main content area.
 * Only visible when running inside the Electrobun runtime; returns null on web
 * and mobile.
 *
 * Each tab can be closed (unpinned ephemeral) or pinned (persisted across
 * restarts). A "+" button opens the ViewManagerPage so users can pin more views.
 */

import { Plus, X } from "lucide-react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import type { DesktopTab } from "../../hooks/useDesktopTabs";
import { navActiveClassHorizontal } from "../composites/sidebar/nav-active";
import { ViewIcon } from "../views/ViewIcon";

export interface DesktopTabBarProps {
  tabs: DesktopTab[];
  activeViewId: string | null;
  onTabClick: (viewId: string) => void;
  onTabClose: (viewId: string) => void;
  onOpenViewManager: () => void;
}

interface TabButtonProps {
  tab: DesktopTab;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}

function TabButton({
  tab,
  active,
  onClick,
  onClose,
}: TabButtonProps): React.JSX.Element {
  return (
    <div
      className={`group relative flex min-w-0 max-w-[160px] shrink-0 items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? `border-border/40 ${navActiveClassHorizontal}`
          : "border-border/40 bg-card/60 text-muted hover:border-border hover:text-txt"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-accent/10 text-accent">
        <ViewIcon icon={tab.icon} label={tab.label} className="h-3 w-3" />
      </span>
      <button
        type="button"
        title={tab.label}
        onClick={onClick}
        className="min-w-0 truncate leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {tab.label}
      </button>
      <button
        type="button"
        title={`Close ${tab.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-border/40 group-hover:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Close ${tab.label}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

/**
 * DesktopTabBar renders only in the Electrobun runtime. On web and mobile
 * `isElectrobunRuntime()` returns false and this component returns null.
 */
export function DesktopTabBar({
  tabs,
  activeViewId,
  onTabClick,
  onTabClose,
  onOpenViewManager,
}: DesktopTabBarProps): React.JSX.Element | null {
  if (!isElectrobunRuntime()) return null;
  if (tabs.length === 0) return null;

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-bg/80 px-2 py-1.5 backdrop-blur"
      role="tablist"
      aria-label="Desktop view tabs"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.viewId}
          tab={tab}
          active={activeViewId === tab.viewId}
          onClick={() => onTabClick(tab.viewId)}
          onClose={() => onTabClose(tab.viewId)}
        />
      ))}
      <button
        type="button"
        title="Open View Manager"
        onClick={onOpenViewManager}
        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-border/40 bg-card/40 text-muted transition-colors hover:border-border hover:text-txt focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Open View Manager to pin new tabs"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}
