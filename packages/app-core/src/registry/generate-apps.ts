// One-off migration: hardcoded INTERNAL_TOOL_APPS + ELIZA_CURATED_APP_DEFINITIONS
// -> per-entry registry JSON files under data/apps/.
//
// After this runs, the registry is the SoT for these app definitions and
// internal-tool-apps.ts / the curated portion of ELIZA_CURATED_APP_DEFINITIONS
// can be deleted.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppEntry, registryEntrySchema } from "./schema";

interface InternalToolDef {
  id: string;
  npmName: string;
  displayName: string;
  description: string;
  targetTab: string;
  capabilities: string[];
  groupOrder: number;
  icon?: string;
  routePlugin?: {
    specifier: string;
    exportName?: string;
  };
}

const INTERNAL_TOOLS: InternalToolDef[] = [
  {
    id: "lifeops",
    npmName: "@elizaos/app-lifeops",
    displayName: "LifeOps",
    description:
      "Run tasks, reminders, calendar, inbox, and connected operational workflows.",
    targetTab: "lifeops",
    capabilities: ["lifeops", "tasks", "calendar", "gmail"],
    groupOrder: 0,
    icon: "Calendar",
    routePlugin: {
      specifier: "@elizaos/app-lifeops",
      exportName: "lifeopsPlugin",
    },
  },
  {
    id: "plugin-viewer",
    npmName: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    targetTab: "plugins",
    capabilities: ["plugins", "connectors", "viewer"],
    groupOrder: 1,
    icon: "Package",
  },
  {
    id: "skills-viewer",
    npmName: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    targetTab: "skills",
    capabilities: ["skills", "viewer"],
    groupOrder: 2,
    icon: "Wrench",
  },
  {
    id: "trajectory-viewer",
    npmName: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    targetTab: "trajectories",
    capabilities: ["trajectories", "debug", "viewer"],
    groupOrder: 3,
    icon: "TrendingDown",
  },
  {
    id: "relationship-viewer",
    npmName: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    description:
      "Explore cross-channel people, identities, and relationship graphs.",
    targetTab: "relationships",
    capabilities: ["relationships", "graph", "viewer"],
    groupOrder: 4,
    icon: "Link",
  },
  {
    id: "memory-viewer",
    npmName: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    targetTab: "memories",
    capabilities: ["memory", "facts", "viewer"],
    groupOrder: 5,
    icon: "Dna",
  },
  {
    id: "runtime-debugger",
    npmName: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    targetTab: "runtime",
    capabilities: ["runtime", "debug", "viewer"],
    groupOrder: 6,
    icon: "Settings",
  },
  {
    id: "database-viewer",
    npmName: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    targetTab: "database",
    capabilities: ["database", "sql", "viewer"],
    groupOrder: 7,
    icon: "Server",
  },
  {
    id: "log-viewer",
    npmName: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    description: "Search runtime and service logs.",
    targetTab: "logs",
    capabilities: ["logs", "debug", "viewer"],
    groupOrder: 8,
    icon: "FileText",
  },
];

interface CuratedDef {
  id: string;
  npmName: string;
  displayName: string;
  description: string;
  subtype: "game" | "tool" | "shell" | "marketplace" | "trading" | "other";
  launchType: "internal-tab" | "overlay" | "server-launch";
  target?: string;
  icon?: string;
  groupOrder: number;
  visible?: boolean;
  dependsOn?: string[];
  capabilities?: string[];
  routePlugin?: {
    specifier: string;
    exportName?: string;
  };
}

const CURATED_APPS: CuratedDef[] = [
  {
    id: "companion",
    npmName: "@elizaos/app-companion",
    displayName: "Companion",
    description: "The companion overlay shell for ambient agent presence.",
    subtype: "shell",
    launchType: "overlay",
    target: "companion",
    icon: "Bot",
    groupOrder: 0,
  },
  {
    id: "hyperscape",
    npmName: "@elizaos/app-hyperscape",
    displayName: "Hyperscape",
    description: "Multiplayer 3D world for embodied agent interactions.",
    subtype: "game",
    launchType: "server-launch",
    icon: "Gamepad2",
    groupOrder: 1,
  },
  {
    id: "babylon",
    npmName: "@elizaos/app-babylon",
    displayName: "Babylon",
    description: "Babylon.js scene host for embodied agents.",
    subtype: "game",
    launchType: "server-launch",
    icon: "Gamepad",
    groupOrder: 2,
  },
  {
    id: "2004scape",
    npmName: "@elizaos/app-2004scape",
    displayName: "2004scape",
    description: "Classic-era RuneScape-inspired multiplayer world.",
    subtype: "game",
    launchType: "server-launch",
    icon: "Gamepad2",
    groupOrder: 3,
  },
  {
    id: "defense-of-the-agents",
    npmName: "@elizaos/app-defense-of-the-agents",
    displayName: "Defense of the Agents",
    description: "MOBA-style arena for agent strategy and combat.",
    subtype: "game",
    launchType: "server-launch",
    icon: "Gamepad",
    groupOrder: 5,
  },
  {
    id: "vincent",
    npmName: "@elizaos/app-vincent",
    displayName: "Vincent",
    description:
      "Connect Vincent to trade on Hyperliquid and Polymarket through Vincent's agent.",
    subtype: "trading",
    launchType: "server-launch",
    icon: "Wallet",
    groupOrder: 6,
    dependsOn: ["wallet"],
    capabilities: ["vincent", "delegated-trading", "wallet"],
    routePlugin: {
      specifier: "@elizaos/app-vincent",
      exportName: "vincentPlugin",
    },
  },
  {
    id: "hyperliquid",
    npmName: "@elizaos/app-hyperliquid",
    displayName: "Hyperliquid",
    description:
      "Native Hyperliquid market, position, and order status for wallet trading.",
    subtype: "trading",
    launchType: "server-launch",
    icon: "ChartCandlestick",
    groupOrder: 7,
    dependsOn: ["wallet"],
    capabilities: ["hyperliquid", "trading", "wallet"],
    routePlugin: {
      specifier: "@elizaos/app-hyperliquid",
      exportName: "hyperliquidPlugin",
    },
  },
  {
    id: "app-polymarket",
    npmName: "@elizaos/app-polymarket",
    displayName: "Polymarket",
    description:
      "Native Polymarket market discovery and trading readiness for prediction markets.",
    subtype: "trading",
    launchType: "server-launch",
    icon: "Landmark",
    groupOrder: 8,
    dependsOn: ["wallet"],
    capabilities: ["polymarket", "prediction-markets", "trading", "wallet"],
    routePlugin: {
      specifier: "@elizaos/app-polymarket",
      exportName: "polymarketPlugin",
    },
  },
  {
    id: "shopify",
    npmName: "@elizaos/app-shopify",
    displayName: "Shopify",
    description: "Storefront and admin tools for agent-driven commerce.",
    subtype: "marketplace",
    launchType: "server-launch",
    icon: "Briefcase",
    groupOrder: 9,
    routePlugin: {
      specifier: "@elizaos/app-shopify",
      exportName: "shopifyPlugin",
    },
  },
  {
    id: "steward",
    npmName: "@elizaos/app-steward",
    displayName: "Steward",
    description:
      "Wallet management, browser wallet bridge, and trade approval routes.",
    subtype: "trading",
    launchType: "server-launch",
    icon: "Wallet",
    groupOrder: 100,
    visible: false,
    routePlugin: {
      specifier: "@elizaos/app-steward",
      exportName: "stewardPlugin",
    },
  },
  {
    id: "clawville",
    npmName: "@elizaos/app-clawville",
    displayName: "ClawVille",
    description:
      "Sea-themed agent world with skill-learning buildings, NPC chat, and Solana wallet identity.",
    subtype: "game",
    launchType: "server-launch",
    icon: "Gamepad2",
    groupOrder: 8,
  },
];

function buildInternal(def: InternalToolDef): AppEntry {
  return {
    id: def.id,
    kind: "app",
    subtype: "tool",
    name: def.displayName,
    description: def.description,
    npmName: def.npmName,
    source: "bundled",
    tags: def.capabilities,
    config: {},
    render: {
      visible: true,
      pinTo: [],
      style: "card",
      icon: def.icon,
      group: "Apps",
      groupOrder: def.groupOrder,
      actions: ["launch"],
    },
    resources: {},
    dependsOn: [],
    launch: {
      type: "internal-tab",
      target: def.targetTab,
      capabilities: def.capabilities,
      routePlugin: def.routePlugin,
    },
  };
}

function buildCurated(def: CuratedDef): AppEntry {
  return {
    id: def.id,
    kind: "app",
    subtype: def.subtype,
    name: def.displayName,
    description: def.description,
    npmName: def.npmName,
    source: "bundled",
    tags: [],
    config: {},
    render: {
      visible: def.visible ?? true,
      pinTo: [],
      style: def.launchType === "overlay" ? "card" : "hero-card",
      icon: def.icon,
      group: "Curated",
      groupOrder: def.groupOrder,
      actions: def.visible === false ? [] : ["launch", "configure"],
    },
    resources: {},
    dependsOn: def.dependsOn ?? [],
    launch: {
      type: def.launchType,
      target: def.target,
      capabilities: def.capabilities ?? [],
      curatedSlug: def.id,
      routePlugin: def.routePlugin,
    },
  };
}

function main(): void {
  const outDir = join(
    process.cwd(),
    "eliza/packages/app-core/src/registry/entries/apps",
  );
  mkdirSync(outDir, { recursive: true });

  let count = 0;
  let errors = 0;

  for (const def of INTERNAL_TOOLS) {
    const entry = buildInternal(def);
    const parsed = registryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      errors += 1;
      console.error(`✗ ${def.id}:`, parsed.error.issues[0]);
      continue;
    }
    writeFileSync(
      join(outDir, `${def.id}.json`),
      `${JSON.stringify(parsed.data, null, 2)}\n`,
    );
    count += 1;
  }

  for (const def of CURATED_APPS) {
    const entry = buildCurated(def);
    const parsed = registryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      errors += 1;
      console.error(`✗ ${def.id}:`, parsed.error.issues[0]);
      continue;
    }
    writeFileSync(
      join(outDir, `${def.id}.json`),
      `${JSON.stringify(parsed.data, null, 2)}\n`,
    );
    count += 1;
  }

  console.log(`Generated ${count} app entries (${errors} errors).`);
  if (errors > 0) process.exit(1);
}

main();
