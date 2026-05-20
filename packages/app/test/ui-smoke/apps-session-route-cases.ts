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
    name: "lifeops app window",
    path: "/apps/lifeops?appWindow=1",
    selector: '[data-testid="lifeops-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "plugins app window",
    path: "/apps/plugins?appWindow=1",
    readyChecks: [{ text: "Browser Workspace" }, { text: "AI Providers" }],
    timeoutMs: 90_000,
  },
  {
    name: "skills app window",
    path: "/apps/skills?appWindow=1",
    selector: '[data-testid="skills-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "fine tuning app window",
    path: "/apps/fine-tuning?appWindow=1",
    selector: '[data-testid="fine-tuning-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "trajectories app window",
    path: "/apps/trajectories?appWindow=1",
    selector: '[data-testid="trajectories-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "relationships app window",
    path: "/apps/relationships?appWindow=1",
    selector: '[data-testid="relationships-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "memories app window",
    path: "/apps/memories?appWindow=1",
    selector: '[data-testid="memory-viewer-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "inventory app window",
    path: "/apps/inventory?appWindow=1",
    selector: '[data-testid="wallet-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "runtime app window",
    path: "/apps/runtime?appWindow=1",
    selector: '[data-testid="runtime-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "database app window",
    path: "/apps/database?appWindow=1",
    selector: '[data-testid="database-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "elizamaker app window",
    path: "/apps/elizamaker?appWindow=1",
    selector: '[data-testid="chat-composer-textarea"]',
    timeoutMs: 90_000,
  },
  {
    name: "logs app window",
    path: "/apps/logs?appWindow=1",
    selector: '[data-testid="logs-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "tasks app window",
    path: "/apps/tasks?appWindow=1",
    selector: '[data-testid="tasks-view"]',
    timeoutMs: 90_000,
  },
];
