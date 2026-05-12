// Sibling primitive mirrored at cloud/packages/ui/src/components/button.tsx. The two
// workspaces (Eliza-UI and Cloud-UI) cannot depend on each other today, so
// these files are intentional siblings. When changing behavior, props, or
// visual semantics, update both — or extract to a shared package per
// docs/frontend-cleanup-2026-05-12/15-cloud-eliza-primitive-dedup.md.
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
          // Solid accent surfaces use text-accent-fg; translucent accent buttons
          // switch to text-accent in dark mode to preserve contrast.
          "border border-accent/45 bg-accent/18 text-accent-fg dark:text-accent shadow-sm hover:border-accent/70 hover:bg-accent/28",
        surface:
          "border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 disabled:hover:border-border/32 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] disabled:hover:text-muted-strong dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]",
        surfaceAccent:
          "border border-accent/26 bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.16),rgba(var(--accent-rgb),0.07))] text-txt-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_14px_22px_-18px_rgba(var(--accent-rgb),0.24)] ring-1 ring-inset ring-accent/10 hover:border-accent/42 hover:bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.2),rgba(var(--accent-rgb),0.1))] hover:text-txt-strong",
        surfaceDestructive:
          "border border-danger/30 bg-[linear-gradient(180deg,rgba(239,68,68,0.12),rgba(239,68,68,0.06))] text-danger shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_14px_20px_-18px_rgba(127,29,29,0.18)] hover:border-danger/44 hover:bg-[linear-gradient(180deg,rgba(239,68,68,0.16),rgba(239,68,68,0.08))] hover:text-danger",
        destructive:
          "border border-destructive/45 bg-destructive/92 text-destructive-fg shadow-sm hover:border-destructive/75 hover:bg-destructive",
        outline:
          "border border-border bg-card/92 text-txt shadow-sm hover:border-border-strong hover:bg-bg-hover",
        secondary:
          "border border-border bg-bg-accent text-txt shadow-sm hover:border-border-strong hover:bg-bg-hover",
        ghost: "text-muted-strong hover:bg-bg-accent hover:text-txt",
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
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={style}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
