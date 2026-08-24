/**
 * Text-input primitive with cva variants (default, and skins used across
 * settings/config forms). The canonical single-line input for the kit; other
 * inputs compose it rather than re-styling a bare `<input>`. Coarse-pointer
 * surfaces retain a 44px minimum hit area and 16px font size (prevents iOS
 * Safari focus-zoom) even when a compact density or caller-provided size is used.
 */
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const inputVariants = cva(
  "w-full min-w-0 border text-sm pointer-coarse:text-[16px] transition-[border-color,box-shadow,background-color] pointer-coarse:min-h-touch pointer-coarse:min-w-touch disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "flex rounded-sm border-input bg-bg px-3 py-2  file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted    ",
        form: "rounded-sm border-border bg-bg px-4 py-2    ",
        config:
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60    ",
        embeddedSearch:
          "rounded-none border-0 bg-transparent px-4 py-2.5 font-body text-txt shadow-none placeholder:text-muted",
        secret:
          "rounded-sm border-border/60 bg-bg px-2.5 py-1.5 font-mono text-txt placeholder:text-muted",
        embeddedName:
          "rounded-none border-0 bg-transparent px-0 font-semibold shadow-none placeholder:text-muted",
        document:
          "rounded-sm border-border/55 bg-bg/72 px-3 py-2 text-xs shadow-none placeholder:text-muted",
      },
      density: {
        default: "h-10",
        compact: "h-9 px-2.5 py-1.5 text-xs",
        short: "h-9 px-3 py-2 text-sm",
        search: "h-12 text-sm",
        denseResponsive: "h-8 text-sm sm:text-base",
        relaxed: "h-11",
      },
      adornment: {
        none: "",
        leading: "pl-10 pr-4",
      },
    },
    defaultVariants: {
      variant: "default",
      density: "default",
      adornment: "none",
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {
  hasError?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { className, type, variant, density, adornment, hasError, ...props },
    ref,
  ) => {
    return (
      <input
        type={type}
        className={cn(
          inputVariants({ variant, density, adornment }),
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
