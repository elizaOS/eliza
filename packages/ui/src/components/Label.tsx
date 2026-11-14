import type { ComponentProps } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "../lib/cn.ts";

export type LabelProps = ComponentProps<typeof LabelPrimitive.Root>;

/** The name of a control: point `htmlFor` at the control's id, or wrap the control. */
export function Label({ className, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      className={cn("flex items-center gap-2 text-sm font-medium text-foreground has-disabled:opacity-50 peer-disabled:opacity-50", className)}
      {...props}
    />
  );
}
