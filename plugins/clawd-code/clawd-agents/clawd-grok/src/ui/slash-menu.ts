export interface SlashMenuItem {
  id: string;
  label: string;
  description: string;
  aliases?: string[];
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { id: "exit", label: "exit", description: "Quit the CLI" },
  { id: "help", label: "help", description: "Show available commands" },
  { id: "remote-control", label: "remote-control", description: "Remote control" },
  { id: "agents", label: "agents", description: "Manage custom sub-agents" },
  { id: "schedule", label: "schedule", description: "View scheduled runs" },
  { id: "mcp", label: "mcp", description: "Manage MCP servers" },
  { id: "sandbox", label: "sandbox", description: "Select shell sandbox mode" },
  { id: "wallet", label: "wallet", description: "Wallet and payment settings" },
  { id: "models", label: "models", description: "Select a model", aliases: ["model", "mode"] },
  { id: "recaps", label: "recaps", description: "Turn session recaps on/off", aliases: ["recap", "summary"] },
  { id: "new", label: "new session", description: "Start a new session" },
  { id: "commit-push", label: "commit & push", description: "Commit and push" },
  { id: "commit-pr", label: "commit & pr", description: "Commit and open PR" },
  { id: "review", label: "review", description: "Review recent changes" },
  { id: "verify", label: "verify", description: "Run local verification" },
  { id: "skills", label: "skills", description: "Manage skills" },
  { id: "btw", label: "btw", description: "Ask a side question without interrupting" },
  { id: "update", label: "update", description: "Update grok to the latest version" },
];

export function filterSlashMenuItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const normalized = normalizeSlashSearchQuery(query);
  if (!normalized) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreSlashMenuItem(item, normalized) }))
    .filter((entry) => entry.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

function normalizeSlashSearchQuery(query: string): string {
  return query.trim().replace(/^\/+/, "").toLowerCase();
}

function scoreSlashMenuItem(item: SlashMenuItem, query: string): number {
  const commandFields = [item.id, item.label, ...(item.aliases ?? [])].flatMap(tokenizeSearchText);
  const descriptionFields = tokenizeSearchText(item.description);

  const commandScore = scoreFields(commandFields, query, 0);
  const descriptionScore = scoreFields(descriptionFields, query, 3);
  return Math.min(commandScore, descriptionScore);
}

function scoreFields(fields: string[], query: string, offset: number): number {
  for (const field of fields) {
    if (field === query || `/${field}` === query) return offset;
  }
  for (const field of fields) {
    if (field.startsWith(query) || `/${field}`.startsWith(query)) return offset + 1;
  }
  for (const field of fields) {
    if (field.includes(query) || `/${field}`.includes(query)) return offset + 2;
  }
  return Number.POSITIVE_INFINITY;
}

function tokenizeSearchText(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return [normalized, ...tokens];
}
