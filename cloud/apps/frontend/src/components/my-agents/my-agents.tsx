"use client";

import { DashboardPageContainer, useSetPageHeader } from "@elizaos/cloud-ui";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { logger } from "@/lib/utils/logger";
import { CharacterFilters } from "./character-filters";
import type { AgentWithOwnership } from "./character-library-grid";
import { CharacterLibraryGrid } from "./character-library-grid";

export type ViewMode = "grid" | "list";
export type SortOption = "name" | "created" | "modified" | "recent";

/** Response type for saved agents API */
interface SavedAgent {
  id: string;
  name: string;
  bio?: string | string[];
  avatarUrl?: string;
  avatar_url?: string;
  username?: string | null;
  owner_id: string;
  owner_name: string | null;
  last_interaction_time?: string;
}

/**
 * My Agents client component that handles character listing, filtering, and management.
 * Fetches both owned and saved agents client-side to enable real-time updates.
 */
export function MyAgentsClient() {
  const navigate = useNavigate();
  const claimAttempted = useRef(false);
  const [characters, setCharacters] = useState<AgentWithOwnership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortOption>("modified");

  // Fetch both owned and saved characters
  const fetchCharacters = useCallback(async () => {
    try {
      // Fetch owned and saved agents in parallel
      const [ownedResponse, savedResponse] = await Promise.all([
        fetch("/api/my-agents/characters"),
        fetch("/api/my-agents/saved"),
      ]);

      // Process owned agents
      let ownedAgents: AgentWithOwnership[] = [];
      let ownedFetchFailed = false;
      if (ownedResponse.ok) {
        const ownedResult = await ownedResponse.json();
        ownedAgents = (ownedResult.data?.characters || []).map((char: AgentWithOwnership) => ({
          ...char,
          isOwned: true,
        }));
      } else {
        ownedFetchFailed = true;
        logger.error("[MyAgents] Failed to fetch owned characters");
      }

      // Process saved agents (may not exist yet - gracefully handle 404)
      let savedAgents: AgentWithOwnership[] = [];
      if (savedResponse.ok) {
        const savedResult = await savedResponse.json();
        savedAgents = (savedResult.data?.agents || []).map((agent: SavedAgent) => ({
          id: agent.id,
          name: agent.name,
          bio: agent.bio || "",
          avatarUrl: agent.avatarUrl || agent.avatar_url,
          avatar_url: agent.avatar_url || agent.avatarUrl,
          username: agent.username,
          isOwned: false,
          ownerUsername: agent.owner_name || "Unknown",
          lastInteraction: agent.last_interaction_time,
        }));
      } else if (savedResponse.status !== 404) {
        // Only log error if it's not a 404 (endpoint may not exist yet)
        logger.error("[MyAgents] Failed to fetch saved agents");
      }

      // Show error toast if owned agents failed to load
      if (ownedFetchFailed) {
        toast.error("Failed to load your agents");
      }

      // Merge both lists
      setCharacters([...ownedAgents, ...savedAgents]);
    } catch (error) {
      logger.error("[MyAgents] Failed to fetch characters:", error);
      toast.error("Failed to load your agents");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch and listen for updates
  useEffect(() => {
    fetchCharacters();

    // Listen for character updates
    const handleUpdate = () => fetchCharacters();
    window.addEventListener("characters-updated", handleUpdate);
    return () => window.removeEventListener("characters-updated", handleUpdate);
  }, [fetchCharacters]);

  // Claim any affiliate characters the user has interacted with
  useEffect(() => {
    if (claimAttempted.current) return;
    claimAttempted.current = true;

    const sessionToken = localStorage.getItem("eliza-anon-session-token");

    fetch("/api/my-agents/claim-affiliate-characters", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: sessionToken || undefined }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.claimed?.length > 0) {
          toast.success(`${data.claimed.length} agent(s) added to your library!`, {
            description: data.claimed.map((c: { name: string }) => c.name).join(", "),
          });
          fetchCharacters();

          if (sessionToken) {
            try {
              localStorage.removeItem("eliza-anon-session-token");
            } catch {
              // Ignore cleanup errors
            }
          }
        }
      })
      .catch((error) => {
        logger.error("[MyAgents] Failed to claim affiliate characters:", error);
      });
  }, [fetchCharacters]);

  // Filter characters based on search
  const filteredCharacters = characters.filter((char) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const agent = char as AgentWithOwnership & {
      topics?: string[];
      adjectives?: string[];
    };
    return (
      agent.name?.toLowerCase().includes(query) ||
      (typeof agent.bio === "string" && agent.bio.toLowerCase().includes(query)) ||
      (Array.isArray(agent.bio) && agent.bio.some((b) => b.toLowerCase().includes(query))) ||
      agent.topics?.some((t: string) => t.toLowerCase().includes(query)) ||
      agent.adjectives?.some((a: string) => a.toLowerCase().includes(query))
    );
  });

  // Sort characters - most recent interaction first by default
  const sortedCharacters = [...filteredCharacters].sort((a, b) => {
    if (sortBy === "name") {
      return (a.name || "").localeCompare(b.name || "");
    }
    if (sortBy === "created") {
      // Sort by created_at timestamp (newest first)
      const getCreatedTime = (char: AgentWithOwnership): number => {
        return char.created_at ? new Date(char.created_at).getTime() : 0;
      };
      const timeDiff = getCreatedTime(b) - getCreatedTime(a);
      if (timeDiff !== 0) return timeDiff;
      return (a.name || "").localeCompare(b.name || "");
    }
    // Default: sort by most recent activity
    const getRecentTime = (char: AgentWithOwnership): number => {
      if (char.isOwned) {
        return char.updated_at ? new Date(char.updated_at).getTime() : 0;
      }
      return char.lastInteraction ? new Date(char.lastInteraction).getTime() : 0;
    };
    const timeDiff = getRecentTime(b) - getRecentTime(a);
    if (timeDiff !== 0) return timeDiff;
    return (a.name || "").localeCompare(b.name || "");
  });

  const handleCreateNew = useCallback(() => {
    navigate("/dashboard/chat");
  }, [navigate]);

  // Handler for removing saved agents from the list
  const handleRemoveSaved = useCallback((characterId: string) => {
    setCharacters((prev) => prev.filter((char) => char.id !== characterId));
  }, []);

  useSetPageHeader(
    {
      title: "My Agents",
      description: "Manage your AI agents",
    },
    [],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <DashboardPageContainer>
      <div className="flex flex-col h-full gap-6">
        <CharacterFilters
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          sortBy={sortBy}
          onSortChange={setSortBy}
          totalCount={characters.length}
          filteredCount={filteredCharacters.length}
        />

        <CharacterLibraryGrid
          characters={sortedCharacters}
          viewMode={viewMode}
          onCreateNew={handleCreateNew}
          onRemoveSaved={handleRemoveSaved}
        />
      </div>
    </DashboardPageContainer>
  );
}
