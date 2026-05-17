import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

const lockOnButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "border-accent bg-accent text-accent-foreground hover:bg-accent-hover",
        outline:
          "border-border bg-bg-elevated text-txt hover:border-border-strong hover:bg-bg-hover",
        ghost:
          "border-transparent bg-transparent text-txt/70 hover:border-border hover:bg-bg-hover hover:text-txt",
        hud: "border-accent/40 bg-accent-subtle text-accent hover:border-accent/70 hover:bg-accent/20",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4",
        lg: "h-12 px-6",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface LockOnButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof lockOnButtonVariants> {
  asChild?: boolean;
  icon?: React.ReactNode;
}

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

export { lockOnButtonVariants };
