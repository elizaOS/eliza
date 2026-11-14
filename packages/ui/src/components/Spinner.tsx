import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const spinnerVariants = cva("animate-spin", {
  variants: { size: { sm: "size-4", md: "size-6", lg: "size-8" } },
  defaultVariants: { size: "md" },
});

export type SpinnerProps = Omit<ComponentProps<"svg">, "children"> &
  VariantProps<typeof spinnerVariants> & {
    /** What is loading, for assistive technology. */
    label?: string;
  };

/** A turning ring for work whose length is unknown. */
export function Spinner({ size, label = "Loading", className, ...props }: SpinnerProps) {
  return (
    <svg role="status" aria-label={label} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className={cn(spinnerVariants({ size }), className)} {...props}>
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
