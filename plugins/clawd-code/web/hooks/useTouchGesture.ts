"use client";

import { useRef, useCallback } from "react";

export type SwipeDirection = "left" | "right" | "up" | "down";

export interface TouchGestureOptions {
  /** Minimum distance in px to recognise as a swipe (default 50) */
  threshold?: number;
  /** Minimum speed in px/ms to recognise as a swipe (default 0.2) */
  velocityThreshold?: number;
  onSwipe?: (direction: SwipeDirection, distance: number) => void;
  onSwipeLeft?: (distance: number) => void;
  onSwipeRight?: (distance: number) => void;
  onSwipeUp?: (distance: number) => void;
  onSwipeDown?: (distance: number) => void;
  onLongPress?: () => void;
  /** Long-press delay in ms (default 500) */
  longPressDelay?: number;
}

export interface TouchGestureHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}

export function useTouchGesture(options: TouchGestureOptions = {}): TouchGestureHandlers {
  const {
    threshold = 50,
    velocityThreshold = 0.2,
    onSwipe,
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    onLongPress,
    longPressDelay = 500,
  } = options;

  const startRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMoved = useRef(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      startRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
      hasMoved.current = false;

      if (onLongPress) {
        longPressTimer.current = setTimeout(() => {
          if (!hasMoved.current) onLongPress();
        }, longPressDelay);
      }
    },
    [onLongPress, longPressDelay]
  );

  const onTouchMove = useCallback((_e: React.TouchEvent) => {
    hasMoved.current = true;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }

      if (!startRef.current) return;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - startRef.current.x;
      const dy = touch.clientY - startRef.current.y;
      const dt = Date.now() - startRef.current.time;
      startRef.current = null;

      if (dt === 0) return;
      const velocity = Math.sqrt(dx * dx + dy * dy) / dt;

      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
      if (velocity < velocityThreshold) return;

      const isHorizontal = Math.abs(dx) >= Math.abs(dy);
      let direction: SwipeDirection;
      let distance: number;

      if (isHorizontal) {
        direction = dx > 0 ? "right" : "left";
        distance = Math.abs(dx);
      } else {
        direction = dy > 0 ? "down" : "up";
        distance = Math.abs(dy);
      }

      onSwipe?.(direction, distance);
      if (direction === "left") onSwipeLeft?.(distance);
      if (direction === "right") onSwipeRight?.(distance);
      if (direction === "up") onSwipeUp?.(distance);
      if (direction === "down") onSwipeDown?.(distance);
    },
    [threshold, velocityThreshold, onSwipe, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown]
  );

  return { onTouchStart, onTouchMove, onTouchEnd };
}
