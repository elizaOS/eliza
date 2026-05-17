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
  value?: string;
  onValueChange?: (value: string) => void;
}

export function FormSelect({
  children,
  contentClassName,
  placeholder,
  triggerClassName,
  ...props
}: FormSelectProps) {
  return (
    <Select {...props}>
      <SelectTrigger
        className={cn(
          "h-11 w-full rounded-sm border border-border bg-bg px-4 py-2 text-sm text-txt shadow-xs outline-none transition-colors focus:border-accent focus-visible:border-accent data-[placeholder]:text-muted",
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={cn(
          "rounded-sm border border-border bg-card p-1 shadow-sm",
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
      "min-h-[2.75rem] rounded-sm px-3 py-2.5 text-sm text-txt outline-none transition-colors focus:bg-accent-subtle focus:text-txt-strong data-[state=checked]:bg-accent-subtle data-[state=checked]:text-txt-strong",
      className,
    )}
    {...props}
  />
));
FormSelectItem.displayName = "FormSelectItem";
