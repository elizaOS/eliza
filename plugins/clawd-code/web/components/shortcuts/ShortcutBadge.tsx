"use client";

import { formatKeyCombo } from "@/lib/keyParser";
import { cn } from "@/lib/utils";

interface ShortcutBadgeProps {
  keys: string[];
  className?: string;
}

/**
 * Renders the first key combo for a command as a series of <kbd> elements.
 * E.g. "mod+shift+k" → [⌘] [⇧] [K]
 */
export function ShortcutBadge({ keys, className }: ShortcutBadgeProps) {
  if (keys.length === 0) return null;
  const parts = formatKeyCombo(keys[0]);

  return (
    <span className={cn("flex items-center gap-0.5", className)}>
      {parts.map((part, i) => (
        <kbd
          key={i}
          className={cn(
            "inline-flex items-center justify-center",
            "min-w-[1.375rem] h-5 px-1 rounded text-[10px] font-medium",
            "bg-surface-800 border border-surface-600 text-surface-400",
            "font-mono leading-none"
          )}
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}
