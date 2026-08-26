/**
 * On/off switch rendered as a `<button role="switch">` (controlled or
 * uncontrolled) — a dependency-free toggle that does not pull in Radix, used
 * wherever a bare boolean switch is needed. The off-state thumb uses the
 * text token so it stays visible on the input track in both appearances;
 * the on-state thumb stays on the card token against the accent track. On
 * coarse pointers the button's box expands to the 44px touch floor while
 * background clipping preserves the compact 44x24 visual track.
 */
import * as React from "react";

import { cn } from "../../lib/utils";

type SwitchProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  variant?: "default" | "field";
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
      variant = "default",
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
          "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-sm border-2 border-transparent transition-colors pointer-coarse:min-h-touch pointer-coarse:py-2.5 pointer-coarse:bg-clip-content disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-input",
          variant === "field" &&
            "h-10 w-full select-none gap-3 border border-border/50 bg-bg/50 px-4 py-2 text-sm text-txt transition-[border-color,background-color,box-shadow] hover:border-accent/40 data-[state=checked]:bg-bg/50 data-[state=unchecked]:bg-bg/50",
          className,
        )}
        {...props}
        aria-checked={active ? "true" : "false"}
        data-state={state}
        disabled={disabled}
        onClick={handleClick}
        ref={ref}
        role="switch"
        type={type ?? "button"}
      >
        {variant === "field" ? (
          <span
            aria-hidden="true"
            className="relative inline-flex h-[24px] w-[44px] shrink-0 items-center rounded-sm border-2 border-transparent bg-input transition-colors data-[state=checked]:bg-ok"
            data-state={state}
          >
            <span
              className="pointer-events-none block size-5 rounded-sm bg-white transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
              data-state={state}
            />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="pointer-events-none block size-5 rounded-sm bg-card transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-card data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-txt"
            data-state={state}
          />
        )}
        {children}
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
