/**
 * Custom select component with dropdown functionality.
 * Provides custom styling and click-outside handling.
 *
 * @param props - Custom select configuration
 * @param props.value - Selected value
 * @param props.onValueChange - Callback when value changes
 * @param props.options - Array of select options
 * @param props.placeholder - Placeholder text
 */

"use client";

import { ChevronDownIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}

export function CustomSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  className,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [selectedLabel, setSelectedLabel] = React.useState<string>("");
  const selectRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const selected = options.find((option) => option.value === value);
    setSelectedLabel(selected ? selected.label : "");
  }, [value, options]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };

  const handleSelect = (option: SelectOption) => {
    onValueChange?.(option.value);
    setIsOpen(false);
  };

  return (
    <div ref={selectRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-none border px-3 py-2 text-sm transition-colors",
          "border-border bg-background/80",
          "text-foreground",
          "hover:bg-muted",
          "focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className={cn(selectedLabel ? "text-foreground" : "text-muted-foreground")}>
          {selectedLabel || placeholder}
        </span>
        <ChevronDownIcon
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-full overflow-hidden rounded-none border shadow-lg",
            "border-border bg-background",
            "animate-in fade-in-0 zoom-in-95",
          )}
        >
          <div className="max-h-60 overflow-auto p-1">
            {options.map((option) => {
              const isSelected = value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option)}
                  className={cn(
                    "w-full flex items-center rounded-none px-2 py-1.5 text-sm transition-colors",
                    "text-left cursor-pointer select-none outline-none",
                    "text-foreground",
                    "hover:bg-muted",
                    "focus:bg-muted",
                    isSelected && "bg-primary/10 text-primary",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
