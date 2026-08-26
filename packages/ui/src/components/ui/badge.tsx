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
        micro: "border-0 px-1.5 py-0 text-3xs font-medium",
        microBold: "border-0 px-1.5 py-0 text-3xs font-bold",
      },
      tone: {
        default: "",
        accent: "bg-accent/12 text-accent-fg",
        success: "bg-ok/10 text-ok",
        warning: "bg-warn/10 text-warn",
        danger: "bg-danger/10 text-danger",
        muted: "bg-bg-hover text-muted-strong",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      tone: "default",
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
  tone,
  ...props
}: BadgeProps) {
  const Component = asChild ? Slot : "div";
  return (
    <Component
      className={cn(badgeVariants({ variant, size, tone }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
