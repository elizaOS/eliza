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
          "h-11 w-full rounded-2xl border border-border/60 bg-bg/70 px-4 py-2 text-sm text-txt shadow-sm outline-none transition-[border-color,box-shadow,background-color,outline-color,outline-offset] focus:border-accent focus:outline-[2px] focus:outline-[var(--ring)] focus:outline-offset-2 focus:ring-0 focus:shadow-[0_0_0_4px_var(--focus)] focus-visible:border-accent focus-visible:outline-[2px] focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 focus-visible:ring-0 focus-visible:shadow-[0_0_0_4px_var(--focus)] data-[placeholder]:text-muted",
          triggerClassName,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={cn(
          "rounded-2xl border border-border/60 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_94%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_22px_34px_-24px_rgba(15,23,42,0.28)] backdrop-blur-xl",
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
      "min-h-[2.75rem] rounded-xl px-3 py-2.5 text-sm text-txt outline-none transition-[background-color,color,box-shadow] focus:bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.18),rgba(var(--accent-rgb),0.08))] focus:text-black data-[state=checked]:bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.2),rgba(var(--accent-rgb),0.1))] data-[state=checked]:text-black data-[state=checked]:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_10px_18px_-18px_rgba(var(--accent-rgb),0.25)]",
      className,
    )}
    {...props}
  />
));
FormSelectItem.displayName = "FormSelectItem";
