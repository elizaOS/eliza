"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { cn } from "../../lib/utils";

export interface ApiParameterSelectOption {
  value: string;
  label: string;
}

export interface ApiParameterSelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: ApiParameterSelectOption[];
  placeholder?: string;
  className?: string;
}

export function ApiParameterSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  className,
}: ApiParameterSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        className={cn(
          "h-10 rounded-none border-border bg-background/80 text-foreground hover:bg-muted focus:ring-primary/40",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="rounded-none border-border bg-background">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
