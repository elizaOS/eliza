/**
 * Convenience wrapper that assembles the Select primitive parts (trigger +
 * placeholder + content) into a single labelled control for forms, so callers
 * pass children items and a value instead of wiring the sub-parts each time.
 */
import type * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";

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
        variant="form"
        className={triggerClassName}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent variant="form" className={contentClassName}>
        {children}
      </SelectContent>
    </Select>
  );
}

export const FormSelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, ...props }, ref) => (
  <SelectItem ref={ref} variant="form" className={className} {...props} />
));
FormSelectItem.displayName = "FormSelectItem";
