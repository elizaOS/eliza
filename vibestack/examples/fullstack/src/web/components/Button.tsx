import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn, focusRing } from "../lib/cn.ts";

const buttonVariants = cva([focusRing, "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-xl font-medium transition-colors disabled:pointer-events-none disabled:opacity-30"], {
  variants: {
    variant: {
      primary: "bg-primary text-primary-foreground hover:bg-primary/90",
      ghost: "hover:bg-accent hover:text-accent-foreground",
    },
  },
  defaultVariants: { variant: "primary" },
});

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

/** A square action showing one sign, named by its `aria-label`. */
export function Button({ variant, type = "button", className, ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
