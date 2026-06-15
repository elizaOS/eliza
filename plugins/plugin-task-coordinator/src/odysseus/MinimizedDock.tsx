// MinimizedDock — odysseus's bottom dock of chips, one per minimized tool
// window (static/js/modalManager.js `_renderDock` + the `#minimized-dock` /
// `.minimized-dock-chip` rules in static/style.css). Pure presentational: it
// reads the minimized-window list from the WindowManager and renders a chip
// (icon + label + ×) for each. Clicking a chip restores the window
// (setMinimized(id, false)); the × closes it (meta.onClose + un-minimize).
// Theme-var styled,
// no .css import — the dock CSS is appended to ODYSSEUS_CSS (see odysseus-theme).
//
// The drag/reorder/chain physics from the odysseus source are intentionally
// out of scope for this core: the chip is a plain restore/close control. Layout
// stays faithful (bottom-anchored pill row), but the elaborate touch gestures
// are a later enhancement, not part of the minimize-to-dock core.

import {
  BookOpen,
  Boxes,
  Brain,
  CalendarDays,
  Columns2,
  FileText,
  FlaskConical,
  Images,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Mic,
  Palette,
  Pencil,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  StickyNote,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useWindowManager } from "./WindowManager.context";

// Explicit name→component map. lucide-react@1 ships no clean dynamic `icons`
// record we can type against without an `any`, so the dock keeps a small,
// strictly-typed registry of the icons the odysseus tool windows actually use.
// A view passes the matching name string as its `meta.icon`; an unrecognised
// name falls back to a neutral window glyph rather than crashing.
const ICONS: Readonly<Record<string, LucideIcon>> = {
  BookOpen,
  Boxes,
  Brain,
  CalendarDays,
  Columns2,
  FileText,
  FlaskConical,
  Images,
  ListChecks,
  Mail,
  MessagesSquare,
  Mic,
  Palette,
  Pencil,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  StickyNote,
  Zap,
};

function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? LayoutGrid;
}

export function MinimizedDock(): ReactNode {
  const manager = useWindowManager();
  // No provider, or nothing minimized → render nothing (the dock element only
  // exists while it has chips, matching modalManager.js's empty-dock hide).
  if (!manager || manager.minimizedWindows.length === 0) return null;

  return (
    <div
      className="od-minimized-dock"
      role="toolbar"
      aria-label="Minimized windows"
    >
      {manager.minimizedWindows.map((win) => {
        const Icon = iconFor(win.icon);
        return (
          <div key={win.id} className="od-dock-chip">
            <button
              type="button"
              className="od-dock-chip-restore"
              onClick={() => manager.setMinimized(win.id, false)}
              title={`Restore ${win.label}`}
              aria-label={`Restore ${win.label}`}
            >
              <Icon
                className="od-dock-chip-icon"
                size={14}
                aria-hidden="true"
              />
              <span className="od-dock-chip-label">{win.label}</span>
            </button>
            <button
              type="button"
              className="od-dock-chip-close"
              onClick={() => {
                // Close the underlying view, then clear its minimized flag so
                // the chip disappears. (We don't unregister: the view stays
                // mounted in the shell, so its hook keeps owning the entry —
                // unregistering here would orphan it until a remount.)
                win.onClose?.();
                manager.setMinimized(win.id, false);
              }}
              title={`Close ${win.label}`}
              aria-label={`Close ${win.label}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
