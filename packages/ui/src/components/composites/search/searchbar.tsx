/**
 * Text search input with a leading magnifier and a trailing clear button that
 * appears once there is a value; can show a loading spinner in place of the
 * icon. Used for filter fields inside sidebars (e.g. the chat conversation list).
 */
import { Search, X } from "lucide-react";
import * as React from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

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
        <Input
          ref={ref}
          type="text"
          value={value}
          placeholder={inputPlaceholder}
          className="h-10 w-full rounded-sm border border-border/34 bg-card pl-10 pr-10 text-sm text-txt placeholder:text-muted     disabled:cursor-not-allowed disabled:opacity-50 "
          {...props}
        />
        {loading ? (
          <div className="absolute right-3.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted/35 border-t-accent" />
        ) : hasValue && onClear ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={clearLabel}
            className="absolute right-2.5 h-6 w-6 rounded-sm bg-transparent p-0 text-muted transition-colors hover:text-txt"
            onClick={onClear}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    );
  },
);
SidebarSearchBar.displayName = "SidebarSearchBar";
