// MinimizedDock — odysseus's bottom dock of chips, one per minimized window
// (static/js/modalManager.js _renderDock / _LABELS, static/style.css
// #minimized-dock + .minimized-dock-chip rules).
//
// Each minimized tool view collapses to a rounded pill chip carrying its icon
// + label + an × close affordance. Clicking the chip body restores the window;
// clicking the × closes it. The shell owns the list of minimized items and the
// minimize/restore/close transitions — this component is purely presentational.
//
// Faithful to the odysseus source: the spring-in `dock-chip-in` keyframe, the
// pill geometry (6px 8px 6px 10px padding, 999px radius), the accent-tinted
// hover, the 0.7 icon opacity, and the 0.4→1 × hover ramp are all carried over.
// The drag/FLIP/mobile-free-float machinery from modalManager.js is the shell's
// concern and is intentionally out of scope for this presentational chip row.
//
// Positioned bottom-left (the shell's chosen anchor) rather than the odysseus
// bottom-center default; the chip styling is otherwise pixel-identical.

import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface MinimizedDockItem {
  /** Stable id of the window this chip restores/closes (e.g. "memory-modal"). */
  id: string;
  /** Human label shown next to the icon (e.g. "Brain"). */
  label: string;
  /** Pre-rendered lucide glyph for the window, matching its rail/title icon. */
  icon: ReactNode;
}

export function MinimizedDock({
  items,
  onRestore,
  onClose,
}: {
  items: MinimizedDockItem[];
  onRestore: (id: string) => void;
  onClose: (id: string) => void;
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="od-min-dock" data-testid="minimized-dock">
      {items.map((item) => (
        // odysseus renders one <button> chip with a nested ×; nesting a button
        // inside a button is invalid HTML, so the chip is a flex wrapper that
        // holds two real buttons — the restore body and the × — which keeps
        // the same pill geometry while staying valid and keyboard-accessible.
        <span key={item.id} className="od-min-chip" data-modal-id={item.id}>
          <button
            type="button"
            className="od-min-restore"
            title={`Restore ${item.label}`}
            onClick={() => onRestore(item.id)}
          >
            <span className="od-min-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="od-min-label">{item.label}</span>
          </button>
          <button
            type="button"
            className="od-min-x"
            title={`Close ${item.label}`}
            aria-label={`Close ${item.label}`}
            onClick={() => onClose(item.id)}
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
