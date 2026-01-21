import { cn } from "@polyagent/shared";
import React from "react";

/**
 * Progress bar component for displaying completion status.
 *
 * Displays a horizontal progress bar with configurable value and max.
 * Includes ARIA attributes for accessibility. Value is clamped between 0 and max.
 *
 * @param props - Progress component props
 * @returns Progress bar element
 *
 * @example
 * ```tsx
 * <Progress value={50} max={100} />
 * ```
 */
export interface ProgressProps extends React.ComponentPropsWithoutRef<"div"> {
  value?: number;
  max?: number;
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ value = 0, max = 100, className, ...props }, ref) => {
    const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className={cn(
          "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
          className,
        )}
        {...props}
      >
        <div
          className="h-full w-full flex-1 bg-primary transition-all"
          style={{ transform: `translateX(-${100 - percentage}%)` }}
        />
      </div>
    );
  },
);

Progress.displayName = "Progress";
