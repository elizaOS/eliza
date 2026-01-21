import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Badge component for displaying labels and status indicators.
 *
 * Simple badge component that extends span element. Currently accepts
 * variant prop but styling is handled via className.
 *
 * @param props - Badge component props
 * @returns Badge element
 *
 * @example
 * ```tsx
 * <Badge variant="default">New</Badge>
 * ```
 */
export interface BadgeProps extends React.ComponentPropsWithoutRef<"span"> {
  variant?: "default" | "secondary" | "outline" | "destructive";
}

export const Badge = ({
  children,
  variant: _variant,
  className,
  ...props
}: BadgeProps) => {
  return (
    <span className={cn(className)} {...props}>
      {children}
    </span>
  );
};
export const badgeVariants = () => "";
