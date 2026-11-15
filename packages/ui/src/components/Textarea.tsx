import type { ComponentProps } from "react";
import { cn, focusRing } from "../lib/cn.ts";

export type TextareaProps = Omit<ComponentProps<"textarea">, "children"> & {
  /** Marks the value as refused, visibly and through `aria-invalid`. */
  invalid?: boolean;
};

/** A text field of several lines that grows with what it holds. Name it with a `Label` or `aria-label`. */
export function Textarea({ invalid = false, className, ...props }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        focusRing,
        "field-sizing-content min-h-9 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}
