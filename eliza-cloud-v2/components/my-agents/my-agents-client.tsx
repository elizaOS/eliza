/**
 * My agents client component displaying user's characters with filtering and sorting.
 * Supports search, view mode switching (grid/list), and character management.
 *
 * @param props - My agents client configuration
 * @param props.initialCharacters - Initial list of characters to display
 */

"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSetPageHeader } from "@/components/layout/page-header-context";
import { CharacterLibraryGrid } from "./character-library-grid";
import { CharacterFilters } from "./character-filters";
import type { ElizaCharacter } from "@/lib/types";

interface MyAgentsClientProps {
  initialCharacters: ElizaCharacter[];
}

export type ViewMode = "grid" | "list";
export type SortOption = "name" | "created" | "modified" | "recent";

export function MyAgentsClient({ initialCharacters }: MyAgentsClientProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortOption>("modified");

  // Filter characters based on search
  const filteredCharacters = initialCharacters.filter((char) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      char.name?.toLowerCase().includes(query) ||
      (typeof char.bio === "string" &&
        char.bio.toLowerCase().includes(query)) ||
      (Array.isArray(char.bio) &&
        char.bio.some((b) => b.toLowerCase().includes(query))) ||
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

  const handleCreateNew = useCallback(() => {
    router.push("/dashboard/build");
  }, [router]);

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
        onCreateNew={handleCreateNew}
      />

      <CharacterLibraryGrid
        characters={sortedCharacters}
        viewMode={viewMode}
        onCreateNew={handleCreateNew}
      />
    </div>
  );
}
