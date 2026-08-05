/**
 * Parse ClawdBrowser tools.md into a structured catalog.
 *
 * Source of truth: /Users/8bit/ClawdBrowser/tools.md
 * (generated from src/lib/sol-gpt/tool-catalog.ts)
 */

export type CatalogTool = {
  name: string;
  group: string;
  groupId: string;
  core: boolean;
  description: string;
};

export type CatalogGroup = {
  id: string;
  name: string;
  blurb: string;
  tools: CatalogTool[];
};

export type ClawdBrowserCatalog = {
  title: string;
  totalTools: number;
  coreCount: number;
  groups: CatalogGroup[];
  toolsByName: Map<string, CatalogTool>;
  coreToolNames: string[];
  sourcePath?: string;
  loadedAt: string;
};

const GROUP_HEADING = /^###\s+(.+?)\s*(?:\((\d+)\))?\s*$/;

const TOOL_ROW =
  /^\|\s*`([a-zA-Z0-9_]+)`\s*\|\s*(yes)?\s*\|\s*(.+?)\s*\|\s*$/;

const GROUP_ID_MAP: Record<string, string> = {
  "Phoenix Eternal": "phoenix",
  "Imperial router": "imperial",
  "Market data": "market",
  "OHLCV & live tape": "ohlcv",
  "Wallet & portfolio": "wallet",
  "Helius Wallet API": "helius",
  "Solana Tracker": "solanatracker",
  "Swaps & sends": "trading",
  "Prediction markets": "prediction",
  "Cloud browser": "browser",
  "Agents & DAS": "agents",
  Platform: "platform",
};

function slugGroup(name: string): string {
  return (
    GROUP_ID_MAP[name] ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/**
 * Parse the markdown catalog body into tools + groups.
 */
export function parseToolsMd(
  markdown: string,
  sourcePath?: string,
): ClawdBrowserCatalog {
  const lines = markdown.split(/\r?\n/);
  const groups: CatalogGroup[] = [];
  let current: CatalogGroup | null = null;
  let inCatalogSection = false;
  const coreToolNames: string[] = [];

  // Pass 1: core fenced names under "## Core tools"
  let capturingCore = false;
  let inFence = false;
  for (const line of lines) {
    if (/^##\s+Core tools/i.test(line)) {
      capturingCore = true;
      inFence = false;
      continue;
    }
    if (capturingCore && /^##\s+/.test(line)) {
      break;
    }
    if (capturingCore && line.trim() === "```") {
      if (!inFence) {
        inFence = true;
        continue;
      }
      break;
    }
    if (capturingCore && inFence) {
      const name = line.trim();
      if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        coreToolNames.push(name);
      }
    }
  }

  // Pass 2: group tables under "## Catalog by group"
  for (const line of lines) {
    if (/^##\s+Catalog by group/i.test(line)) {
      inCatalogSection = true;
      continue;
    }
    if (inCatalogSection && /^##\s+/.test(line) && !/^###\s+/.test(line)) {
      inCatalogSection = false;
      current = null;
      continue;
    }

    if (!inCatalogSection) continue;

    const gh = line.match(GROUP_HEADING);
    if (gh) {
      const name = gh[1]!.trim();
      current = {
        id: slugGroup(name),
        name,
        blurb: "",
        tools: [],
      };
      groups.push(current);
      continue;
    }
    if (current && /^>\s+/.test(line)) {
      current.blurb = line.replace(/^>\s+/, "").trim();
      continue;
    }
    if (current) {
      const row = line.match(TOOL_ROW);
      if (row) {
        current.tools.push({
          name: row[1]!,
          group: current.name,
          groupId: current.id,
          core: row[2] === "yes" || coreToolNames.includes(row[1]!),
          description: row[3]!.trim(),
        });
      }
    }
  }

  const toolsByName = new Map<string, CatalogTool>();
  for (const g of groups) {
    for (const t of g.tools) {
      if (coreToolNames.includes(t.name)) t.core = true;
      toolsByName.set(t.name, t);
    }
  }
  for (const name of coreToolNames) {
    if (!toolsByName.has(name)) {
      toolsByName.set(name, {
        name,
        group: "core",
        groupId: "core",
        core: true,
        description: "Core tool (listed in tools.md core set).",
      });
    }
  }

  const titleMatch = markdown.match(/^#\s+(.+)$/m);

  return {
    title: titleMatch?.[1]?.trim() || "SOL GPT tool catalog",
    totalTools: toolsByName.size,
    coreCount:
      coreToolNames.length ||
      [...toolsByName.values()].filter((t) => t.core).length,
    groups,
    toolsByName,
    coreToolNames,
    sourcePath,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Full-text search over tool names + descriptions + groups.
 */
export function searchCatalog(
  catalog: ClawdBrowserCatalog,
  query: string,
  limit = 20,
): CatalogTool[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ tool: CatalogTool; score: number }> = [];

  for (const tool of catalog.toolsByName.values()) {
    const hay =
      `${tool.name} ${tool.group} ${tool.groupId} ${tool.description}`.toLowerCase();
    let score = 0;
    if (tool.name.toLowerCase() === q) score += 100;
    if (tool.name.toLowerCase().includes(q)) score += 40;
    for (const tok of tokens) {
      if (tool.name.toLowerCase().includes(tok)) score += 15;
      if (hay.includes(tok)) score += 5;
    }
    if (score > 0) scored.push({ tool, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
  );
  return scored.slice(0, limit).map((s) => s.tool);
}

export function formatToolBrief(tool: CatalogTool): string {
  const core = tool.core ? " [core]" : "";
  return `• \`${tool.name}\`${core} (${tool.groupId}) — ${tool.description}`;
}

export function formatCatalogSummary(catalog: ClawdBrowserCatalog): string {
  const groupLines = catalog.groups
    .map((g) => `  - ${g.name} (\`${g.id}\`): ${g.tools.length} tools`)
    .join("\n");
  return [
    `${catalog.title}`,
    `Total tools: ${catalog.totalTools} · Core (Kimi first-turn): ${catalog.coreCount}`,
    `Source: ${catalog.sourcePath || "in-memory"}`,
    `Groups:`,
    groupLines || "  (none)",
    "",
    "Non-custodial: prepare_* tools return unsigned txs; user wallet signs.",
    "Actions: SEARCH_CLAWD_TOOLS, DESCRIBE_CLAWD_TOOL, LIST_CLAWD_TOOLS",
  ].join("\n");
}
