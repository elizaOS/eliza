// Sibling primitive mirrored at packages/ui/src/components/ui/badge.tsx. The two
// workspaces (Eliza-UI and Cloud-UI) cannot depend on each other today, so
// these files are intentional siblings. When changing behavior, props, or
// visual semantics, update both — or extract to a shared package per
// docs/frontend-cleanup-2026-05-12/15-cloud-eliza-primitive-dedup.md.

/**
 * Badge component with variant support for different visual styles.
 * Supports default, secondary, destructive, and outline variants.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden !rounded-none border px-2.5 py-1 text-xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:pointer-events-none transition-[color,box-shadow,border-color,background-color] focus-visible:border-[#FF5800]/50 focus-visible:ring-2 focus-visible:ring-[#FF5800]/25 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border-[#FF5800]/40 bg-[#FF5800]/15 text-[#FF8A47] [a&]:hover:bg-[#FF5800]/20",
        secondary: "border-white/10 bg-white/5 text-white/70 [a&]:hover:bg-white/10",
        destructive:
          "border-destructive/30 bg-destructive/15 text-destructive [a&]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:bg-destructive/20",
        outline:
          "border-white/15 bg-transparent text-white/70 [a&]:hover:border-white/25 [a&]:hover:bg-white/5 [a&]:hover:text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
