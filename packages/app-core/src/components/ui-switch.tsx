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
  default: "w-10 h-5",
  compact: "w-9 h-5 border-2 border-transparent",
};

const KNOB_TRAVEL_CLASS: Record<SwitchSize, string> = {
  default: "translate-x-5",
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
        className={`pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform duration-200 ${knobClass} ${checked ? KNOB_TRAVEL_CLASS[size] : ""}`}
      />
    </button>
  );
}
