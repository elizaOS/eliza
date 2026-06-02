// 48px icon rail. Holds the sidebar toggle (hamburger), the New-chat action
// (odysseus rail-new-session), the theme picker, settings, and the feature
// glyphs (memory, calendar, gallery, …). Always visible — it's what the
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
  MessagesSquare,
  Mic,
  Palette,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  StickyNote,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

export function IconRail({
  onToggleSidebar,
  onNewChat,
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
  onOpenEditor,
  onOpenGroup,
  onOpenAdmin,
  onOpenVoice,
  onOpenPresets,
}: {
  onToggleSidebar: () => void;
  onNewChat: () => void;
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
  onOpenEditor: () => void;
  onOpenGroup: () => void;
  onOpenAdmin: () => void;
  onOpenVoice: () => void;
  onOpenPresets: () => void;
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
      <button
        type="button"
        className="od-rail-btn od-rail-new-chat"
        onClick={onNewChat}
        title="New chat"
        aria-label="New chat"
      >
        <Plus size={18} />
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
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenGroup}
        title="Group Chat"
        aria-label="Group Chat"
      >
        <MessagesSquare size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenEditor}
        title="Image Editor"
        aria-label="Image Editor"
      >
        <Pencil size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenAdmin}
        title="Admin"
        aria-label="Admin"
      >
        <ShieldAlert size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenVoice}
        title="Voice"
        aria-label="Voice"
      >
        <Mic size={18} />
      </button>
      <button
        type="button"
        className="od-rail-btn"
        onClick={onOpenPresets}
        title="Presets"
        aria-label="Presets"
      >
        <SlidersHorizontal size={18} />
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
