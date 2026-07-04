"use client";

/**
 * The My Agents surface: lists the user's cloud agent instances with sort/view
 * controls and the create entry point.
 */
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { DashboardPageContainer, useSetPageHeader } from "@elizaos/ui/cloud-ui";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { useT } from "../lib/i18n";
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
    titleKey: "cloud.myAgents.sectionRuntime",
    defaultTitle: "Runtime",
    descriptionKey: "cloud.myAgents.sectionRuntimeDesc",
    defaultDescription:
      "Monitor the hosted process, logs, health, and deployments.",
    to: "/dashboard/agents",
    icon: Server,
  },
  {
    titleKey: "cloud.myAgents.sectionApiKeys",
    defaultTitle: "API keys",
    descriptionKey: "cloud.myAgents.sectionApiKeysDesc",
    defaultDescription: "Create and rotate keys for programmatic access.",
    to: "/dashboard/api-keys",
    icon: KeyRound,
  },
  {
    titleKey: "cloud.myAgents.sectionBilling",
    defaultTitle: "Billing",
    descriptionKey: "cloud.myAgents.sectionBillingDesc",
    defaultDescription: "Review credits, payment methods, and usage controls.",
    to: "/settings#cloud-billing",
    icon: CreditCard,
  },
  {
    titleKey: "cloud.myAgents.sectionAppDevices",
    defaultTitle: "App devices",
    descriptionKey: "cloud.myAgents.sectionAppDevicesDesc",
    defaultDescription: "Manage connected apps and device-facing integrations.",
    to: "/dashboard/apps",
    icon: MonitorSmartphone,
  },
  {
    titleKey: "cloud.myAgents.sectionDocs",
    defaultTitle: "Docs",
    descriptionKey: "cloud.myAgents.sectionDocsDesc",
    defaultDescription: "Read setup guides, APIs, MCP, apps, and runtime docs.",
    to: "https://docs.elizaos.ai/cloud",
    icon: BookOpen,
    external: true,
  },
] as const;

function getAgentChatPath(agent: AgentWithOwnership | null): string {
  if (!agent) return "/dashboard/agents";
  return agent.username ? `/chat/@${agent.username}` : `/chat/${agent.id}`;
}

function AgentConsoleOverview({
  agents,
  onCreateNew,
}: {
  agents: AgentWithOwnership[];
  onCreateNew: () => void;
}) {
  const t = useT();
  const ownedAgents = agents.filter((agent) => agent.isOwned !== false);
  const primaryAgent = ownedAgents[0] ?? agents[0] ?? null;
  const runningCount = ownedAgents.filter(
    (agent) => agent.stats?.deploymentStatus === "deployed",
  ).length;
  const chatPath = getAgentChatPath(primaryAgent);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
      <div className="border border-white/10 bg-black p-5">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FF5800]">
              {t("cloud.myAgents.agentConsole", {
                defaultValue: "Agent console",
              })}
            </p>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-white md:text-3xl">
                {t("cloud.myAgents.heading", {
                  defaultValue: "Administer and enter your running agent",
                })}
              </h1>
              <p className="text-sm leading-6 text-white/60">
                {t("cloud.myAgents.subheading", {
                  defaultValue:
                    "Use this page as the control room for your hosted Eliza agent: open the live chat, inspect runtime state, manage API access, connect app devices, and keep billing in view.",
                })}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:flex-col">
            <Link
              to={chatPath}
              className="inline-flex h-10 items-center justify-center gap-2 bg-[#FF5800] px-4 text-sm font-medium text-black transition-colors hover:bg-[#e54f00]"
            >
              <MessageCircle className="h-4 w-4" />
              {primaryAgent
                ? t("cloud.myAgents.openAgentChat", {
                    defaultValue: "Open agent chat",
                  })
                : t("cloud.myAgents.goToMyAgent", {
                    defaultValue: "Go to my agent",
                  })}
            </Link>
            <Button
              variant="ghost"
              type="button"
              onClick={onCreateNew}
              className="inline-flex h-10 items-center justify-center gap-2 border border-white/10 bg-black px-4 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Server className="h-4 w-4" />
              {t("cloud.myAgents.runtimeAdmin", {
                defaultValue: "Runtime admin",
              })}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-px border border-white/10 bg-white/5 sm:grid-cols-3">
          <div className="bg-black p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.myAgents.ownedAgents", {
                defaultValue: "Owned agents",
              })}
            </p>
            <p className="mt-1 text-2xl font-semibold text-white tabular-nums">
              {ownedAgents.length}
            </p>
          </div>
          <div className="bg-black p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.myAgents.running", { defaultValue: "Running" })}
            </p>
            <p className="mt-1 text-2xl font-semibold text-white tabular-nums">
              {runningCount}
            </p>
          </div>
          <div className="bg-black p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
              {t("cloud.myAgents.chatTarget", { defaultValue: "Chat target" })}
            </p>
            <p className="mt-1 truncate text-sm font-medium text-white">
              {primaryAgent?.name ??
                t("cloud.myAgents.createOrDeploy", {
                  defaultValue: "Create or deploy an agent",
                })}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {ADMIN_SECTIONS.map((section) => {
          const Icon = section.icon;
          const sectionClassName =
            "group flex items-start gap-3 bg-black p-4 transition-colors hover:bg-white/5";
          const sectionInner = (
            <>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/10 bg-black text-[#FF5800]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-white">
                    {t(section.titleKey, {
                      defaultValue: section.defaultTitle,
                    })}
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-white/30 transition-colors group-hover:text-white" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-white/55">
                  {t(section.descriptionKey, {
                    defaultValue: section.defaultDescription,
                  })}
                </span>
              </span>
            </>
          );
          if ("external" in section && section.external) {
            return (
              <a
                key={section.titleKey}
                href={section.to}
                target="_blank"
                rel="noreferrer"
                className={sectionClassName}
              >
                {sectionInner}
              </a>
            );
          }
          return (
            <Link
              key={section.titleKey}
              to={section.to}
              className={sectionClassName}
            >
              {sectionInner}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * My Agent client component — agent listing, filtering, and management.
 * Fetches both owned and saved agents client-side to enable real-time updates.
 */
export function MyAgentsClient() {
  const t = useT();
  const navigate = useNavigate();
  const claimAttempted = useRef(false);
  const [characters, setCharacters] = useState<AgentWithOwnership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortBy, setSortBy] = useState<SortOption>("modified");

  const fetchCharacters = useCallback(async () => {
    try {
      const [ownedResponse, savedResponse] = await Promise.all([
        fetch("/api/my-agents/characters"),
        fetch("/api/my-agents/saved"),
      ]);

      let ownedAgents: AgentWithOwnership[] = [];
      let ownedFetchFailed = false;
      if (ownedResponse.ok) {
        const ownedText = await ownedResponse.text();
        const ownedResult = ownedText ? JSON.parse(ownedText) : {};
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

      let savedAgents: AgentWithOwnership[] = [];
      if (savedResponse.ok) {
        const savedText = await savedResponse.text();
        const savedResult = savedText ? JSON.parse(savedText) : {};
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
        logger.error("[MyAgents] Failed to fetch saved agents");
      }

      if (ownedFetchFailed) {
        toast.error(
          t("cloud.myAgents.loadFailed", {
            defaultValue: "Failed to load your agents",
          }),
        );
      }

      setCharacters([...ownedAgents, ...savedAgents]);
    } catch (error) {
      logger.error("[MyAgents] Failed to fetch characters:", error);
      toast.error("Failed to load your agents");
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCharacters();

    const handleUpdate = () => fetchCharacters();
    window.addEventListener("characters-updated", handleUpdate);
    return () => window.removeEventListener("characters-updated", handleUpdate);
  }, [fetchCharacters]);

  // Claim any affiliate characters the user has interacted with.
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
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text ? JSON.parse(text) : { success: false };
      })
      .then((data) => {
        if (data.success && data.claimed?.length > 0) {
          toast.success(
            t("cloud.myAgents.agentsAdded", {
              count: data.claimed.length,
              defaultValue: "{{count}} agent(s) added to your library!",
            }),
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
              // Ignore cleanup errors.
            }
          }
        }
      })
      .catch((error) => {
        logger.error("[MyAgents] Failed to claim affiliate characters:", error);
      });
  }, [fetchCharacters, t]);

  const filteredCharacters = useMemo(
    () =>
      characters.filter((char) => {
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
          agent.topics?.some((topic: string) =>
            topic.toLowerCase().includes(query),
          ) ||
          agent.adjectives?.some((a: string) => a.toLowerCase().includes(query))
        );
      }),
    [characters, searchQuery],
  );

  const sortedCharacters = useMemo(
    () =>
      [...filteredCharacters].sort((a, b) => {
        if (sortBy === "name") {
          return (a.name || "").localeCompare(b.name || "");
        }
        if (sortBy === "created") {
          const getCreatedTime = (char: AgentWithOwnership): number =>
            char.created_at ? new Date(char.created_at).getTime() : 0;
          const timeDiff = getCreatedTime(b) - getCreatedTime(a);
          if (timeDiff !== 0) return timeDiff;
          return (a.name || "").localeCompare(b.name || "");
        }
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
      }),
    [filteredCharacters, sortBy],
  );

  const handleCreateNew = useCallback(() => {
    navigate("/dashboard/agents");
  }, [navigate]);

  const handleRemoveSaved = useCallback((characterId: string) => {
    setCharacters((prev) => prev.filter((char) => char.id !== characterId));
  }, []);

  useSetPageHeader(
    {
      title: t("cloud.myAgents.pageTitle", { defaultValue: "My Agent" }),
      description: t("cloud.myAgents.pageDescription", {
        defaultValue: "Administer your running cloud agent",
      }),
    },
    [t],
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
