"use client";

import { Menu, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileHeaderProps {
  title?: string;
  onMenuOpen: () => void;
  onBack?: () => void;
  right?: React.ReactNode;
  className?: string;
}

/**
 * Compact top bar for mobile: hamburger (or back) on the left, title in centre, optional actions on the right.
 * Tap targets are at least 44×44 px per WCAG / Apple HIG guidelines.
 */
export function MobileHeader({
  title = "Chat",
  onMenuOpen,
  onBack,
  right,
  className,
}: MobileHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-center gap-2 px-2 border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm",
        "h-[52px] flex-shrink-0",
        className
      )}
    >
      {/* Left action — back or hamburger */}
      {onBack ? (
        <button
          onClick={onBack}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-surface-400 hover:text-surface-100 active:bg-surface-800 transition-colors"
          aria-label="Go back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      ) : (
        <button
          onClick={onMenuOpen}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-surface-400 hover:text-surface-100 active:bg-surface-800 transition-colors"
          aria-label="Open sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* Title */}
      <h1 className="flex-1 text-sm font-medium text-surface-100 truncate">{title}</h1>

      {/* Right actions */}
      {right && <div className="flex items-center">{right}</div>}
    </header>
  );
}
