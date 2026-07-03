/**
 * DesktopTabBar — horizontal native tab bar for the Electrobun desktop shell.
 *
 * Renders pinned and dynamically-opened view tabs above the main content area.
 * Only visible when running inside the Electrobun runtime; returns null on web
 * and mobile.
 *
 * Each tab can be closed (unpinned ephemeral) or pinned (persisted across
 * restarts). A "+" button opens Launcher so users can launch more views.
 */

import { Plus, X } from "lucide-react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import type { DesktopTab } from "../../hooks/useDesktopTabs";
import { navActiveClassHorizontal } from "../composites/sidebar/nav-active";
import { Button } from "../ui/button";
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
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-accent/10 text-accent">
        <ViewIcon icon={tab.icon} label={tab.label} className="h-3 w-3" />
      </span>
      <Button
        variant="ghost"
        title={tab.label}
        onClick={onClick}
        className="h-auto min-w-0 truncate rounded-none bg-transparent p-0 text-xs font-medium leading-none hover:bg-transparent"
      >
        {tab.label}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Close ${tab.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 h-5 w-5 shrink-0 rounded-sm p-0 opacity-0 transition-opacity hover:bg-border/40 group-hover:opacity-100"
        aria-label={`Close ${tab.label}`}
      >
        <X className="h-2.5 w-2.5" />
      </Button>
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
      className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-bg/80 px-2 py-1.5"
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
      <Button
        variant="secondary"
        size="icon-sm"
        title="Open Launcher"
        onClick={onOpenViewManager}
        className="ml-1 h-6 w-6 shrink-0 rounded-sm border border-border/40 bg-card/40 p-0 text-muted transition-colors hover:border-border hover:text-txt"
        aria-label="Open Launcher"
      >
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );
}
