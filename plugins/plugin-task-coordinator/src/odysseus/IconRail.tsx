// 48px icon rail. Holds the sidebar toggle (hamburger), the chat glyph, the
// theme picker, and settings; the remaining feature glyphs (memory, calendar,
// gallery, …) fill in as their phases land. Always visible — it's what the
// sidebar collapses down to.

import {
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
  onOpenCompare,
  onOpenResearch,
  onOpenDocs,
  onOpenCalendar,
  onOpenEmail,
  onOpenGallery,
  onOpenCookbook,
  onOpenModels,
  onOpenTasks,
}: {
  onToggleSidebar: () => void;
  onOpenTheme: () => void;
  onOpenMemory: () => void;
  onOpenSkills: () => void;
  onOpenNotes: () => void;
  onOpenSettings: () => void;
  onOpenCompare: () => void;
  onOpenResearch: () => void;
  onOpenDocs: () => void;
  onOpenCalendar: () => void;
  onOpenEmail: () => void;
  onOpenGallery: () => void;
  onOpenCookbook: () => void;
  onOpenModels: () => void;
  onOpenTasks: () => void;
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
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenDocs}
        title="Documents"
        aria-label="Documents"
      >
        <FileText size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenCompare}
        title="Compare"
        aria-label="Compare"
      >
        <Columns2 size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenResearch}
        title="Deep Research"
        aria-label="Deep Research"
      >
        <FlaskConical size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenCalendar}
        title="Calendar"
        aria-label="Calendar"
      >
        <CalendarDays size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenTasks}
        title="Tasks"
        aria-label="Tasks"
      >
        <ListChecks size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenModels}
        title="Models"
        aria-label="Models"
      >
        <Boxes size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenEmail}
        title="Email"
        aria-label="Email"
      >
        <Mail size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenGallery}
        title="Gallery"
        aria-label="Gallery"
      >
        <Images size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenCookbook}
        title="Cookbook"
        aria-label="Cookbook"
      >
        <BookOpen size={18} />
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
