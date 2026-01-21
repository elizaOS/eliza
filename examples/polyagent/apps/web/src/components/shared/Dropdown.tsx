"use client";

import { cn } from "@polyagent/shared";
import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Dropdown menu component with configurable placement and width.
 *
 * Provides a dropdown menu that opens on trigger click and closes on outside
 * click. Supports multiple placement options and width variants. Uses Framer
 * Motion for smooth animations.
 *
 * @param props - Dropdown component props
 * @returns Dropdown element
 *
 * @example
 * ```tsx
 * <Dropdown trigger={<button>Menu</button>} placement="bottom-right">
 *   <DropdownItem onClick={handleAction}>Action</DropdownItem>
 * </Dropdown>
 * ```
 */
interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  placement?: "top-right" | "bottom-right" | "top-left" | "bottom-left";
  width?: "default" | "sidebar";
}

export function Dropdown({
  trigger,
  children,
  className,
  placement = "bottom-right",
  width = "default",
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Determine position classes based on placement
  const positionClasses = {
    "top-right": "bottom-full right-0 mb-2",
    "bottom-right": "top-full right-0 mt-2",
    "top-left": "bottom-full left-0 mb-2",
    "bottom-left": "top-full left-0 mt-2",
  }[placement];

  // Determine animation based on placement
  const animationProps = placement.startsWith("top")
    ? {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 10 },
      }
    : {
        initial: { opacity: 0, y: -10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
      };

  // Determine width based on width prop
  const widthClass = width === "sidebar" ? "w-64 lg:w-64 xl:w-72" : "w-60";

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      <div onClick={() => setIsOpen(!isOpen)} className="cursor-pointer">
        {trigger}
      </div>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            {...animationProps}
            transition={{ duration: 0.2 }}
            className={cn(
              "absolute z-50 rounded-lg border border-border bg-popover shadow-lg",
              widthClass,
              positionClasses,
            )}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Dropdown menu item component.
 *
 * Individual clickable item within a dropdown menu. Provides hover states
 * and click handling.
 *
 * @param props - DropdownItem component props
 * @returns Dropdown item element
 *
 * @example
 * ```tsx
 * <DropdownItem onClick={() => console.log('clicked')}>
 *   Menu Item
 * </DropdownItem>
 * ```
 */
interface DropdownItemProps {
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

export function DropdownItem({
  onClick,
  className,
  children,
}: DropdownItemProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "cursor-pointer px-4 py-3 text-popover-foreground text-sm transition-colors hover:bg-sidebar-accent",
        className,
      )}
    >
      {children}
    </div>
  );
}
