"use client";

import {
  MessageSquarePlus,
  Trash2,
  Settings,
  Sun,
  Search,
  HelpCircle,
  PanelLeftClose,
  ChevronRight,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ShortcutBadge } from "@/components/shortcuts/ShortcutBadge";
import type { Command } from "@/lib/shortcuts";

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquarePlus,
  Trash2,
  Settings,
  Sun,
  Search,
  HelpCircle,
  PanelLeftClose,
  ChevronRight,
  Zap,
};

interface CommandPaletteItemProps {
  command: Command;
  isActive: boolean;
  onSelect: () => void;
  onHighlight: () => void;
}

export function CommandPaletteItem({
  command,
  isActive,
  onSelect,
  onHighlight,
}: CommandPaletteItemProps) {
  const Icon = command.icon ? (ICON_MAP[command.icon] ?? ChevronRight) : ChevronRight;

  return (
    <div
      role="option"
      aria-selected={isActive}
      onClick={onSelect}
      onMouseEnter={onHighlight}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none",
        "transition-colors",
        isActive ? "bg-brand-600/20 text-surface-100" : "text-surface-300 hover:bg-surface-800"
      )}
    >
      <span
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center",
          isActive ? "bg-brand-600/30 text-brand-400" : "bg-surface-800 text-surface-500"
        )}
      >
        <Icon className="w-3.5 h-3.5" />
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{command.label}</p>
        {command.description && (
          <p className="text-xs text-surface-500 truncate">{command.description}</p>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded border font-medium",
            isActive
              ? "border-brand-600/40 text-brand-400 bg-brand-600/10"
              : "border-surface-700 text-surface-600 bg-surface-800"
          )}
        >
          {command.category}
        </span>
        {command.keys.length > 0 && <ShortcutBadge keys={command.keys} />}
      </div>
    </div>
  );
}
