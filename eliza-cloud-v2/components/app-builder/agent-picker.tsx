"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Bot, Check, Plus, Search, X, Sparkles, Users } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface Agent {
  id: string;
  name: string;
  username?: string | null;
  avatar_url?: string | null;
  bio?: string | string[];
  is_public?: boolean;
}

interface AgentPickerProps {
  agents: Agent[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  maxSelection?: number;
  className?: string;
  loading?: boolean;
}

/**
 * AgentPicker - Beautiful multi-select agent picker
 * Allows selecting up to maxSelection (default 4) AI agents for an app
 */
export function AgentPicker({
  agents,
  selectedIds,
  onSelectionChange,
  maxSelection = 4,
  className,
  loading = false,
}: AgentPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter agents based on search
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const query = searchQuery.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(query) ||
        agent.username?.toLowerCase().includes(query) ||
        (typeof agent.bio === "string" &&
          agent.bio.toLowerCase().includes(query)),
    );
  }, [agents, searchQuery]);

  // Get selected agents in order
  const selectedAgents = useMemo(() => {
    return selectedIds
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean) as Agent[];
  }, [selectedIds, agents]);

  const toggleAgent = (agentId: string) => {
    if (selectedIds.includes(agentId)) {
      // Remove agent
      onSelectionChange(selectedIds.filter((id) => id !== agentId));
    } else if (selectedIds.length < maxSelection) {
      // Add agent
      onSelectionChange([...selectedIds, agentId]);
    }
  };

  const removeAgent = (agentId: string) => {
    onSelectionChange(selectedIds.filter((id) => id !== agentId));
  };

  const getBioPreview = (bio: string | string[] | undefined): string => {
    if (!bio) return "No description";
    const text = Array.isArray(bio) ? bio[0] : bio;
    return text.length > 80 ? text.slice(0, 77) + "..." : text;
  };

  if (loading) {
    return (
      <div className={cn("space-y-3 md:space-y-4", className)}>
        <div className="animate-pulse space-y-2 md:space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 md:h-20 bg-white/5 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3 md:space-y-4", className)}>
      {/* Header with selection count */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 md:gap-2">
          <div className="p-1.5 md:p-2 rounded-xl bg-white/5 border border-white/10">
            <Users className="h-3.5 w-3.5 md:h-4 md:w-4 text-white/60" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-white">App Agents</h3>
            <p className="text-[11px] md:text-xs text-white/50">
              Select up to {maxSelection} AI agents
            </p>
          </div>
        </div>
        <div className="px-2 py-0.5 md:px-2.5 md:py-1 rounded-xl bg-white/5 border border-white/10">
          <span className="text-[11px] md:text-xs font-mono text-white/60">
            {selectedIds.length}/{maxSelection}
          </span>
        </div>
      </div>

      {/* Selected Agents Pills */}
      {selectedAgents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 md:gap-2">
          {selectedAgents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-1 md:gap-1.5 pl-0.5 pr-0.5 py-0.5 md:pl-1 md:pr-1 md:py-1 rounded-full bg-[#FF5800]/20 border border-[#FF5800]/30 transition-all duration-300"
            >
              {agent.avatar_url ? (
                <Image
                  src={agent.avatar_url}
                  alt={agent.name}
                  width={20}
                  height={20}
                  className="rounded-full object-cover w-4 h-4 md:w-5 md:h-5"
                />
              ) : (
                <div className="w-4 h-4 md:w-5 md:h-5 rounded-full bg-white/10 flex items-center justify-center">
                  <Bot className="h-2.5 w-2.5 md:h-3 md:w-3 text-white/60" />
                </div>
              )}
              <span className="text-[11px] md:text-xs font-medium text-white">
                {agent.name}
              </span>
              <button
                onClick={() => removeAgent(agent.id)}
                className="w-4 h-4 md:w-5 md:h-5 rounded-full hover:bg-white/10 transition-colors flex items-center justify-center"
              >
                <X className="h-2.5 w-2.5 md:h-3 md:w-3 text-white/70 hover:text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <div className="flex items-center gap-1.5 md:gap-2 px-2.5 py-2 md:px-3 md:py-2.5 rounded-xl border border-white/10 bg-black/40 transition-all duration-300 focus-within:border-white/20">
          <Search className="h-3.5 w-3.5 md:h-4 md:w-4 text-white/30 flex-shrink-0" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search agents..."
            className="flex-1 bg-transparent text-[13px] md:text-sm text-white placeholder:text-white/30 focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="p-1 rounded-lg hover:bg-white/10 transition-colors"
            >
              <X className="h-3 w-3 md:h-3.5 md:w-3.5 text-white/40 hover:text-white/60" />
            </button>
          )}
        </div>
      </div>

      {/* Agent Grid */}
      <ScrollArea className="h-[240px] md:h-[300px] pr-2 md:pr-3">
        <div className="grid gap-1.5 md:gap-2">
          {filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 md:py-8 text-center">
              <div className="p-2 md:p-3 rounded-xl bg-white/5 border border-white/10 mb-2 md:mb-3">
                <Bot className="h-5 w-5 md:h-6 md:w-6 text-white/30" />
              </div>
              <p className="text-[13px] md:text-sm text-white/50">
                {searchQuery
                  ? "No agents match your search"
                  : "No agents available"}
              </p>
              <p className="text-[11px] md:text-xs text-white/40 mt-1">
                Create agents in the Build tab first
              </p>
            </div>
          ) : (
            filteredAgents.map((agent) => {
              const isSelected = selectedIds.includes(agent.id);
              const isDisabled =
                !isSelected && selectedIds.length >= maxSelection;

              return (
                <button
                  key={agent.id}
                  onClick={() => !isDisabled && toggleAgent(agent.id)}
                  disabled={isDisabled}
                  className={cn(
                    "group relative flex items-start gap-2 md:gap-3 p-2 md:p-3 rounded-xl text-left transition-all duration-300",
                    "border touch-manipulation",
                    isSelected
                      ? "border-[#FF5800]/50 bg-[#FF5800]/10"
                      : isDisabled
                        ? "bg-white/[0.02] border-white/5 opacity-50 cursor-not-allowed"
                        : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/[0.07]",
                  )}
                >
                  {/* Avatar */}
                  <div className="relative flex-shrink-0">
                    {agent.avatar_url ? (
                      <Image
                        src={agent.avatar_url}
                        alt={agent.name}
                        width={44}
                        height={44}
                        className="rounded-xl object-cover w-9 h-9 md:w-11 md:h-11"
                      />
                    ) : (
                      <div className="w-9 h-9 md:w-11 md:h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
                        <Bot className="h-4 w-4 md:h-5 md:w-5 text-white/60" />
                      </div>
                    )}
                    {agent.is_public && (
                      <div className="absolute -top-1 -right-1 p-0.5 rounded-full bg-green-500/20 border border-green-500/30">
                        <Sparkles className="h-2 w-2 md:h-2.5 md:w-2.5 text-green-400" />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 md:gap-2">
                      <span className="font-medium text-[13px] md:text-sm text-white truncate">
                        {agent.name}
                      </span>
                      {agent.username && (
                        <span className="text-[11px] md:text-xs text-white/40 truncate">
                          @{agent.username}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] md:text-xs text-white/50 mt-0.5 line-clamp-2">
                      {getBioPreview(agent.bio)}
                    </p>
                  </div>

                  {/* Selection indicator */}
                  <div
                    className={cn(
                      "flex-shrink-0 w-4 h-4 md:w-5 md:h-5 rounded-lg flex items-center justify-center transition-all duration-300",
                      isSelected
                        ? "bg-[#FF5800]"
                        : "border border-white/20 group-hover:border-white/30",
                    )}
                  >
                    {isSelected && (
                      <Check
                        className="h-2.5 w-2.5 md:h-3 md:w-3 text-white"
                        strokeWidth={3}
                      />
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Helper text */}
      <p className="text-[11px] md:text-xs text-white/40 text-center pt-1.5 md:pt-2">
        Agents accessible via SDK
      </p>
    </div>
  );
}

/**
 * CompactAgentPicker - Smaller version for inline use
 */
export function CompactAgentPicker({
  agents,
  selectedIds,
  onSelectionChange,
  maxSelection = 4,
}: AgentPickerProps) {
  const selectedAgents = useMemo(() => {
    return selectedIds
      .map((id) => agents.find((a) => a.id === id))
      .filter(Boolean) as Agent[];
  }, [selectedIds, agents]);

  const availableAgents = useMemo(() => {
    return agents.filter((a) => !selectedIds.includes(a.id));
  }, [agents, selectedIds]);

  const addAgent = (agentId: string) => {
    if (selectedIds.length < maxSelection) {
      onSelectionChange([...selectedIds, agentId]);
    }
  };

  const removeAgent = (agentId: string) => {
    onSelectionChange(selectedIds.filter((id) => id !== agentId));
  };

  return (
    <div className="space-y-3">
      {/* Selected */}
      <div className="flex flex-wrap gap-2">
        {selectedAgents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20"
          >
            {agent.avatar_url ? (
              <Image
                src={agent.avatar_url}
                alt={agent.name}
                width={20}
                height={20}
                className="rounded-full object-cover"
              />
            ) : (
              <Bot className="h-4 w-4 text-violet-400" />
            )}
            <span className="text-xs font-medium text-white">{agent.name}</span>
            <button
              onClick={() => removeAgent(agent.id)}
              className="p-0.5 rounded hover:bg-white/10"
            >
              <X className="h-3 w-3 text-white/50" />
            </button>
          </div>
        ))}

        {/* Add button */}
        {selectedIds.length < maxSelection && availableAgents.length > 0 && (
          <select
            onChange={(e) => {
              if (e.target.value) {
                addAgent(e.target.value);
                e.target.value = "";
              }
            }}
            className="px-2 py-1.5 rounded-lg bg-white/5 border border-dashed border-white/20 text-xs text-white/60 cursor-pointer hover:border-white/40 transition-colors"
          >
            <option value="">+ Add agent</option>
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedIds.length === 0 && (
        <p className="text-xs text-white/40">No agents selected</p>
      )}
    </div>
  );
}

export default AgentPicker;
