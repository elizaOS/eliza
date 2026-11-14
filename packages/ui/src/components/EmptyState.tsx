import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type EmptyStateProps = Omit<ComponentProps<"div">, "title"> & {
  /** What is missing, in a few words. */
  title: string;
  /** A picture of what is missing; decorative, so hidden from assistive technology. */
  icon?: ReactNode;
  /** The one control that fills the space, usually a `Button`. */
  children?: ReactNode;
};

/** Stands where a list or view has nothing to show yet. */
export function EmptyState({ title, icon, className, children, ...props }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-4 p-8 text-center", className)} {...props}>
      {icon ? <div aria-hidden className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
