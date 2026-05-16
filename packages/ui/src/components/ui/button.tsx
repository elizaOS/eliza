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
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium ring-offset-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-accent/45 bg-accent/15 text-accent-fg dark:text-accent shadow-xs hover:border-accent/70 hover:bg-accent/25",
        surface:
          "border border-border bg-card text-muted-strong shadow-xs hover:border-border-strong hover:bg-bg-hover hover:text-txt",
        surfaceAccent:
          "border border-accent/30 bg-accent-subtle text-txt-strong shadow-xs hover:border-accent/50 hover:bg-accent/20",
        surfaceDestructive:
          "border border-danger/30 bg-destructive-subtle text-danger shadow-xs hover:border-danger/50 hover:bg-destructive/15",
        destructive:
          "border border-destructive/45 bg-destructive text-destructive-fg shadow-xs hover:border-destructive/75 hover:bg-destructive/90",
        outline:
          "border border-border bg-card text-txt shadow-xs hover:border-border-strong hover:bg-bg-hover",
        secondary:
          "border border-border bg-bg-accent text-txt shadow-xs hover:border-border-strong hover:bg-bg-hover",
        ghost: "text-muted-strong hover:bg-bg-accent hover:text-txt",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-sm px-3 py-1.5",
        lg: "h-11 rounded-sm px-8 py-2.5",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8",
        "icon-lg": "h-11 w-11",
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
