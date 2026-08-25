/**
 * Convenience wrapper that assembles the Select primitive parts (trigger +
 * placeholder + content) into a single labelled control for forms, so callers
 * pass children items and a value instead of wiring the sub-parts each time.
 */
import type * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";

import { cn } from "../../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export interface FormSelectProps extends React.ComponentProps<typeof Select> {
  children: React.ReactNode;
  placeholder?: string;
  triggerClassName?: string;
  contentClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function FormSelect({
  children,
  contentClassName,
  placeholder,
  triggerClassName,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: FormSelectProps) {
  return (
    <Select {...props}>
      <SelectTrigger
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          "h-11 w-full rounded-sm border border-border bg-bg px-4 py-2 text-sm text-txt outline-none transition-colors hover:border-border-strong hover:bg-bg-hover data-[placeholder]:text-muted",
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={cn(
          "rounded-sm border border-border bg-card p-1 ",
          contentClassName,
        )}
      >
        {children}
      </SelectContent>
    </Select>
  );
}

export const FormSelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, ...props }, ref) => (
  <SelectItem
    ref={ref}
    className={cn(
      "min-h-[2.75rem] rounded-sm px-3 py-2.5 text-sm text-txt outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-txt-strong data-[state=checked]:bg-accent-subtle data-[state=checked]:text-txt-strong",
      className,
    )}
    {...props}
  />
));
FormSelectItem.displayName = "FormSelectItem";
