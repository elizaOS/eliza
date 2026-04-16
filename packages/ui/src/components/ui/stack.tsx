import { cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

export interface StackVariantProps {
  direction?: "row" | "col" | null;
  align?: "start" | "center" | "end" | "stretch" | "baseline" | null;
  justify?: "start" | "center" | "end" | "between" | null;
  spacing?: "none" | "sm" | "md" | "lg" | null;
}

const _stackVariants = cva("flex", {
  variants: {
    direction: {
      row: "flex-row",
      col: "flex-col",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
      baseline: "items-baseline",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
    },
    spacing: {
      none: "gap-0",
      sm: "gap-2",
      md: "gap-4",
      lg: "gap-6",
    },
  },
  defaultVariants: {
    direction: "col",
    spacing: "md",
  },
});

const stackVariants: (props?: StackVariantProps) => string = _stackVariants as (props?: StackVariantProps) => string;

export interface StackProps
  extends React.HTMLAttributes<HTMLDivElement>,
    StackVariantProps {}

export const Stack = React.forwardRef<HTMLDivElement, StackProps>(
  ({ className, direction, align, justify, spacing, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          stackVariants({ direction, align, justify, spacing }),
          className,
        )}
        {...props}
      />
    );
  },
);
Stack.displayName = "Stack";
