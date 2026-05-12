import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const textareaVariants = cva(
  "w-full border text-sm resize-y transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "flex rounded-md border-input bg-bg px-3 py-2 ring-offset-bg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        form: "rounded-2xl border-border/60 bg-bg/70 px-4 py-3 outline-none shadow-sm focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent",
        config:
          "border-border bg-card font-[var(--mono)] placeholder:text-muted placeholder:opacity-60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
      },
      density: {
        default: "min-h-[80px]",
        compact: "min-h-[64px] px-2 py-1.5 text-xs",
        relaxed: "min-h-[132px]",
      },
    },
    defaultVariants: {
      variant: "default",
      density: "default",
    },
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  hasError?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant, density, hasError, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          textareaVariants({ variant, density }),
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
Textarea.displayName = "Textarea";

export { Textarea, textareaVariants };
