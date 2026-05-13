import * as React from "react";

import { cn } from "../../lib/utils";

type SwitchProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      className,
      children,
      checked,
      defaultChecked = false,
      disabled,
      onCheckedChange,
      onClick,
      type,
      ...props
    },
    ref,
  ) => {
    const [uncontrolledChecked, setUncontrolledChecked] =
      React.useState(defaultChecked);
    const isControlled = checked !== undefined;
    const active = isControlled ? checked : uncontrolledChecked;
    const state = active ? "checked" : "unchecked";

    const handleClick = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;

        const next = !active;
        if (!isControlled) {
          setUncontrolledChecked(next);
        }
        onCheckedChange?.(next);
      },
      [active, disabled, isControlled, onCheckedChange, onClick],
    );

    return (
      <button
        className={cn(
          "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-ok data-[state=unchecked]:bg-input",
          className,
        )}
        {...props}
        aria-checked={active}
        data-state={state}
        disabled={disabled}
        onClick={handleClick}
        ref={ref}
        role="switch"
        type={type ?? "button"}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none block h-5 w-5 rounded-full bg-card shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
          data-state={state}
        />
        {children}
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
