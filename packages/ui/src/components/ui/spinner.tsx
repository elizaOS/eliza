/**
 * Spinning `Loader2` icon at a configurable size — the kit's inline loading
 * indicator for buttons and small in-flight regions.
 */

import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

const spinnerVariants = cva("animate-spin text-muted", {
  variants: {
    variant: {
      default: "",
      search: "size-3.5 text-accent",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface SpinnerProps
  extends React.SVGAttributes<SVGSVGElement>,
    VariantProps<typeof spinnerVariants> {
  size?: number | string;
}

export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size = 24, variant, ...props }, ref) => {
    return (
      <Loader2
        ref={ref}
        size={size}
        className={cn(spinnerVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
Spinner.displayName = "Spinner";
