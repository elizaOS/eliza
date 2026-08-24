/**
 * Inline status/label pill with cva-driven variants (default, secondary,
 * destructive, outline). A leaf primitive in the components/ui base layer.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold transition-colors    ",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-fg hover:bg-primary/80",
        secondary: "border-transparent bg-bg-accent text-txt hover:bg-bg-hover",
        destructive:
          "border-transparent bg-destructive text-destructive-fg hover:bg-destructive/80",
        outline: "text-txt border-border",
      },
      size: {
        default: "",
        compact: "text-2xs uppercase",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({
  asChild = false,
  className,
  variant,
  size,
  ...props
}: BadgeProps) {
  const Component = asChild ? Slot : "div";
  return (
    <Component
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
