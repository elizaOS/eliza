export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const DIRECT_ROUTE_CASES = [
  {
    name: "lifeops",
    path: "/apps/lifeops",
    selector: '[data-testid="lifeops-shell"]',
  },
  {
    name: "tasks",
    path: "/apps/tasks",
    selector: '[data-testid="automations-shell"]',
  },
  {
    name: "plugins",
    path: "/apps/plugins",
    readyChecks: [{ text: "AI Providers" }, { text: "Other Features" }],
    timeoutMs: 60_000,
  },
  {
    name: "skills",
    path: "/apps/skills",
    selector: '[data-testid="skills-shell"]',
  },
  {
    name: "fine tuning",
    path: "/apps/fine-tuning",
    selector: '[data-testid="fine-tuning-view"]',
  },
  {
    name: "trajectories",
    path: "/apps/trajectories",
    selector: '[data-testid="trajectories-view"]',
  },
  {
    name: "relationships",
    path: "/apps/relationships",
    selector: '[data-testid="relationships-view"]',
  },
  {
    name: "memories",
    path: "/apps/memories",
    selector: '[data-testid="memory-viewer-view"]',
  },
  {
    name: "runtime",
    path: "/apps/runtime",
    readyChecks: [
      { selector: '[data-testid="runtime-view"]' },
      { selector: '[data-testid="runtime-sidebar"]' },
    ],
    timeoutMs: 15_000,
  },
  {
    name: "database",
    path: "/apps/database",
    selector: '[data-testid="database-view"]',
  },
  {
    name: "logs",
    path: "/apps/logs",
    selector: '[data-testid="logs-view"]',
  },
  {
    name: "inventory",
    path: "/apps/inventory",
    selector: '[data-testid="wallet-shell"]',
  },
  {
    name: "elizamaker",
    path: "/apps/elizamaker",
    selector: '[data-testid="chat-composer-textarea"]',
  },
  {
    name: "companion",
    path: "/apps/companion",
    selector: '[data-testid="companion-root"]',
    timeoutMs: 90_000,
  },
  {
    name: "shopify",
    path: "/apps/shopify",
    readyChecks: [
      { selector: '[data-testid="shopify-shell"]' },
      { text: "Connect your Shopify store" },
      { text: "Shopify" },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "vincent",
    path: "/apps/vincent",
    readyChecks: [
      { selector: '[data-testid="vincent-shell"]' },
      { text: "Connect your Vincent account to get started" },
      { text: "Vincent" },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "hyperliquid",
    path: "/apps/hyperliquid",
    selector: '[data-testid="hyperliquid-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "polymarket",
    path: "/apps/polymarket",
    selector: '[data-testid="polymarket-shell"]',
    timeoutMs: 90_000,
  },
] as const;
