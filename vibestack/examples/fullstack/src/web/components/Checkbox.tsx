import type { ComponentProps } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn, focusRing } from "../lib/cn.ts";

export type CheckboxProps = Omit<ComponentProps<typeof CheckboxPrimitive.Root>, "children">;

/** A yes-or-no choice. Name it with `aria-label`. */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn(focusRing, "inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-input bg-background disabled:opacity-30 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground", className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5">
          <path d="m3 8.5 3.5 3.5 6.5-8" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
