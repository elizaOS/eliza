"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useTouchGesture } from "@/hooks/useTouchGesture";

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * iOS-style bottom sheet.
 * - Slides up from the bottom of the screen
 * - Swipe down on the drag handle or sheet body to close
 * - Tap backdrop to close
 * - Locks body scroll while open
 */
export function BottomSheet({ isOpen, onClose, title, children, className }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  const swipeHandlers = useTouchGesture({ onSwipeDown: onClose });

  // Lock body scroll while open
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

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60",
          "transition-opacity duration-300",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? "Options"}
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50",
          "bg-surface-900 border-t border-surface-800 rounded-t-2xl",
          "max-h-[85dvh] flex flex-col",
          "transition-transform duration-300 ease-out",
          isOpen ? "translate-y-0" : "translate-y-full",
          className
        )}
        {...swipeHandlers}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0 cursor-grab active:cursor-grabbing">
          <div className="w-10 h-1 bg-surface-600 rounded-full" />
        </div>

        {/* Optional title */}
        {title && (
          <div className="px-4 pb-2 flex-shrink-0">
            <h2 className="text-sm font-semibold text-surface-100 text-center">{title}</h2>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>

        {/* iOS safe area bottom padding */}
        <div className="pb-safe flex-shrink-0" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />
      </div>
    </>
  );
}
