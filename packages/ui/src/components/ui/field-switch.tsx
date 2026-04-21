import * as React from "react";

import { cn } from "../../lib/utils";

export interface FieldSwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "checked" | "onChange" | "children"
  > {
  checked: boolean;
  label: React.ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}

export const FieldSwitch = React.forwardRef<
  HTMLButtonElement,
  FieldSwitchProps
>(
  (
    { checked, className, disabled, label, onCheckedChange, onClick, ...props },
    ref,
  ) => (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        onCheckedChange?.(!checked);
      }}
      className={cn(
        "inline-flex h-10 w-full cursor-pointer select-none items-center gap-3 rounded-xl border border-border/50 bg-bg/50 px-4 py-2 text-sm text-txt transition-[border-color,background-color,box-shadow] hover:border-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-[24px] w-[44px] shrink-0 items-center rounded-full border-2 border-transparent bg-input transition-colors",
          checked && "bg-ok",
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg transition-transform",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
      <span className="pointer-events-none text-left">{label}</span>
    </button>
  ),
);

FieldSwitch.displayName = "FieldSwitch";
