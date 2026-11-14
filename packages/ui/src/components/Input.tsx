import type { ComponentProps } from "react";
import { cn, focusRing } from "../lib/cn.ts";

export type InputProps = Omit<ComponentProps<"input">, "children"> & {
  /** Marks the value as refused, visibly and through `aria-invalid`. */
  invalid?: boolean;
};

/** A single-line text field. Name it with a `Label` or `aria-label`. */
export function Input({ invalid = false, className, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        focusRing,
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}
