"use client";

import { useEffect } from "react";
import { X, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTouchGesture } from "@/hooks/useTouchGesture";

interface MobileFileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  fileName?: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Full-screen file viewer overlay for mobile.
 * - Slides up from the bottom on open
 * - Swipe down to close
 * - Back/close button in header
 * - Content area is scrollable with pinch-to-zoom enabled on images
 */
export function MobileFileViewer({
  isOpen,
  onClose,
  fileName,
  children,
  className,
}: MobileFileViewerProps) {
  const swipeHandlers = useTouchGesture({ onSwipeDown: onClose, threshold: 80 });

  // Lock body scroll and close on Escape
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-surface-950 flex flex-col",
        "transition-transform duration-300 ease-out",
        isOpen ? "translate-y-0" : "translate-y-full",
        className
      )}
      role="dialog"
      aria-modal="true"
      aria-label={fileName ?? "File viewer"}
    >
      {/* Header — swipe-down handle zone */}
      <div
        className="flex items-center gap-2 px-2 border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm h-[52px] flex-shrink-0"
        {...swipeHandlers}
      >
        {/* Drag handle */}
        <div className="absolute left-1/2 -translate-x-1/2 top-2 w-10 h-1 bg-surface-600 rounded-full" />

        <button
          onClick={onClose}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-surface-400 hover:text-surface-100 active:bg-surface-800 transition-colors"
          aria-label="Close file viewer"
        >
          <X className="w-5 h-5" />
        </button>

        <span className="flex-1 text-sm font-medium text-surface-100 truncate">{fileName}</span>

        <button
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md text-surface-400 hover:text-surface-100 active:bg-surface-800 transition-colors"
          aria-label="Download file"
        >
          <Download className="w-5 h-5" />
        </button>
      </div>

      {/* File content — pinch-to-zoom enabled via touch-action */}
      <div
        className="flex-1 overflow-auto overscroll-contain"
        style={{ touchAction: "pan-x pan-y pinch-zoom" }}
      >
        {children ?? (
          <div className="flex items-center justify-center h-full text-surface-500 text-sm">
            No file selected
          </div>
        )}
      </div>

      {/* iOS safe area inset */}
      <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }} className="flex-shrink-0" />
    </div>
  );
}
