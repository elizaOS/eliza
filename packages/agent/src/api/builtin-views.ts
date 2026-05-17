/**
 * Built-in view declarations for the core first-party shell pages.
 *
 * These views are part of the main shell bundle — no `bundlePath` and no
 * `bundleUrl` are needed. They are registered in the view registry so
 * GET /api/views returns them, the agent can discover and navigate to them
 * by name, and they appear in the view manager.
 */

import type { ViewDeclaration } from "@elizaos/core";

export const BUILTIN_VIEWS: ViewDeclaration[] = [
  {
    id: "chat",
    label: "Chat",
    description:
      "Conversations with your agent, inbound messages from every connector",
    icon: "MessageSquare",
    path: "/chat",
    order: 1,
    tags: ["messaging", "conversation", "agent"],
    visibleInManager: true,
    desktopTabEnabled: true,
    platforms: ["web", "desktop", "ios", "android"],
  },
  {
    id: "character",
    label: "Character",
    description: "Agent identity, personality, style, and knowledge documents",
    icon: "UserRound",
    path: "/character",
    order: 50,
    tags: ["identity", "personality", "character"],
    visibleInManager: true,
    desktopTabEnabled: true,
  },
  {
    id: "automations",
    label: "Automations",
    description: "Scheduled tasks and recurring workflows",
    icon: "Clock3",
    path: "/automations",
    order: 55,
    tags: ["automation", "tasks", "scheduling"],
    visibleInManager: true,
  },
  {
    id: "plugins-page",
    label: "Plugins",
    description: "Manage installed plugins, configure credentials",
    icon: "Puzzle",
    path: "/apps/plugins",
    order: 60,
    tags: ["plugins", "configuration", "extensions"],
    visibleInManager: true,
  },
  {
    id: "trajectories",
    label: "Trajectories",
    description: "Agent trajectory logs and training data",
    icon: "GitBranch",
    path: "/apps/trajectories",
    order: 70,
    tags: ["training", "logs", "trajectories"],
    developerOnly: true,
    visibleInManager: true,
  },
  {
    id: "memories",
    label: "Memories",
    description: "Agent memory viewer and management",
    icon: "Brain",
    path: "/apps/memories",
    order: 72,
    tags: ["memory", "knowledge"],
    developerOnly: true,
    visibleInManager: true,
  },
  {
    id: "database",
    label: "Database",
    description: "Raw database viewer and query interface",
    icon: "Database",
    path: "/apps/database",
    order: 80,
    tags: ["database", "data", "debug"],
    developerOnly: true,
    visibleInManager: true,
  },
  {
    id: "logs",
    label: "Logs",
    description: "Runtime logs and agent debug output",
    icon: "FileText",
    path: "/apps/logs",
    order: 81,
    tags: ["logs", "debug", "runtime"],
    developerOnly: true,
    visibleInManager: true,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Configuration, plugins, credentials, and preferences",
    icon: "Settings",
    path: "/settings",
    order: 90,
    tags: ["configuration", "preferences", "plugins"],
    visibleInManager: true,
    desktopTabEnabled: true,
  },
];
