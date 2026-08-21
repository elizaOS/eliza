/**
 * Route-case fixtures for apps-session UI-smoke coverage across direct and
 * shell navigation paths.
 */
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
      readyChecks: readonly ReadyCheck[];
      timeoutMs?: number;
    };

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

/**
 * A ViewManager tile the click-safe smoke test exercises. Each case maps to a
 * `view-card-<viewId>` rendered by ViewManagerPage from GET /api/views; clicking
 * it must navigate to the view's declared `path` without console failures.
 */
export type SafeViewTileCase = {
  viewId: string;
  testId: string;
  name: string;
  expectedPath: string;
};

function viewCardTestId(viewId: string): string {
  return `view-card-${viewId}`;
}

function launcherTileTestId(viewId: string): string {
  return `launcher-tile-${viewId}`;
}

export const DIRECT_ROUTE_CASES: readonly DirectRouteCase[] = [
  {
    // Retired My Apps slug (#17031): resolves to the consolidated Projects
    // surface with its Apps segment pre-selected.
    name: "my-apps compat deep link",
    path: "/apps/my-apps",
    readyChecks: [
      { text: "Projects" },
      { selector: '[data-testid="projects-apps-segment"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "plugins app window",
    path: "/apps/plugins",
    // A content check, not the shell container: [data-testid="plugins-shell"]
    // is the unconditional top-level frame of PluginsView, so it appears the
    // instant the component mounts and the route would pass on an empty or
    // failed catalog. "AI Providers" is a live group label
    // (plugin-list-utils.ts:759), so it only renders once data actually loaded.
    readyChecks: [{ text: "AI Providers" }],
    timeoutMs: 90_000,
  },
  {
    name: "skills app window",
    path: "/apps/skills",
    selector: '[data-testid="skills-shell"]',
    timeoutMs: 90_000,
  },
  {
    // Retired bare My Apps route (#17031): same consolidated Projects surface,
    // Apps segment pre-selected with the app-management copy visible.
    name: "bare /apps compat deep link",
    path: "/apps",
    readyChecks: [{ text: "Projects" }, { text: "Install, create, and run" }],
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
    name: "live meeting app window",
    path: "/apps/transcripts",
    selector: '[data-testid="live-meeting-page"]',
    timeoutMs: 90_000,
  },
  {
    name: "inventory app window",
    path: "/apps/inventory",
    selector: '[data-testid="wallet-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "wallet app shell page",
    path: "/inventory",
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
    name: "files app window",
    path: "/apps/files",
    selector: '[data-testid="files-view"]',
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
  {
    name: "phone companion app shell page",
    path: "/phone-companion",
    readyChecks: [{ text: "Eliza" }, { text: "Pair" }],
    timeoutMs: 90_000,
  },
  {
    name: "orchestrator app shell page",
    path: "/orchestrator",
    selector: '[data-testid="orchestrator-workbench"]',
    timeoutMs: 90_000,
  },
  {
    name: "notes app shell page",
    path: "/notes",
    selector: '[data-testid="simple-notes-view"]',
    timeoutMs: 90_000,
  },
  {
    name: "maps app shell page",
    path: "/maps",
    selector: '[data-testid="maps-view"]',
    timeoutMs: 90_000,
  },
  {
    // Pinned home tile → Settings.
    name: "settings view",
    path: "/settings",
    selector: '[data-testid="settings-shell"]',
    timeoutMs: 90_000,
  },
  {
    // Pinned home tile → Workflows (live inside the Automations feed).
    name: "automations / workflows view",
    path: "/automations",
    selector: '[data-testid="automations-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "background view",
    path: "/background",
    selector: 'button[aria-label="Upload a background image"]',
    timeoutMs: 90_000,
  },
];

const managerVisibleViewTileCases = [
  { viewId: "calendar", path: "/calendar" },
  { viewId: "cloud", path: "/cloud" },
  { viewId: "computer-use-sessions", path: "/computer-use-sessions" },
  { viewId: "contacts", path: "/contacts" },
  { viewId: "cockpit", path: "/cockpit" },
  { viewId: "document-library", path: "/documents" },
  { viewId: "finances", path: "/finances" },
  { viewId: "focus", path: "/focus" },
  { viewId: "goals", path: "/goals" },
  { viewId: "health", path: "/health" },
  { viewId: "inbox", path: "/inbox" },
  { viewId: "messages", path: "/messages" },
  { viewId: "maps", path: "/maps" },
  { viewId: "orchestrator", path: "/orchestrator" },
  { viewId: "cloud", path: "/cloud" },
  { viewId: "phone", path: "/phone" },
  { viewId: "relationships", path: "/relationships" },
  { viewId: "notes", path: "/notes" },
  { viewId: "task-coordinator", path: "/task-coordinator" },
  { viewId: "todos", path: "/todos" },
  { viewId: "trajectory-logger", path: "/trajectory-logger" },
  { viewId: "views-manager", path: "/views" },
  { viewId: "wallet", path: "/wallet" },
];

/**
 * The View Manager (`/apps`) is the user-facing launcher. This full static list
 * mirrors every manager-visible GUI view declared by plugin manifests; the
 * route-coverage gate keeps it in sync.
 */
export const MANAGER_VISIBLE_VIEW_TILE_CASES: readonly SafeViewTileCase[] =
  managerVisibleViewTileCases.map(({ viewId, path }) => ({
    viewId,
    testId: viewCardTestId(viewId),
    name: `view tile ${viewId}`,
    expectedPath: path,
  }));

/**
 * Browser click-safe subset. The full dynamic-view matrix is covered by
 * plugin-views-visual; this suite samples representative View Manager tiles
 * without turning all-pages click safety into a long game/app bootstrap loop.
 */
export const SAFE_VIEW_TILE_CASES: readonly SafeViewTileCase[] = [
  { viewId: "notes", path: "/notes" },
].map(({ viewId, path }) => ({
  viewId,
  testId: launcherTileTestId(viewId),
  name: `launcher tile ${viewId}`,
  expectedPath: path,
}));
