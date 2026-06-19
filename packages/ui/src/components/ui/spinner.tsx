import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number | string;
}

export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size = 24, ...props }, ref) => {
    return (
      <Loader2
        ref={ref}
        size={size}
        className={cn("animate-spin text-muted", className)}
        {...props}
      />
    );
  },
);
Spinner.displayName = "Spinner";
