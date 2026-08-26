/**
 * The lock-on brand button with its targeting-reticle hover treatment.
 */
import * as React from "react";
import { Button } from "../../../components/ui/button";
import type { LockOnButtonProps } from "./lock-on-button.variants";

export type { LockOnButtonProps } from "./lock-on-button.variants";

export const LockOnButton = React.forwardRef<
  HTMLButtonElement,
  LockOnButtonProps
>(
  (
    { asChild = false, children, className, icon, size, variant, ...props },
    ref,
  ) => {
    return (
      <Button
        asChild={asChild}
        className={className}
        size={size === "md" ? "default" : size}
        variant={
          variant === "primary"
            ? "default"
            : variant === "hud"
              ? "surfaceAccent"
              : variant
        }
        ref={ref}
        {...props}
      >
        {icon}
        {children}
      </Button>
    );
  },
);

LockOnButton.displayName = "LockOnButton";
