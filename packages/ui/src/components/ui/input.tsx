import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const inputVariants = cva(
  "w-full border text-sm transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "flex rounded-md border-input bg-bg px-3 py-2 ring-offset-bg file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        form: "rounded-2xl border-border/60 bg-bg/70 px-4 py-2 shadow-sm focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent",
        config:
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
      },
      density: {
        default: "h-10",
        compact: "h-9 px-2.5 py-1.5 text-xs",
        relaxed: "h-11",
      },
    },
    defaultVariants: {
      variant: "default",
      density: "default",
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {
  hasError?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, density, hasError, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          inputVariants({ variant, density }),
          hasError &&
            "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input, inputVariants };
