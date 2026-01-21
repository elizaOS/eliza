import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Select component for dropdown selection.
 *
 * Select dropdown component with controlled value support.
 * Provides onValueChange callback for value updates.
 *
 * @param props - Select component props
 * @returns Select element
 *
 * @example
 * ```tsx
 * <Select value={selected} onValueChange={setSelected}>
 *   <option value="1">Option 1</option>
 * </Select>
 * ```
 */
export interface SelectProps extends React.ComponentPropsWithoutRef<"select"> {
  value?: string;
  onValueChange?: (value: string) => void;
}

export const Select = ({
  children,
  className,
  value,
  onValueChange,
  ...props
}: SelectProps) => {
  return (
    <select
      className={cn(className)}
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...props}
    >
      {children}
    </select>
  );
};

/**
 * Select content container component.
 *
 * Container for select dropdown content.
 *
 * @param props - SelectContent component props
 * @returns Select content element
 */
export type SelectContentProps = React.ComponentPropsWithoutRef<"div">;

export const SelectContent = ({
  children,
  className,
  ...props
}: SelectContentProps) => {
  return (
    <div className={cn(className)} {...props}>
      {children}
    </div>
  );
};

/**
 * Select item component for individual select options.
 *
 * Individual select option item with value attribute.
 *
 * @param props - SelectItem component props
 * @returns Select item element
 */
export interface SelectItemProps extends React.ComponentPropsWithoutRef<"div"> {
  value: string;
}

export const SelectItem = ({
  children,
  value,
  className,
  ...props
}: SelectItemProps) => {
  return (
    <div className={cn(className)} data-value={value} {...props}>
      {children}
    </div>
  );
};

/**
 * Select trigger button component.
 *
 * Button that triggers the select dropdown.
 *
 * @param props - SelectTrigger component props
 * @returns Select trigger button element
 */
export type SelectTriggerProps = React.ComponentPropsWithoutRef<"button">;

export const SelectTrigger = ({
  children,
  className,
  ...props
}: SelectTriggerProps) => {
  return (
    <button className={cn(className)} {...props}>
      {children}
    </button>
  );
};

/**
 * Select value display component.
 *
 * Displays the selected value or placeholder text.
 *
 * @param props - SelectValue component props
 * @returns Select value display element
 */
export interface SelectValueProps {
  placeholder?: string;
}

export const SelectValue = ({ placeholder }: SelectValueProps) => {
  return <span>{placeholder}</span>;
};
