// Sibling primitive mirrored at packages/ui/src/components/ui/button.tsx. The two
// workspaces (Eliza-UI and Cloud-UI) cannot depend on each other today, so
// these files are intentional siblings. When changing behavior, props, or
// visual semantics, update both — or extract to a shared package per
// docs/frontend-cleanup-2026-05-12/15-cloud-eliza-primitive-dedup.md.
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

/**
 * Button variant styles using class-variance-authority.
 * Defines visual variants and sizes for button components.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap border border-transparent !rounded-none text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none backdrop-blur-sm focus-visible:border-[#FF5800]/50 focus-visible:ring-2 focus-visible:ring-[#FF5800]/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-[#FF5800] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-[#e54e00]",
        destructive:
          "border-destructive/40 bg-destructive/85 text-white hover:bg-destructive focus-visible:ring-destructive/30 dark:bg-destructive/70",
        outline:
          "border-white/15 bg-black/40 text-white shadow-none hover:border-white/30 hover:bg-white/5",
        secondary: "border-white/10 bg-white/5 text-white hover:border-white/20 hover:bg-white/10",
        ghost:
          "bg-transparent text-white/70 hover:border-white/10 hover:bg-white/5 hover:text-white",
        link: "border-transparent px-0 text-[#FF5800] hover:text-[#ff7a33]",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * Button component with multiple variants and sizes.
 * Can be rendered as a button element or as a child component using the `asChild` prop.
 *
 * @param props - Button props including variant, size, and standard button attributes
 * @param props.asChild - If true, renders as a child component using Radix Slot
 * @param props.variant - Visual style variant (default, destructive, outline, secondary, ghost, link)
 * @param props.size - Size variant (default, sm, lg, icon, icon-sm, icon-lg)
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
