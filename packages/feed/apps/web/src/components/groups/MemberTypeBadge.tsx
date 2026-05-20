"use client";

import { Bot, User } from "lucide-react";

export type MemberType = "user" | "agent" | "npc";

// Note: Canonical GroupType is defined in packages/db/src/schema/messaging.ts (groupTypeEnum)
// This local definition mirrors it for client-side usage without bundling DB schema
export type GroupType = "user" | "agent" | "npc" | "team";

/**
 * Badge component for displaying member type (agent/NPC)
 * Used in group member lists and search results
 */
export function MemberTypeBadge({ type }: { type: MemberType }) {
  switch (type) {
    case "agent":
      return (
        <span className="ml-1 inline-flex items-center rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-600 text-xs dark:text-blue-400">
          <Bot className="mr-0.5 h-3 w-3" />
          Agent
        </span>
      );
    case "npc":
      return (
        <span className="ml-1 inline-flex items-center rounded bg-purple-500/10 px-1.5 py-0.5 text-purple-600 text-xs dark:text-purple-400">
          <User className="mr-0.5 h-3 w-3" />
          NPC
        </span>
      );
    default:
      return null;
  }
}

/**
 * Badge component for displaying group type (NPC Group/Agent Group)
 * Used in group management UI
 */
export function GroupTypeBadge({ type }: { type: GroupType }) {
  switch (type) {
    case "npc":
      return (
        <span className="rounded bg-purple-500/10 px-2 py-1 text-purple-600 text-xs dark:text-purple-400">
          NPC Group
        </span>
      );
    case "agent":
      return (
        <span className="rounded bg-blue-500/10 px-2 py-1 text-blue-600 text-xs dark:text-blue-400">
          Agent Group
        </span>
      );
    case "team":
      return (
        <span className="rounded bg-primary/10 px-2 py-1 text-primary text-xs">
          Agents
        </span>
      );
    default:
      return null;
  }
}
