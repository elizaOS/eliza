/**
 * The lock-on brand button with its targeting-reticle hover treatment.
 */
import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import { cn } from "../../lib/utils";
import {
  type LockOnButtonProps,
  lockOnButtonVariants,
} from "./lock-on-button.variants";

export type { LockOnButtonProps } from "./lock-on-button.variants";

export const LockOnButton = React.forwardRef<
  HTMLButtonElement,
  LockOnButtonProps
>(
  (
    { asChild = false, children, className, icon, size, variant, ...props },
    ref,
  ) => {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        className={cn(lockOnButtonVariants({ className, size, variant }))}
        ref={ref}
        {...props}
      >
        {icon}
        {children}
      </Component>
    );
  },
);

LockOnButton.displayName = "LockOnButton";
