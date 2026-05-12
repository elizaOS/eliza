/**
 * Lock-on button component with active state animation.
 * Provides visual feedback on click with temporary active state.
 *
 * @param props - Lock-on button props
 * @param props.icon - Optional icon to display
 * @param props.size - Button size (sm, md, lg, icon)
 * @param props.variant - Button variant (default, primary, outline, ghost, hud, icon, icon-primary)
 * @param props.cornerSize - Corner bracket size (default, sm, xs, micro) - use smaller for petite buttons
 * @param props.asChild - If true, renders as a child component using Radix Slot
 */

"use client";

import { Slot } from "@radix-ui/react-slot";
import type React from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";

export interface LockOnButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  icon?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "icon";
  variant?: "default" | "primary" | "outline" | "ghost" | "hud" | "icon" | "icon-primary"; // For backwards compatibility
  /** Corner bracket size - use smaller sizes for petite buttons */
  cornerSize?: "default" | "sm" | "xs" | "micro" | "petite";
  asChild?: boolean;
}

// Corner size configurations for scaling the bracket effect
const CORNER_SIZES = {
  default: {
    container: "w-3 h-3", // 12px
    horizontal: "w-3 h-[2px]", // 12px × 2px
    vertical: "w-[2px] h-3", // 2px × 12px
    offset: "-top-[2px] -left-[2px]",
    offsetTR: "-top-[2px] -right-[2px]",
    offsetBL: "-bottom-[2px] -left-[2px]",
    offsetBR: "-bottom-[2px] -right-[2px]",
  },
  sm: {
    container: "w-2 h-2", // 8px
    horizontal: "w-2 h-[2px]", // 8px × 2px
    vertical: "w-[2px] h-2", // 2px × 8px
    offset: "-top-[2px] -left-[2px]",
    offsetTR: "-top-[2px] -right-[2px]",
    offsetBL: "-bottom-[2px] -left-[2px]",
    offsetBR: "-bottom-[2px] -right-[2px]",
  },
  xs: {
    container: "w-1.5 h-1.5", // 6px
    horizontal: "w-1.5 h-[1.5px]", // 6px × 1.5px
    vertical: "w-[1.5px] h-1.5", // 1.5px × 6px
    offset: "-top-[1.5px] -left-[1.5px]",
    offsetTR: "-top-[1.5px] -right-[1.5px]",
    offsetBL: "-bottom-[1.5px] -left-[1.5px]",
    offsetBR: "-bottom-[1.5px] -right-[1.5px]",
  },
  micro: {
    container: "w-1 h-1", // 4px
    horizontal: "w-1 h-[1px]", // 4px × 1px
    vertical: "w-[1px] h-1", // 1px × 4px
    offset: "-top-[1px] -left-[1px]",
    offsetTR: "-top-[1px] -right-[1px]",
    offsetBL: "-bottom-[1px] -left-[1px]",
    offsetBR: "-bottom-[1px] -right-[1px]",
  },
  // Ultra-minimal for very petite buttons - very short brackets with subtle (non-stretch) motion
  petite: {
    container: "w-1 h-1", // 4px - petite but still readable
    horizontal: "w-1 h-[1px]", // 4px × 1px
    vertical: "w-[1px] h-1", // 1px × 4px
    offset: "-top-px -left-px", // 1px outside so it doesn't eat button space
    offsetTR: "-top-px -right-px",
    offsetBL: "-bottom-px -left-px",
    offsetBR: "-bottom-px -right-px",
  },
} as const;

export function LockOnButton({
  children,
  icon,
  onClick,
  disabled = false,
  className,
  size = "md",
  variant = "default",
  cornerSize = "default",
  asChild = false,
  ...props
}: LockOnButtonProps) {
  const [isActive, setIsActive] = useState(false);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setIsActive(true);
    onClick?.(e);
    setTimeout(() => setIsActive(false), 600);
  };

  const sizeClasses = {
    sm: "text-xs px-3 py-2",
    md: "text-sm px-6 py-3",
    lg: "text-base px-8 py-4",
    icon: "p-2 h-10 w-10",
  };

  // Get corner styling based on cornerSize prop
  const corners = CORNER_SIZES[cornerSize];

  const isPetite = cornerSize === "petite";
  // Petite corners should never "stretch" (that’s what causes wrapping/overlap on tiny buttons)
  const shouldAnimate = !isPetite;
  const petiteTransition = isPetite
    ? "transition-[opacity,transform,filter] duration-180 ease-out"
    : undefined;
  const petiteMotionHorizontal = isPetite
    ? isActive
      ? "opacity-100 scale-x-[1.15] drop-shadow-[0_0_6px_rgba(255,88,0,0.45)]"
      : "opacity-85 scale-x-[0.9]"
    : undefined;
  const petiteMotionVertical = isPetite
    ? isActive
      ? "opacity-100 scale-y-[1.15] drop-shadow-[0_0_6px_rgba(255,88,0,0.45)]"
      : "opacity-85 scale-y-[0.9]"
    : undefined;

  const Comp = asChild ? Slot : "button";

  // If asChild, render without corner brackets (Slot requires single child)
  if (asChild) {
    return (
      <Comp
        onClick={handleClick}
        className={cn(
          "relative",
          sizeClasses[size],
          "font-medium text-white bg-[#FF5800]/25",
          "cursor-pointer overflow-visible transition-all duration-300",
          "inline-flex items-center gap-2 outline-none",
          !disabled && "hover:bg-[#FF5800]/40 hover:shadow-[0_0_20px_rgba(255,88,0,0.4)]",
          !disabled && "active:bg-[#FF5800]/60",
          disabled && "opacity-50 cursor-not-allowed",
          className,
        )}
        {...props}
      >
        {children}
      </Comp>
    );
  }

  return (
    <Comp
      onClick={handleClick}
      onMouseEnter={() => setIsActive(true)}
      onMouseLeave={() => setIsActive(false)}
      disabled={disabled}
      className={cn(
        "relative",
        sizeClasses[size],
        "font-medium text-white bg-[#FF5800]/25",
        "cursor-pointer overflow-visible transition-all duration-300",
        "inline-flex items-center gap-2 outline-none",
        !disabled && "hover:bg-[#FF5800]/40 hover:shadow-[0_0_20px_rgba(255,88,0,0.4)]",
        !disabled && "active:bg-[#FF5800]/60",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {/* Top-left corner */}
      <span
        className={cn(
          "absolute flex flex-col pointer-events-none",
          corners.offset,
          corners.container,
        )}
      >
        <span
          className={cn(
            "absolute top-0 left-0 bg-[#FF5800]",
            corners.horizontal,
            shouldAnimate
              ? isActive
                ? "animate-[expandHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionHorizontal,
          )}
          style={{ transformOrigin: "left center" }}
        />
        <span
          className={cn(
            "absolute top-0 left-0 bg-[#FF5800]",
            corners.vertical,
            shouldAnimate
              ? isActive
                ? "animate-[expandVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionVertical,
          )}
          style={{ transformOrigin: "top center" }}
        />
      </span>

      {/* Top-right corner */}
      <span
        className={cn(
          "absolute flex flex-col pointer-events-none",
          corners.offsetTR,
          corners.container,
        )}
      >
        <span
          className={cn(
            "absolute top-0 right-0 bg-[#FF5800]",
            corners.horizontal,
            shouldAnimate
              ? isActive
                ? "animate-[expandHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionHorizontal,
          )}
          style={{ transformOrigin: "right center" }}
        />
        <span
          className={cn(
            "absolute top-0 right-0 bg-[#FF5800]",
            corners.vertical,
            shouldAnimate
              ? isActive
                ? "animate-[expandVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionVertical,
          )}
          style={{ transformOrigin: "top center" }}
        />
      </span>

      {/* Bottom-left corner */}
      <span
        className={cn(
          "absolute flex flex-col pointer-events-none",
          corners.offsetBL,
          corners.container,
        )}
      >
        <span
          className={cn(
            "absolute bottom-0 left-0 bg-[#FF5800]",
            corners.horizontal,
            shouldAnimate
              ? isActive
                ? "animate-[expandHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionHorizontal,
          )}
          style={{ transformOrigin: "left center" }}
        />
        <span
          className={cn(
            "absolute bottom-0 left-0 bg-[#FF5800]",
            corners.vertical,
            shouldAnimate
              ? isActive
                ? "animate-[expandVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionVertical,
          )}
          style={{ transformOrigin: "bottom center" }}
        />
      </span>

      {/* Bottom-right corner */}
      <span
        className={cn(
          "absolute flex flex-col pointer-events-none",
          corners.offsetBR,
          corners.container,
        )}
      >
        <span
          className={cn(
            "absolute bottom-0 right-0 bg-[#FF5800]",
            corners.horizontal,
            shouldAnimate
              ? isActive
                ? "animate-[expandHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractHorizontal_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionHorizontal,
          )}
          style={{ transformOrigin: "right center" }}
        />
        <span
          className={cn(
            "absolute bottom-0 right-0 bg-[#FF5800]",
            corners.vertical,
            shouldAnimate
              ? isActive
                ? "animate-[expandVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
                : "animate-[contractVertical_0.4s_cubic-bezier(0.34,1.56,0.64,1)_forwards]"
              : undefined,
            petiteTransition,
            petiteMotionVertical,
          )}
          style={{ transformOrigin: "bottom center" }}
        />
      </span>

      {/* Button content */}
      <span className="relative z-10 flex items-center gap-2">
        {icon}
        {children}
      </span>
    </Comp>
  );
}
