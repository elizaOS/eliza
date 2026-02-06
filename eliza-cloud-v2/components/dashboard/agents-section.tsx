/**
 * Agents section component displaying user's agents in a card grid layout.
 * Displays up to 4 agents on dashboard with a "View all" link if more exist.
 */

"use client";

import * as React from "react";
import { BrandButton } from "@/components/brand";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Plus, Info } from "lucide-react";
import Link from "next/link";
import { AgentCard } from "@/components/agents";
import type { DashboardAgentStats as AgentStats } from "@/lib/actions/dashboard";

interface Agent {
  id: string;
  name: string;
  bio: string | string[];
  avatarUrl: string | null;
  category: string | null;
  isPublic: boolean;
  username?: string | null;
  stats?: AgentStats;
}

interface AgentsSectionProps {
  agents: Agent[];
  className?: string;
}

export function AgentsSection({ agents, className }: AgentsSectionProps) {
  // Show max 4 agents on dashboard
  const displayAgents = agents.slice(0, 4);
  const hasMore = agents.length > 4;

  return (
    <div className={cn("space-y-4", className)}>
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/my-agents"
              className="text-xl font-semibold text-white transition-colors duration-200 hover:text-orange-500"
            >
              Agents
            </Link>
            <span className="text-base text-white/50">({agents.length})</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-white/40 hover:text-white/70 transition-colors"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="max-w-[180px] text-xs bg-zinc-900 text-white/80 border border-white/10"
              >
                Your AI characters. Chat, deploy, or integrate via API.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {hasMore && (
          <BrandButton
            variant="outline"
            asChild
            size="sm"
            className="h-8 text-xs"
          >
            <Link href="/dashboard/my-agents">View All</Link>
          </BrandButton>
        )}
      </div>

      {/* Agents Grid */}
      {agents.length === 0 ? (
        <AgentsEmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {displayAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={{
                id: agent.id,
                name: agent.name,
                bio: agent.bio,
                avatarUrl: agent.avatarUrl,
                username: agent.username,
                isPublic: agent.isPublic,
                stats: agent.stats,
              }}
              showDeploymentStatus
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Empty State
function AgentsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[160px] md:min-h-[240px] gap-4 bg-neutral-900 rounded-xl">
      <h3 className="text-lg font-medium text-neutral-500">No agents yet</h3>
      <BrandButton
        onClick={() => (window.location.href = "/dashboard/build")}
        className="h-9 md:h-10 bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
      >
        <Plus className="h-4 w-4" />
        Create Agent
      </BrandButton>
    </div>
  );
}

// Skeleton Loader
export function AgentsSectionSkeleton() {
  return (
    <div className="space-y-4">
      {/* Section Header Skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-20 bg-white/10 animate-pulse rounded" />
          <div className="h-5 w-8 bg-white/10 animate-pulse rounded" />
        </div>
        <div className="h-8 w-20 bg-white/10 animate-pulse rounded" />
      </div>

      {/* Agents Grid Skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...Array(4)].map((_, index) => (
          <div
            key={index}
            className="relative aspect-square w-full overflow-hidden rounded-xl bg-white/5"
          >
            {/* Top left badges skeleton */}
            <div className="absolute top-3 left-3 flex gap-1.5">
              <div className="h-4 w-4 bg-white/10 animate-pulse rounded" />
            </div>
            {/* Name and description skeleton */}
            <div className="absolute bottom-0 left-0 right-0 p-3 space-y-2">
              <div className="h-5 w-24 bg-white/10 animate-pulse rounded" />
              <div className="h-3 w-full bg-white/10 animate-pulse rounded" />
              <div className="h-3 w-2/3 bg-white/10 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
