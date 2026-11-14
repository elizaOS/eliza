import type { ComponentProps } from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../lib/cn.ts";

export type ProgressProps = Omit<ComponentProps<typeof ProgressPrimitive.Root>, "children"> & {
  /** How much is done, from 0 to `max`; leave out while the amount is unknown. */
  value?: number | null;
  /** The value that means done. */
  max?: number;
};

/** A bar for work whose length is known. Name it with `aria-label`. */
export function Progress({ value, max = 100, className, ...props }: ProgressProps) {
  // Radix reads a value outside 0 to `max` as unknown, so it is given the one the bar shows.
  const done = value == null ? null : Math.min(Math.max(value, 0), max);
  return (
    <ProgressPrimitive.Root value={done} max={max} className={cn("h-2 w-full overflow-hidden rounded-lg bg-secondary", className)} {...props}>
      <ProgressPrimitive.Indicator
        className={cn("size-full origin-left bg-primary transition-transform", done === null && "animate-pulse")}
        style={done === null ? undefined : { transform: `scaleX(${done / max})` }}
      />
    </ProgressPrimitive.Root>
  );
}
