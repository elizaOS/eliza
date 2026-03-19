import type { ButtonHTMLAttributes } from "react";

type SwitchSize = "default" | "compact";

type SwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "onChange" | "onClick" | "role" | "aria-checked"
> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: SwitchSize;
  trackOnClass?: string;
  trackOffClass?: string;
  knobClass?: string;
  disabledClassName?: string;
};

const SIZE_CLASS: Record<SwitchSize, string> = {
  default: "w-10 h-6",
  compact: "w-10 h-6",
};

const KNOB_TRAVEL_CLASS: Record<SwitchSize, string> = {
  default: "translate-x-4",
  compact: "translate-x-4",
};

export function Switch({
  checked,
  onChange,
  size = "default",
  trackOnClass = "bg-[var(--accent)]",
  trackOffClass = "bg-[var(--border)]",
  knobClass = "bg-white",
  disabledClassName = "opacity-40 cursor-default",
  disabled,
  className = "",
  ...buttonProps
}: SwitchProps) {
  return (
    <button
      {...buttonProps}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`relative inline-flex shrink-0 rounded-full transition-colors duration-200 focus:outline-none ${SIZE_CLASS[size]} ${checked ? trackOnClass : trackOffClass} ${disabled ? disabledClassName : "cursor-pointer"} ${className}`}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span
        className={`pointer-events-none absolute top-1 left-1 h-4 w-4 rounded-full shadow-sm transition-transform duration-200 ${knobClass} ${checked ? KNOB_TRAVEL_CLASS[size] : ""}`}
      />
    </button>
  );
}
