/**
 * Renders the tray launcher surface that exposes navigation, notifications,
 * and quick app actions.
 */
import {
  BookOpen,
  Bot,
  GraduationCap,
  HelpCircle,
  Home,
  Image,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  Settings,
} from "lucide-react";
import type * as React from "react";
import { dispatchAppEvent, TRAY_ACTION_EVENT } from "../../events";
import { cn } from "../../lib/utils";
import {
  type DesktopLauncherEntry,
  type DesktopLauncherIconId,
  useDesktopLauncherEntries,
} from "../../state/desktop-tray-launcher";
import { Button } from "../ui/button";

const ICONS: Record<DesktopLauncherIconId, LucideIcon> = {
  tutorial: GraduationCap,
  help: HelpCircle,
  chat: MessageSquare,
  character: Bot,
  documents: BookOpen,
  settings: Settings,
  background: Image,
  home: Home,
  view: LayoutGrid,
};

export interface TrayLauncherProps {
  /** Rows to render; defaults to the registered desktop launcher catalog. */
  entries?: readonly DesktopLauncherEntry[];
  /**
   * Row click handler; defaults to dispatching the row's tray item id through
   * `TRAY_ACTION_EVENT` — the same channel the native tray menu uses, so the
   * popover opens the identical deduped window with no new RPC.
   */
  onSelect?: (itemId: string) => void;
}

/**
 * Compact launcher for the desktop tray popover (#12184). Renders one row per
 * registered `DesktopLauncherEntry` (the `DESKTOP_VIEW_WINDOWS` catalog plus
 * "Open Eliza"), each opening the matching surface via the shared tray-action
 * channel. Neutral rows, orange only as the interactive accent — no chrome.
 * Renders nothing until the desktop host registers rows.
 */
export function TrayLauncher({
  entries,
  onSelect,
}: TrayLauncherProps): React.JSX.Element | null {
  const registered = useDesktopLauncherEntries();
  const rows = entries ?? registered;
  if (rows.length === 0) return null;

  const handleSelect =
    onSelect ??
    ((itemId: string) => {
      dispatchAppEvent(TRAY_ACTION_EVENT, { itemId });
    });

  return (
    <nav
      data-testid="tray-launcher"
      aria-label="Launcher"
      className="flex flex-col gap-0.5"
    >
      {rows.map((row) => {
        const Icon = ICONS[row.icon] ?? LayoutGrid;
        return (
          <Button
            key={row.itemId}
            type="button"
            variant="ghost"
            data-testid={`tray-launcher-row-${row.itemId}`}
            onClick={() => handleSelect(row.itemId)}
            className={cn(
              "h-9 w-full justify-start gap-3 px-2 text-sm font-normal",
            )}
          >
            <Icon aria-hidden="true" className="text-muted-strong" />
            <span className="truncate">{row.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}
