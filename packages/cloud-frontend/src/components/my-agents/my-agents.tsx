"use client";

import { DashboardPageContainer, useSetPageHeader } from "@elizaos/ui";
import {
  ArrowRight,
  BookOpen,
  CreditCard,
  KeyRound,
  Loader2,
  MessageCircle,
  MonitorSmartphone,
  Server,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

const ADMIN_SECTIONS = [
  {
    title: "Runtime",
    description: "Monitor the hosted process, logs, health, and deployments.",
    to: "/dashboard/containers",
    icon: Server,
  },
  {
    title: "API keys",
    description: "Create and rotate keys for programmatic access.",
    to: "/dashboard/api-keys",
    icon: KeyRound,
  },
  {
    title: "Billing",
    description: "Review credits, payment methods, and usage controls.",
    to: "/dashboard/billing",
    icon: CreditCard,
  },
  {
    title: "App devices",
    description: "Manage connected apps and device-facing integrations.",
    to: "/dashboard/apps",
    icon: MonitorSmartphone,
  },
  {
    title: "Docs",
    description: "Read setup guides, APIs, MCP, apps, and runtime docs.",
    to: "/docs",
    icon: BookOpen,
  },
] as const;

function getAgentChatPath(agent: AgentWithOwnership | null): string {
  if (!agent) return "/dashboard/containers";
  return agent.username ? `/chat/@${agent.username}` : `/chat/${agent.id}`;
}

function AgentConsoleOverview({
  agents,
  onCreateNew,
}: {
  agents: AgentWithOwnership[];
  onCreateNew: () => void;
}) {
  const ownedAgents = agents.filter((agent) => agent.isOwned !== false);
  const primaryAgent = ownedAgents[0] ?? agents[0] ?? null;
  const runningCount = ownedAgents.filter(
    (agent) => agent.stats?.deploymentStatus === "deployed",
  ).length;
  const chatPath = getAgentChatPath(primaryAgent);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
      <div className="rounded-2xl border border-white/36 bg-white/58 p-5 shadow-[0_18px_54px_rgba(3,28,58,0.12)] backdrop-blur-2xl">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-normal text-accent">
              Agent console
            </p>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-normal text-[#06131f] md:text-3xl">
                Administer and enter your running agent
              </h1>
              <p className="text-sm leading-6 text-[#06131f]/68">
                Use this page as the control room for your hosted Eliza agent:
                open the live chat, inspect runtime state, manage API access,
                connect app devices, and keep billing in view.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:flex-col">
            <Link
              to={chatPath}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-accent bg-primary px-4 text-sm font-medium text-primary-fg shadow-[0_12px_32px_rgba(217,95,22,0.24)] transition-colors hover:bg-accent-hover"
            >
              <MessageCircle className="h-4 w-4" />
              {primaryAgent ? "Open agent chat" : "Go to my agent"}
            </Link>
            <button
              type="button"
              onClick={onCreateNew}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-white/42 bg-white/36 px-4 text-sm font-medium text-[#06131f]/78 transition-colors hover:bg-white/58 hover:text-[#06131f]"
            >
              <Server className="h-4 w-4" />
              Runtime admin
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-white/42 bg-white/42 sm:grid-cols-3">
          <div className="bg-white/44 p-4">
            <p className="text-[11px] uppercase tracking-normal text-[#06131f]/48">
              Owned agents
            </p>
            <p className="mt-1 text-2xl font-semibold text-[#06131f]">
              {ownedAgents.length}
            </p>
          </div>
          <div className="bg-white/44 p-4">
            <p className="text-[11px] uppercase tracking-normal text-[#06131f]/48">
              Running
            </p>
            <p className="mt-1 text-2xl font-semibold text-[#06131f]">
              {runningCount}
            </p>
          </div>
          <div className="bg-white/44 p-4">
            <p className="text-[11px] uppercase tracking-normal text-[#06131f]/48">
              Chat target
            </p>
            <p className="mt-1 truncate text-sm font-medium text-[#06131f]">
              {primaryAgent?.name ?? "Create or deploy an agent"}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {ADMIN_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Link
              key={section.title}
              to={section.to}
              className="group flex items-start gap-3 rounded-2xl border border-white/36 bg-white/50 p-4 shadow-[0_14px_42px_rgba(3,28,58,0.1)] backdrop-blur-2xl transition-colors hover:border-accent/40 hover:bg-white/68"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/48 bg-white/52 text-accent">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-[#06131f]">
                    {section.title}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-[#06131f]/34 transition-colors group-hover:text-accent" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-[#06131f]/62">
                  {section.description}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * My Agent client component that handles agent listing, filtering, and management.
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
        ownedAgents = (ownedResult.data?.characters || []).map(
          (char: AgentWithOwnership) => ({
            ...char,
            isOwned: true,
          }),
        );
      } else {
        ownedFetchFailed = true;
        logger.error("[MyAgents] Failed to fetch owned characters");
      }

      // Process saved agents (may not exist yet - gracefully handle 404)
      let savedAgents: AgentWithOwnership[] = [];
      if (savedResponse.ok) {
        const savedResult = await savedResponse.json();
        savedAgents = (savedResult.data?.agents || []).map(
          (agent: SavedAgent) => ({
            id: agent.id,
            name: agent.name,
            bio: agent.bio || "",
            avatarUrl: agent.avatarUrl || agent.avatar_url,
            avatar_url: agent.avatar_url || agent.avatarUrl,
            username: agent.username,
            isOwned: false,
            ownerUsername: agent.owner_name || "Unknown",
            lastInteraction: agent.last_interaction_time,
          }),
        );
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
          toast.success(
            `${data.claimed.length} agent(s) added to your library!`,
            {
              description: data.claimed
                .map((c: { name: string }) => c.name)
                .join(", "),
            },
          );
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
      (typeof agent.bio === "string" &&
        agent.bio.toLowerCase().includes(query)) ||
      (Array.isArray(agent.bio) &&
        agent.bio.some((b) => b.toLowerCase().includes(query))) ||
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
      return char.lastInteraction
        ? new Date(char.lastInteraction).getTime()
        : 0;
    };
    const timeDiff = getRecentTime(b) - getRecentTime(a);
    if (timeDiff !== 0) return timeDiff;
    return (a.name || "").localeCompare(b.name || "");
  });

  const handleCreateNew = useCallback(() => {
    navigate("/dashboard/containers");
  }, [navigate]);

  // Handler for removing saved agents from the list
  const handleRemoveSaved = useCallback((characterId: string) => {
    setCharacters((prev) => prev.filter((char) => char.id !== characterId));
  }, []);

  useSetPageHeader(
    {
      title: "My Agent",
      description: "Administer your running cloud agent",
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
        <AgentConsoleOverview
          agents={characters}
          onCreateNew={handleCreateNew}
        />

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
