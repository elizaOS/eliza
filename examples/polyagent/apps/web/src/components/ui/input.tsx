import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Input component for text input fields.
 *
 * Simple input wrapper that extends standard input HTML attributes.
 * Styling is handled via className.
 *
 * @param props - Input component props
 * @returns Input element
 *
 * @example
 * ```tsx
 * <Input type="text" placeholder="Enter text..." />
 * ```
 */
export type InputProps = React.ComponentPropsWithoutRef<"input">;

export const Input = ({ className, ...props }: InputProps) => {
  return <input className={cn(className)} {...props} />;
};
