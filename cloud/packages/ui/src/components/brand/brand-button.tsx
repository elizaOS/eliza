/**
 * Brand button component with variants matching the landing page brand design.
 * Supports primary, ghost, outline, and icon variants with multiple sizes.
 *
 * @param props - Brand button props including variant and size
 * @param props.asChild - If true, renders as a child component using Radix Slot
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

const brandButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border border-transparent !rounded-none text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5800]/25 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        // Primary orange button
        primary:
          "bg-[#FF5800] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-[#e54e00] active:bg-[#cc4500]",
        // Ghost button with subtle hover
        ghost:
          "bg-transparent text-white/70 hover:border-white/10 hover:bg-white/5 hover:text-white",
        // Outlined button with white border
        outline: "border-white/15 bg-black/40 text-white hover:border-white/30 hover:bg-white/5",
        // Icon button with border
        icon: "h-10 w-10 border-white/15 bg-black/40 hover:border-white/30 hover:bg-white/5",
        // Icon button with orange accent
        "icon-primary":
          "size-10 aspect-square border-[#FF5800]/30 bg-[#FF5800]/15 text-[#FF8A47] hover:border-[#FF5800]/60 hover:bg-[#FF5800]/20 active:bg-[#FF5800]/25 disabled:bg-white/10 disabled:border-white/10 disabled:opacity-50",
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
