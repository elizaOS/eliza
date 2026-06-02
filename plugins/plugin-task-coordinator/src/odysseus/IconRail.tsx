// 48px icon rail. Holds the sidebar toggle (hamburger), the chat glyph, the
// theme picker, and settings; the remaining feature glyphs (memory, calendar,
// gallery, …) fill in as their phases land. Always visible — it's what the
// sidebar collapses down to.

import {
  Brain,
  MessageSquare,
  Palette,
  PanelLeft,
  Settings,
  StickyNote,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

export function IconRail({
  onToggleSidebar,
  onOpenTheme,
  onOpenMemory,
  onOpenSkills,
  onOpenNotes,
  onOpenSettings,
}: {
  onToggleSidebar: () => void;
  onOpenTheme: () => void;
  onOpenMemory: () => void;
  onOpenSkills: () => void;
  onOpenNotes: () => void;
  onOpenSettings: () => void;
}): ReactNode {
  return (
    <div className="od-icon-rail">
      <button
        type="button"
        className="od-rail-btn"
        onClick={onToggleSidebar}
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
      >
        <PanelLeft size={18} />
      </button>
      <button type="button" className="od-rail-btn active" title="Chat">
        <MessageSquare size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenMemory}
        title="Memory"
        aria-label="Memory"
      >
        <Brain size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenSkills}
        title="Skills"
        aria-label="Skills"
      >
        <Zap size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenNotes}
        title="Notes"
        aria-label="Notes"
      >
        <StickyNote size={18} />
      </button>
      <div className="od-rail-spacer" />
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenTheme}
        title="Theme"
        aria-label="Theme"
      >
        <Palette size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={18} />
      </button>
    </div>
  );
}
