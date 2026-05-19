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
        "flex w-fit max-w-full self-start items-center gap-1 rounded-sm border border-border bg-card p-1",
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
                ? "border border-accent/30 bg-accent-subtle text-txt shadow-xs"
                : "border border-transparent text-muted hover:bg-bg-hover hover:text-txt",
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
