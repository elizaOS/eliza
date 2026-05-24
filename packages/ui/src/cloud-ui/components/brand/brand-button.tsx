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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground hover:bg-background hover:text-foreground active:bg-background/90",
        ghost: "bg-transparent text-txt/70 hover:bg-surface hover:text-txt",
        outline:
          "bg-bg-elevated text-txt hover:bg-foreground hover:text-background",
        icon: "h-10 w-10 bg-bg-elevated hover:bg-foreground hover:text-background",
        "icon-primary":
          "size-10 aspect-square bg-accent-subtle text-accent hover:bg-foreground hover:text-background active:bg-foreground/90 disabled:bg-bg-muted disabled:opacity-50",
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
