import { Search, X } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Called when the clear button is clicked */
  onClear?: () => void;
  /** Show a loading indicator */
  loading?: boolean;
  /** Aria-label for the clear button */
  clearLabel?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      className,
      value,
      onClear,
      loading,
      clearLabel = "Clear search",
      ...props
    },
    ref,
  ) => {
    const hasValue = typeof value === "string" ? value.length > 0 : !!value;

    return (
      <div className={cn("relative flex items-center", className)}>
        <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted" />
        <input
          ref={ref}
          type="text"
          value={value}
          className="h-8 w-full rounded-md border border-input bg-bg pl-8 pr-8 text-xs placeholder:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          {...props}
        />
        {hasValue && onClear && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            className="absolute right-2 h-5 w-5 rounded-sm text-muted hover:text-txt transition-colors"
            aria-label={clearLabel}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
        {loading && (
          <div className="absolute right-2 h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-accent" />
        )}
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
