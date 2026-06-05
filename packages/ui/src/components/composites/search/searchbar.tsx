import { Search, X } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";

export interface SidebarSearchBarProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onClear?: () => void;
  loading?: boolean;
  clearLabel?: string;
}

export const SidebarSearchBar = React.forwardRef<
  HTMLInputElement,
  SidebarSearchBarProps
>(
  (
    {
      className,
      value,
      onClear,
      loading = false,
      clearLabel = "Clear search",
      placeholder,
      ...props
    },
    ref,
  ) => {
    const hasValue =
      typeof value === "string" ? value.trim().length > 0 : Boolean(value);
    const inputPlaceholder =
      typeof placeholder === "string" &&
      placeholder.trim().length > 0 &&
      !/(\.\.\.|…)$/.test(placeholder.trim())
        ? `${placeholder.trim()}...`
        : placeholder;

    return (
      <div className={cn("relative flex items-center", className)}>
        <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted" />
        <input
          ref={ref}
          type="text"
          value={value}
          placeholder={inputPlaceholder}
          className="h-10 w-full rounded-sm border border-border/34 bg-card pl-10 pr-10 text-sm text-txt placeholder:text-muted focus-visible:border-accent/28 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/24 disabled:cursor-not-allowed disabled:opacity-50 "
          {...props}
        />
        {loading ? (
          <div className="absolute right-3.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted/35 border-t-accent" />
        ) : hasValue && onClear ? (
          <button
            type="button"
            aria-label={clearLabel}
            className="absolute right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            onClick={onClear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    );
  },
);
SidebarSearchBar.displayName = "SidebarSearchBar";
