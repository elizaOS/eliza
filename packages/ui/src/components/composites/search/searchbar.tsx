import { Search, X } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export interface SearchBarProps {
  onSearch: (query: string) => void;
  searching?: boolean;
  placeholder?: string;
  /** Label for the submit button when idle. Defaults to "Search". */
  searchLabel?: string;
  /** Label for the submit button when busy. Defaults to "Searching...". */
  searchingLabel?: string;
}

export interface SidebarSearchBarProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onClear?: () => void;
  loading?: boolean;
  clearLabel?: string;
}

export function SearchBar({
  onSearch,
  searching,
  placeholder = "Search...",
  searchLabel = "Search",
  searchingLabel = "Searching...",
}: SearchBarProps) {
  const [query, setQuery] = React.useState("");

  const handleSubmit = React.useCallback(() => {
    if (query.trim()) {
      onSearch(query.trim());
    }
  }, [query, onSearch]);

  return (
    <div className="mb-6">
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          className="h-9 border-border bg-bg text-sm shadow-sm focus-visible:ring-1 focus-visible:ring-accent"
          disabled={searching}
        />
        <Button
          variant="default"
          size="sm"
          className="h-9 px-4 shadow-sm"
          onClick={handleSubmit}
          disabled={!query.trim() || searching}
        >
          {searching ? searchingLabel : searchLabel}
        </Button>
      </div>
    </div>
  );
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
          className="h-10 w-full rounded-xl border border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] pl-10 pr-10 text-sm text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_14px_20px_-20px_rgba(15,23,42,0.12)] placeholder:text-muted focus-visible:border-accent/28 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/24 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_22px_-20px_rgba(0,0,0,0.22)]"
          {...props}
        />
        {loading ? (
          <div className="absolute right-3.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted/35 border-t-accent" />
        ) : hasValue && onClear ? (
          <button
            type="button"
            aria-label={clearLabel}
            className="absolute right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
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
