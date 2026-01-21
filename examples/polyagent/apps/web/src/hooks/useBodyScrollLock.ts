"use client";

import { useEffect } from "react";

/**
 * Counter for the number of components currently locking body scroll.
 * When this is > 0, body scroll is disabled.
 */
let lockCount = 0;

/**
 * Stores the original overflow style to restore when unlocking.
 */
let originalOverflow: string | null = null;

/**
 * Locks body scroll by setting overflow to hidden.
 * Uses a counter to handle multiple simultaneous locks.
 */
function lock(): void {
  if (lockCount === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount++;
}

/**
 * Unlocks body scroll by decrementing the counter.
 * Only restores overflow when all locks are released.
 */
function unlock(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = originalOverflow ?? "";
    originalOverflow = null;
  }
}

/**
 * Hook to lock body scroll when a modal or overlay is open.
 *
 * Uses a reference counter to properly handle multiple overlapping modals.
 * When all modals are closed, the original overflow style is restored.
 *
 * @param isLocked - Whether scroll should be locked
 *
 * @example
 * ```tsx
 * function Modal({ isOpen }) {
 *   useBodyScrollLock(isOpen);
 *   if (!isOpen) return null;
 *   return <div>Modal content</div>;
 * }
 * ```
 */
export function useBodyScrollLock(isLocked: boolean): void {
  useEffect(() => {
    if (!isLocked) return;

    lock();

    return () => {
      unlock();
    };
  }, [isLocked]);
}
