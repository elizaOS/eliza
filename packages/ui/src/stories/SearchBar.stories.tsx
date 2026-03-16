import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { SearchBar } from "../components/ui/search-bar";

const meta: Meta<typeof SearchBar> = {
  title: "Molecules/SearchBar",
  component: SearchBar,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [results, setResults] = useState<string[]>([]);
    return (
      <div className="w-96">
        <SearchBar
          onSearch={(q) => setResults((p) => [...p, q])}
          placeholder="Search knowledge base…"
        />
        {results.length > 0 && (
          <div className="text-xs text-muted space-y-0.5 mt-2">
            {results.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: composite key with index as tiebreaker
              <div key={`${r}-${i}`}>Searched: &ldquo;{r}&rdquo;</div>
            ))}
          </div>
        )}
      </div>
    );
  },
};

export const Searching: StoryObj = {
  render: () => (
    <div className="w-96">
      <SearchBar onSearch={() => {}} searching placeholder="Searching…" />
    </div>
  ),
};

export const CustomLabels: StoryObj = {
  render: () => (
    <div className="w-96">
      <SearchBar
        onSearch={() => {}}
        placeholder="Find documents…"
        searchLabel="Find"
        searchingLabel="Looking…"
      />
    </div>
  ),
};
