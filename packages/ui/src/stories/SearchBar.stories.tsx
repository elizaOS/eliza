import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SearchBar } from "../components/ui/search-bar";

const meta: Meta<typeof SearchBar> = {
  title: "Molecules/SearchBar",
  component: SearchBar,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [results, setResults] = useState<
      Array<{ id: string; query: string }>
    >([]);
    return (
      <div className="w-96">
        <SearchBar
          onSearch={(query) =>
            setResults((previous) => [
              ...previous,
              { id: crypto.randomUUID(), query },
            ])
          }
          placeholder="Search knowledge base…"
        />
        {results.length > 0 && (
          <div className="text-xs text-muted space-y-0.5 mt-2">
            {results.map((result) => (
              <div key={result.id}>Searched: &ldquo;{result.query}&rdquo;</div>
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
