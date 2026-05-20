export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type DirectRouteCase =
  | {
      name: string;
      path: string;
      selector: string;
      timeoutMs?: number;
    }
  | {
      name: string;
      path: string;
      readyChecks: readonly (
        | { selector: string; text?: never }
        | { selector?: never; text: string }
      )[];
      timeoutMs?: number;
    };

export const DIRECT_ROUTE_CASES: readonly DirectRouteCase[] = [
  {
    name: "companion",
    path: "/apps/companion",
    readyChecks: [
      { selector: '[data-testid="companion-root"]' },
      { selector: '[data-testid="companion-chat-dock"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "lifeops app window",
    path: "/apps/lifeops",
    selector: '[data-testid="lifeops-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "plugins app window",
    path: "/apps/plugins",
    readyChecks: [{ text: "Browser Workspace" }, { text: "AI Providers" }],
    timeoutMs: 90_000,
  },
  {
    name: "skills app window",
    path: "/apps/skills",
    selector: '[data-testid="skills-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "fine tuning app window",
    path: "/apps/fine-tuning",
    selector: '[data-testid="fine-tuning-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "trajectories app window",
    path: "/apps/trajectories",
    selector: '[data-testid="trajectories-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "relationships app window",
    path: "/apps/relationships",
    selector: '[data-testid="relationships-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "memories app window",
    path: "/apps/memories",
    selector: '[data-testid="memory-viewer-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "inventory app window",
    path: "/apps/inventory",
    selector: '[data-testid="wallet-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "runtime app window",
    path: "/apps/runtime",
    selector: '[data-testid="runtime-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "database app window",
    path: "/apps/database",
    selector: '[data-testid="database-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "elizamaker app window",
    path: "/apps/elizamaker",
    selector: '[data-testid="chat-composer-textarea"]',
    timeoutMs: 90_000,
  },
  {
    name: "logs app window",
    path: "/apps/logs",
    selector: '[data-testid="logs-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "tasks app window",
    path: "/apps/tasks",
    selector: '[data-testid="tasks-view"]',
    timeoutMs: 90_000,
  },
];
