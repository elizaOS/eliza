import * as React from "react";

import { cn } from "../../lib/utils";

export type SwitchSize = "default" | "compact";

export interface SwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    | "type"
    | "onChange"
    | "onClick"
    | "role"
    | "aria-checked"
    | "defaultChecked"
    | "checked"
  > {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  onCheckedChange?: (next: boolean) => void;
  size?: SwitchSize;
  trackOnClass?: string;
  trackOffClass?: string;
  knobClass?: string;
  disabledClassName?: string;
}

const SIZE_CLASS: Record<SwitchSize, string> = {
  default: "h-[24px] w-[44px]",
  compact: "h-5 w-9 border-2 border-transparent",
};

const KNOB_CLASS: Record<SwitchSize, string> = {
  default: "h-5 w-5",
  compact: "h-4 w-4",
};

const KNOB_POSITION_CLASS: Record<SwitchSize, string> = {
  default: "translate-x-5",
  compact: "translate-x-4",
};

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      defaultChecked = false,
      onChange,
      onCheckedChange,
      size = "default",
      trackOnClass = "bg-primary",
      trackOffClass = "bg-input",
      knobClass = "bg-bg shadow-lg",
      disabledClassName = "cursor-not-allowed opacity-50",
      className,
      disabled,
      ...props
    },
    ref,
  ) => {
    const isControlled = checked !== undefined;
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
    const isOn = isControlled ? checked : internalChecked;

    React.useEffect(() => {
      if (!isControlled) {
        setInternalChecked(defaultChecked);
      }
    }, [defaultChecked, isControlled]);

    const handleToggle = () => {
      if (disabled) {
        return;
      }

      const next = !isOn;
      if (!isControlled) {
        setInternalChecked(next);
      }
      onChange?.(next);
      onCheckedChange?.(next);
    };

    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="switch"
        aria-checked={isOn}
        disabled={disabled}
        className={cn(
          "peer relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          SIZE_CLASS[size],
          isOn ? trackOnClass : trackOffClass,
          disabled ? disabledClassName : "cursor-pointer",
          className,
        )}
        onClick={handleToggle}
      >
        <span
          className={cn(
            "pointer-events-none absolute left-0.5 top-0.5 block rounded-full ring-0 transition-transform",
            KNOB_CLASS[size],
            knobClass,
            isOn && KNOB_POSITION_CLASS[size],
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
