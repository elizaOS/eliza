import type { ComponentProps, MouseEvent } from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn, focusRing } from "../lib/cn.ts";
import { Spinner } from "./Spinner.tsx";

const buttonVariants = cva(
  [focusRing, "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50"],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", lg: "h-10 px-6", icon: "size-9" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner and refuses clicks while work is in flight. */
    loading?: boolean;
    /** Renders the single child element with the button's styles, for a link that looks like a button. */
    asChild?: boolean;
  };

/** An action a person can take. Give one without text, such as an icon, an `aria-label`. */
export function Button({ variant, size, loading = false, asChild = false, type = "button", disabled, className, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  const off = disabled || loading;
  // The child of `asChild`, a link, has no `disabled`: it is marked, leaves the tab order and refuses activation.
  const state = asChild ? off && { "aria-disabled": true, tabIndex: -1, onClickCapture: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); } } : { type, disabled: off };
  return (
    <Comp aria-busy={loading || undefined} className={cn(buttonVariants({ variant, size }), className)} {...props} {...state}>
      {loading && <Spinner size="sm" aria-hidden />}
      <Slottable>{children}</Slottable>
    </Comp>
  );
}
