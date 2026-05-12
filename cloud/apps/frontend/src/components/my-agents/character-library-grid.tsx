/**
 * Character library grid component displaying characters in grid or list view.
 * Shows empty state when no characters are available.
 * Supports both owned and saved agents with appropriate actions for each.
 */

"use client";

import { AgentCard, type AgentCardData, type ViewMode } from "../agents/agent-card";
import { EmptyState } from "./empty-state";

export interface AgentWithOwnership extends AgentCardData {
  isOwned: boolean;
}

interface CharacterLibraryGridProps {
  characters: AgentWithOwnership[];
  viewMode: ViewMode;
  onCreateNew: () => void;
  onRemoveSaved?: (characterId: string) => void;
}

export function CharacterLibraryGrid({
  characters,
  viewMode,
  onCreateNew,
  onRemoveSaved,
}: CharacterLibraryGridProps) {
  if (characters.length === 0) {
    return <EmptyState onCreateNew={onCreateNew} />;
  }

  return (
    <div
      className={
        viewMode === "grid"
          ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          : "grid grid-cols-1 gap-2"
      }
    >
      {characters.map((character) => (
        <AgentCard
          key={character.id}
          agent={character}
          viewMode={viewMode}
          onRemoveSaved={onRemoveSaved}
        />
      ))}
    </div>
  );
}
