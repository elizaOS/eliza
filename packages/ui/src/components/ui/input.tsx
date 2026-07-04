/**
 * Text-input primitive with cva variants (default, and skins used across
 * settings/config forms). The canonical single-line input for the kit; other
 * inputs compose it rather than re-styling a bare `<input>`.
 */
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const inputVariants = cva(
  "w-full border text-sm transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "flex rounded-sm border-input bg-bg px-3 py-2  file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted    ",
        form: "rounded-sm border-border bg-bg px-4 py-2    ",
        config:
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60    ",
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
