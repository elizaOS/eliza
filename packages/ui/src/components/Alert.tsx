import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const alertVariants = cva("rounded-md border-l-4 bg-muted px-4 py-3 text-sm text-foreground", {
  variants: { variant: { info: "border-border", ok: "border-ok", warn: "border-warn", destructive: "border-destructive" } },
  defaultVariants: { variant: "info" },
});

export type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

/** A message about what just happened. `warn` and `destructive` interrupt a screen reader; the others wait their turn. */
export function Alert({ variant, className, ...props }: AlertProps) {
  const urgent = variant === "warn" || variant === "destructive";
  return <div role={urgent ? "alert" : "status"} className={cn(alertVariants({ variant }), className)} {...props} />;
}
