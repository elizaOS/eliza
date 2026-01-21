import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Label component for form field labels.
 *
 * Simple label wrapper that extends standard label HTML attributes.
 * Styling is handled via className.
 *
 * @param props - Label component props
 * @returns Label element
 *
 * @example
 * ```tsx
 * <Label htmlFor="email">Email</Label>
 * ```
 */
export type LabelProps = React.ComponentPropsWithoutRef<"label">;

export const Label = ({ children, className, ...props }: LabelProps) => {
  return (
    <label className={cn(className)} {...props}>
      {children}
    </label>
  );
};
