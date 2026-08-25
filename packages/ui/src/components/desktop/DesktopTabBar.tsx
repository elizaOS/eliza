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
      <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-accent/10 text-accent">
        <ViewIcon icon={tab.icon} label={tab.label} className="size-3" />
      </span>
      <Button
        variant="transparent"
        size="content"
        align="start"
        aria-pressed={active}
        title={tab.label}
        onClick={onClick}
        className="min-w-0 truncate"
      >
        {tab.label}
      </Button>
      <Button
        variant="ghostMuted"
        size="disclosure"
        title={`Close ${tab.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="ml-0.5 shrink-0"
        aria-label={`Close ${tab.label}`}
      >
        <X className="size-2.5" />
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
      role="toolbar"
      aria-label="Desktop view tabs"
      className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-bg/80 px-2 py-1.5"
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
        variant="outlineMuted"
        size="disclosure"
        title="Open Launcher"
        onClick={onOpenViewManager}
        className="ml-1 shrink-0"
        aria-label="Open Launcher"
      >
        <Plus className="size-3" />
      </Button>
    </div>
  );
}
