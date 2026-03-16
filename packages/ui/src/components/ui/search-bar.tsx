/**
 * SearchBar — a self-contained search input with submit button.
 *
 * Fully generic; no app-context dependency. Callers pass the placeholder
 * and loading state directly.
 */

import { useCallback, useState } from "react";
import { Button } from "./button";
import { Input } from "./input";

export interface SearchBarProps {
  onSearch: (query: string) => void;
  searching?: boolean;
  placeholder?: string;
  /** Label for the submit button when idle. Defaults to "Search". */
  searchLabel?: string;
  /** Label for the submit button when busy. Defaults to "Searching...". */
  searchingLabel?: string;
}

export function SearchBar({
  onSearch,
  searching,
  placeholder = "Search...",
  searchLabel = "Search",
  searchingLabel = "Searching...",
}: SearchBarProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = useCallback(() => {
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
          className="h-9 bg-bg border-border text-sm shadow-sm focus-visible:ring-1 focus-visible:ring-accent"
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
