/**
 * Brand button: flat fills, theme-token driven, xs rounding.
 *
 * @param props.asChild - If true, renders as a child component using Radix Slot
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

const brandButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground hover:bg-accent-hover active:bg-accent-muted",
        ghost:
          "bg-transparent text-txt/70 hover:border-border hover:bg-bg-hover hover:text-txt",
        outline:
          "border-border bg-bg-elevated text-txt hover:border-border-strong hover:bg-bg-hover",
        icon: "h-10 w-10 border-border bg-bg-elevated hover:border-border-strong hover:bg-bg-hover",
        "icon-primary":
          "size-10 aspect-square border-accent/30 bg-accent-subtle text-accent hover:border-accent/60 hover:bg-accent/20 active:bg-accent/25 disabled:bg-bg-muted disabled:border-border disabled:opacity-50",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 py-2",
        lg: "h-12 px-6 py-3",
        icon: "size-10 aspect-square",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface BrandButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof brandButtonVariants> {
  asChild?: boolean;
}

const BrandButton = React.forwardRef<HTMLButtonElement, BrandButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(brandButtonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);

BrandButton.displayName = "BrandButton";

export { BrandButton, brandButtonVariants };
