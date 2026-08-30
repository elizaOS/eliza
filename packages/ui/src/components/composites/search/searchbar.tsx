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
import { Spinner } from "../../ui/spinner";

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
      <div
        className={cn("relative flex items-center [&_input]:pr-10", className)}
      >
        <Search className="pointer-events-none absolute left-3.5 size-4 text-muted" />
        <Input
          ref={ref}
          type="text"
          value={value}
          placeholder={inputPlaceholder}
          variant="form"
          adornment="leading"
          {...props}
        />
        {loading ? (
          <Spinner variant="search" className="absolute right-3.5" />
        ) : hasValue && onClear ? (
          <Button
            variant="ghostMuted"
            size="icon-sm"
            aria-label={clearLabel}
            className="absolute right-2.5"
            onClick={onClear}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
    );
  },
);
SidebarSearchBar.displayName = "SidebarSearchBar";
