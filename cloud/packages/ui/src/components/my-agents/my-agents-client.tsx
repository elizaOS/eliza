/**
 * My agents client component displaying user's characters with filtering and sorting.
 * Supports search, view mode switching (grid/list), and character management.
 *
 * @param props - My agents client configuration
 * @param props.initialCharacters - Initial list of characters to display
 */

"use client";

import { useSetPageHeader } from "../primitives";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ElizaCharacter } from "@/lib/types";
import { CharacterFilters } from "./character-filters";
import { type AgentWithOwnership, CharacterLibraryGrid } from "./character-library-grid";
import type { SortOption, ViewMode } from "./types";

interface MyAgentsClientProps {
  initialCharacters: ElizaCharacter[];
}

export function MyAgentsClient({ initialCharacters }: MyAgentsClientProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortOption>("modified");

  // Filter characters based on search
  const filteredCharacters = initialCharacters.filter((char) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      char.name?.toLowerCase().includes(query) ||
      (typeof char.bio === "string" && char.bio.toLowerCase().includes(query)) ||
      (Array.isArray(char.bio) && char.bio.some((b) => b.toLowerCase().includes(query))) ||
      char.topics?.some((t) => t.toLowerCase().includes(query)) ||
      char.adjectives?.some((a) => a.toLowerCase().includes(query))
    );
  });

  // Sort characters
  const sortedCharacters = [...filteredCharacters].sort((a, b) => {
    switch (sortBy) {
      case "name":
        return (a.name || "").localeCompare(b.name || "");
      case "created":
        // Note: created_at is not in ElizaCharacter type, using name as fallback
        return (a.name || "").localeCompare(b.name || "");
      case "modified":
        // Note: updated_at is not in ElizaCharacter type, using name as fallback
        return (b.name || "").localeCompare(a.name || "");
      case "recent":
        return (b.name || "").localeCompare(a.name || "");
      default:
        return 0;
    }
  });

  const ownedCharacters: AgentWithOwnership[] = sortedCharacters.map((char) => ({
    ...char,
    id: char.id ?? "",
    isOwned: true,
  }));

  const handleCreateNew = useCallback(() => {
    navigate("/dashboard/build");
  }, [navigate]);

  useSetPageHeader(
    {
      title: "My Agents",
      description: "Manage your AI agents",
    },
    [],
  );

  return (
    <div className="flex flex-col h-full gap-6">
      <CharacterFilters
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        sortBy={sortBy}
        onSortChange={setSortBy}
        totalCount={initialCharacters.length}
        filteredCount={filteredCharacters.length}
      />

      <CharacterLibraryGrid
        characters={ownedCharacters}
        viewMode={viewMode}
        onCreateNew={handleCreateNew}
      />
    </div>
  );
}
