"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface MenuPosition {
  top: number;
  left: number;
  openUpward: boolean;
  windowHeight: number;
}

interface UseMenuPositionOptions {
  menuHeight: number;
  menuWidth: number;
  padding?: number;
}

/**
 * Custom hook to manage dropdown menu positioning.
 * Handles fixed positioning with portal, follows button on scroll/resize,
 * and automatically opens upward if not enough space below.
 *
 * @param isOpen - Whether the menu is currently open
 * @param options - Menu dimensions and padding
 * @returns buttonRef, menuPosition, and updatePosition function
 */
export function useMenuPosition(
  isOpen: boolean,
  options: UseMenuPositionOptions,
) {
  const { menuHeight, menuWidth, padding = 8 } = options;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({
    top: 0,
    left: 0,
    openUpward: false,
    windowHeight: 0,
  });

  // Track mounted state for SSR compatibility
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate menu position
  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();

      // Check if there's enough space below
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUpward = spaceBelow < menuHeight + padding;

      // Calculate left position (align right edge of menu with right edge of button)
      let left = rect.right - menuWidth;
      // Ensure menu doesn't go off-screen left
      if (left < padding) left = padding;

      setMenuPosition({
        top: openUpward ? rect.top - padding : rect.bottom + padding,
        left,
        openUpward,
        windowHeight: window.innerHeight,
      });
    }
  }, [menuHeight, menuWidth, padding]);

  // Update menu position on scroll/resize to follow the button
  useEffect(() => {
    if (!isOpen) return;

    // Listen on window and any scrollable parent (capture phase)
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, updatePosition]);

  return {
    buttonRef,
    menuPosition,
    updatePosition,
    mounted,
  };
}
