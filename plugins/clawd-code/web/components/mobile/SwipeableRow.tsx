"use client";

import { useRef, useState, useCallback } from "react";
import { cn } from "@/lib/utils";

interface SwipeAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  className?: string;
}

interface SwipeableRowProps {
  children: React.ReactNode;
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  className?: string;
  /** Width of each action button in px (default 72) */
  actionWidth?: number;
}

/**
 * Row that reveals swipe actions when the user drags left (right-actions)
 * or right (left-actions).  Used in the sidebar conversation list for
 * one-swipe delete.
 */
export function SwipeableRow({
  children,
  leftActions = [],
  rightActions = [],
  className,
  actionWidth = 72,
}: SwipeableRowProps) {
  const [translateX, setTranslateX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef<number | null>(null);
  const currentXRef = useRef(0);

  const maxLeft = leftActions.length * actionWidth;
  const maxRight = rightActions.length * actionWidth;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startXRef.current === null) return;
      const dx = e.touches[0].clientX - startXRef.current + currentXRef.current;
      const clamped = Math.max(-maxRight, Math.min(maxLeft, dx));
      setTranslateX(clamped);
    },
    [maxLeft, maxRight]
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    startXRef.current = null;

    // Snap: if dragged > half an action width, show actions; otherwise reset
    if (translateX < -(actionWidth / 2) && maxRight > 0) {
      const snapped = -maxRight;
      setTranslateX(snapped);
      currentXRef.current = snapped;
    } else if (translateX > actionWidth / 2 && maxLeft > 0) {
      const snapped = maxLeft;
      setTranslateX(snapped);
      currentXRef.current = snapped;
    } else {
      setTranslateX(0);
      currentXRef.current = 0;
    }
  }, [translateX, actionWidth, maxLeft, maxRight]);

  const resetPosition = useCallback(() => {
    setTranslateX(0);
    currentXRef.current = 0;
  }, []);

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* Left action buttons (revealed on swipe-right) */}
      {leftActions.length > 0 && (
        <div
          className="absolute inset-y-0 left-0 flex"
          style={{ width: maxLeft }}
        >
          {leftActions.map((action) => (
            <button
              key={action.label}
              onClick={() => {
                action.onClick();
                resetPosition();
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-xs font-medium min-w-[44px]",
                "bg-brand-600 text-white",
                action.className
              )}
              style={{ width: actionWidth }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Right action buttons (revealed on swipe-left) */}
      {rightActions.length > 0 && (
        <div
          className="absolute inset-y-0 right-0 flex"
          style={{ width: maxRight }}
        >
          {rightActions.map((action) => (
            <button
              key={action.label}
              onClick={() => {
                action.onClick();
                resetPosition();
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-xs font-medium min-w-[44px]",
                "bg-red-600 text-white",
                action.className
              )}
              style={{ width: actionWidth }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Content row */}
      <div
        className={cn(
          "relative z-10 bg-surface-900",
          !isDragging && "transition-transform duration-200"
        )}
        style={{ transform: `translateX(${translateX}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
