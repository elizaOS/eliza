"use client";

import { cn } from "@polyagent/shared";
import { Search, X } from "lucide-react";

/**
 * Props for the SearchBar component.
 */
interface SearchBarProps {
  /** Current search input value */
  value: string;
  /** Callback when search value changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to use compact styling */
  compact?: boolean;
}

/**
 * Search bar input component with icon and clear button.
 *
 * Provides a search input field with search icon and optional
 * clear button. Supports both standard and compact variants.
 *
 * @param props - SearchBar component props
 * @returns Search bar element
 *
 * @example
 * ```tsx
 * <SearchBar
 *   value={searchQuery}
 *   onChange={setSearchQuery}
 *   placeholder="Search users..."
 * />
 * ```
 */
export function SearchBar({
  value,
  onChange,
  placeholder = "Search...",
  className,
  compact = false,
}: SearchBarProps) {
  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2",
          compact ? "left-3" : "left-4",
        )}
      >
        <Search
          className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "text-primary")}
        />
      </div>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full",
          "border border-border bg-muted/50",
          "focus:border-border focus:outline-none",
          "transition-all duration-200",
          "text-foreground",
          compact ? "py-1.5 pr-9 pl-9 text-sm" : "py-2.5 pr-10 pl-11",
          "rounded-full",
        )}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 p-1 transition-colors hover:bg-muted/50",
            compact ? "right-2" : "right-3",
          )}
        >
          <X
            className={cn(
              compact ? "h-3.5 w-3.5" : "h-4 w-4",
              "text-muted-foreground",
            )}
          />
        </button>
      )}
      <style jsx>{`
        input::placeholder {
          color: hsl(var(--muted-foreground));
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}
