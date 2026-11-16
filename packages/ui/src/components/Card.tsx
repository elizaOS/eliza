import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export type CardProps = ComponentProps<"div">;
export type CardTitleProps = ComponentProps<"h3">;

/** A surface that groups what belongs to one thing. */
export function Card({ className, ...props }: CardProps) {
  return <div className={cn("flex flex-col gap-4 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm", className)} {...props} />;
}

/** The name of what a `Card` holds. */
export function CardTitle({ className, ...props }: CardTitleProps) {
  return <h3 className={cn("text-base leading-none font-semibold", className)} {...props} />;
}

/** The actions of a `Card`, in a row at its end. */
export function CardFooter({ className, ...props }: CardProps) {
  return <div className={cn("flex items-center justify-end gap-2", className)} {...props} />;
}
