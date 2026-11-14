import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export type InputProps = Omit<ComponentProps<"input">, "children">;

/** A single-line text field, underlined. Name it with `aria-label`. */
export function Input({ className, ...props }: InputProps) {
  return <input className={cn("h-9 w-full border-b-2 border-input bg-transparent text-foreground outline-none focus-visible:border-ring", className)} {...props} />;
}
