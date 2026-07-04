/**
 * Single-select segmented button group (generic over the value union) — the
 * inline toggle used for small mutually-exclusive choices where tabs would be
 * too heavy. Items may carry a badge and a per-item test id.
 */
import type * as React from "react";

import { cn } from "../../lib/utils";

export interface SegmentedControlItem<T extends string> {
  value: T;
  label: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}

export interface SegmentedControlProps<T extends string>
  extends React.HTMLAttributes<HTMLDivElement> {
  value: T;
  onValueChange: (value: T) => void;
  items: Array<SegmentedControlItem<T>>;
  buttonClassName?: string;
  activeButtonClassName?: string;
  inactiveButtonClassName?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  items,
  className,
  buttonClassName,
  activeButtonClassName,
  inactiveButtonClassName,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div
      data-segmented-control
      className={cn(
        // Borderless segmented tabs (#10710): no outer box — the active
        // segment's accent wash is the state signal.
        "flex w-fit max-w-full self-start items-center gap-1 rounded-sm",
        className,
      )}
      {...props}
    >
      {items.map((item) => {
        const isActive = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            data-segmented-control-button
            data-testid={item.testId}
            disabled={item.disabled}
            onClick={() => !item.disabled && onValueChange(item.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-xs font-semibold transition-colors",
              isActive
                ? "bg-accent-subtle text-txt"
                : "text-muted hover:bg-bg-hover hover:text-txt",
              buttonClassName,
              isActive ? activeButtonClassName : inactiveButtonClassName,
            )}
            aria-pressed={isActive}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
