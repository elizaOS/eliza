import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export type SkeletonProps = Omit<ComponentProps<"div">, "children">;

/** A placeholder in the shape of content still loading; size it with `className`. */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div aria-hidden className={cn("h-4 w-full animate-pulse rounded-md bg-muted", className)} {...props} />;
}
