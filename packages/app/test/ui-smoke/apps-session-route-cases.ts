export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type DirectRouteCase =
  | {
      name: string;
      path: string;
      selector: string;
      catalogAppName?: string;
      tileExpectedPath?: string;
      tileReadyChecks?: readonly ReadyCheck[];
      timeoutMs?: number;
    }
  | {
      name: string;
      path: string;
      readyChecks: readonly ReadyCheck[];
      catalogAppName?: string;
      tileExpectedPath?: string;
      tileReadyChecks?: readonly ReadyCheck[];
      timeoutMs?: number;
    };

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

export type SafeAppTileCase = {
  appName: string;
  testId: string;
  name: string;
  expectedPath: string;
  readyChecks: readonly ReadyCheck[];
};

function appCardTestId(appName: string): string {
  return `app-card-${appName.replace(/[^a-z0-9]+/gi, "-")}`;
}

function readyChecksForRoute(
  routeCase: DirectRouteCase,
): readonly ReadyCheck[] {
  if ("readyChecks" in routeCase) return routeCase.readyChecks;
  return [{ selector: routeCase.selector }];
}

export const DIRECT_ROUTE_CASES: readonly DirectRouteCase[] = [
  {
    name: "companion",
    path: "/apps/companion",
    catalogAppName: "@elizaos/plugin-companion",
    readyChecks: [
      { selector: '[data-testid="companion-root"]' },
      { selector: '[data-testid="companion-chat-dock"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "lifeops app window",
    path: "/apps/lifeops",
    catalogAppName: "@elizaos/plugin-lifeops",
    selector: '[data-testid="lifeops-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "plugins app window",
    path: "/apps/plugins",
    catalogAppName: "@elizaos/app-plugin-viewer",
    readyChecks: [{ text: "Browser Workspace" }, { text: "AI Providers" }],
    timeoutMs: 90_000,
  },
  {
    name: "skills app window",
    path: "/apps/skills",
    catalogAppName: "@elizaos/app-skills-viewer",
    selector: '[data-testid="skills-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "fine tuning app window",
    path: "/apps/fine-tuning",
    catalogAppName: "@elizaos/plugin-training",
    tileExpectedPath: "/apps/fine-tuning/details",
    tileReadyChecks: [{ selector: '[data-testid="app-launch-panel"]' }],
    selector: '[data-testid="fine-tuning-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "trajectories app window",
    path: "/apps/trajectories",
    catalogAppName: "@elizaos/app-trajectory-viewer",
    selector: '[data-testid="trajectories-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "relationships app window",
    path: "/apps/relationships",
    catalogAppName: "@elizaos/app-relationship-viewer",
    selector: '[data-testid="relationships-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "memories app window",
    path: "/apps/memories",
    catalogAppName: "@elizaos/app-memory-viewer",
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
    catalogAppName: "@elizaos/app-runtime-debugger",
    selector: '[data-testid="runtime-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "database app window",
    path: "/apps/database",
    catalogAppName: "@elizaos/app-database-viewer",
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
    catalogAppName: "@elizaos/app-log-viewer",
    selector: '[data-testid="logs-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "tasks app window",
    path: "/apps/tasks",
    selector: '[data-testid="tasks-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "facewear app window",
    path: "/apps/hearwear",
    readyChecks: [{ text: "Facewear" }, { text: "No devices connected" }],
    timeoutMs: 90_000,
  },
  {
    name: "smartglasses app window",
    path: "/apps/smartglasses",
    readyChecks: [{ text: "Smartglasses" }, { text: "Connect Headset" }],
    timeoutMs: 90_000,
  },
];

export const SAFE_APP_TILE_CASES: readonly SafeAppTileCase[] =
  DIRECT_ROUTE_CASES.flatMap((routeCase) => {
    if (!routeCase.catalogAppName) return [];
    const expectedPath = routeCase.tileExpectedPath ?? routeCase.path;
    return [
      {
        appName: routeCase.catalogAppName,
        testId: appCardTestId(routeCase.catalogAppName),
        name: `app tile ${routeCase.name}`,
        expectedPath,
        readyChecks:
          routeCase.tileReadyChecks ?? readyChecksForRoute(routeCase),
      },
    ];
  });
