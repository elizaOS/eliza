/**
 * Single-select segmented button group (generic over the value union) — the
 * inline toggle used for small mutually-exclusive choices where tabs would be
 * too heavy. Items may carry a badge and a per-item test id.
 */
import type * as React from "react";

import { useAgentElement } from "../../agent-surface/useAgentElement";
import { cn } from "../../lib/utils";

export interface SegmentedControlItem<T extends string> {
  value: T;
  label: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
  /** Stable agent-surface id when this choice is chat/voice controllable. */
  agentId?: string;
  agentLabel?: string;
  agentGroup?: string;
}

function SegmentedControlButton<T extends string>({
  item,
  isActive,
  isTabList,
  onValueChange,
  buttonClassName,
  activeButtonClassName,
  inactiveButtonClassName,
}: {
  item: SegmentedControlItem<T>;
  isActive: boolean;
  isTabList: boolean;
  onValueChange: (value: T) => void;
  buttonClassName?: string;
  activeButtonClassName?: string;
  inactiveButtonClassName?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: item.agentId ?? item.value,
    role: isTabList ? "tab" : "button",
    label:
      item.agentLabel ??
      (typeof item.label === "string" ? item.label : item.value),
    group: item.agentGroup,
    status: isActive ? "active" : "inactive",
  });

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-selected is emitted only with the paired tab role
    <button
      ref={ref}
      type="button"
      data-segmented-control-button
      data-testid={item.testId}
      disabled={item.disabled}
      onClick={() => !item.disabled && onValueChange(item.value)}
      role={isTabList ? "tab" : undefined}
      aria-selected={isTabList ? isActive : undefined}
      aria-pressed={isTabList ? undefined : isActive}
      tabIndex={isTabList && !isActive ? -1 : undefined}
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-xs font-semibold transition-colors",
        isActive
          ? "bg-accent-subtle text-txt"
          : "text-muted hover:bg-bg-hover hover:text-txt",
        buttonClassName,
        isActive ? activeButtonClassName : inactiveButtonClassName,
      )}
      {...agentProps}
    >
      {item.label}
      {item.badge}
    </button>
  );
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
  role,
  ...props
}: SegmentedControlProps<T>) {
  const isTabList = role === "tablist";
  return (
    <div
      data-segmented-control
      role={role}
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
        return item.agentId ? (
          <SegmentedControlButton
            key={item.value}
            item={item}
            isActive={isActive}
            isTabList={isTabList}
            onValueChange={onValueChange}
            buttonClassName={buttonClassName}
            activeButtonClassName={activeButtonClassName}
            inactiveButtonClassName={inactiveButtonClassName}
          />
        ) : (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-selected is emitted only with the paired tab role
          <button
            key={item.value}
            type="button"
            data-segmented-control-button
            data-testid={item.testId}
            disabled={item.disabled}
            onClick={() => !item.disabled && onValueChange(item.value)}
            role={isTabList ? "tab" : undefined}
            aria-selected={isTabList ? isActive : undefined}
            aria-pressed={isTabList ? undefined : isActive}
            tabIndex={isTabList && !isActive ? -1 : undefined}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-xs font-semibold transition-colors",
              isActive
                ? "bg-accent-subtle text-txt"
                : "text-muted hover:bg-bg-hover hover:text-txt",
              buttonClassName,
              isActive ? activeButtonClassName : inactiveButtonClassName,
            )}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
