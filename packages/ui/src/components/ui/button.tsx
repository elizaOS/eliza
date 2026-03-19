import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-[var(--primary-foreground,#1a1f26)] border border-transparent hover:border-[var(--accent-hover,#d8a108)] hover:shadow-[0_0_0_1px_var(--accent-hover,#d8a108)]",
        destructive:
          "bg-destructive text-destructive-fg border border-transparent hover:border-destructive/70 hover:shadow-[0_0_0_1px_rgba(239,68,68,0.3)]",
        outline:
          "border border-input bg-bg hover:border-[var(--accent,#f0b90b)] hover:shadow-[0_0_0_1px_var(--accent,#f0b90b)]",
        secondary: "bg-secondary text-secondary-fg border border-transparent hover:border-secondary/70",
        ghost: "hover:bg-bg-accent hover:text-accent-fg",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3 py-1.5",
        lg: "h-11 rounded-md px-8 py-2.5",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const isDefault = variant === "default" || variant === undefined;
    const resolvedStyle =
      isDefault && !style?.color
        ? { ...style, color: "var(--primary-foreground, #1a1f26)" }
        : style;
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={resolvedStyle}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
