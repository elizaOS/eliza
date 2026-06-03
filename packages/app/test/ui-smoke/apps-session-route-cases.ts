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

export const DIRECT_ROUTE_CASES: readonly DirectRouteCase[] = [
  {
    name: "companion",
    path: "/apps/companion",
    readyChecks: [
      { text: "Companion" },
      { selector: '[data-testid="companion-root"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "lifeops app window",
    path: "/apps/lifeops",
    readyChecks: [
      { text: "LifeOps" },
      { selector: '[data-testid="lifeops-nav-rail"]' },
    ],
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
    name: "model tester app window",
    path: "/apps/model-tester",
    readyChecks: [
      { selector: '[data-testid="model-tester-shell"]' },
      { text: "Model Tester" },
      { text: "Text" },
    ],
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
    name: "hyperliquid",
    path: "/hyperliquid",
    readyChecks: [
      { text: "Hyperliquid" },
      { selector: '[data-testid="hyperliquid-shell"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "polymarket",
    path: "/polymarket",
    readyChecks: [
      { text: "Polymarket" },
      { selector: '[data-testid="polymarket-shell"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "shopify",
    path: "/shopify",
    readyChecks: [
      { text: "Shopify" },
      { selector: '[data-testid="shopify-shell"]' },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "vincent",
    path: "/vincent",
    readyChecks: [
      { text: "Vincent" },
      { selector: '[data-testid="vincent-shell"]' },
    ],
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
    selector:
      '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
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
    name: "facewear app window",
    path: "/apps/hearwear",
    readyChecks: [{ text: "Facewear" }, { text: "No devices connected" }],
    timeoutMs: 90_000,
  },
  {
    name: "facewear tui app shell page",
    path: "/apps/hearwear/tui",
    readyChecks: [
      { text: "elizaos://facewear --type=tui" },
      { text: "connect-device" },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "smartglasses app window",
    path: "/apps/smartglasses",
    readyChecks: [{ text: "Smartglasses" }, { text: "Connect Headset" }],
    timeoutMs: 90_000,
  },
  {
    name: "smartglasses tui app shell page",
    path: "/apps/smartglasses/tui",
    readyChecks: [
      { text: "elizaos://smartglasses --type=tui" },
      { text: "connect-headset" },
    ],
    timeoutMs: 90_000,
  },
  {
    name: "orchestrator app shell page",
    path: "/orchestrator",
    selector: '[data-testid="orchestrator-workbench"]',
    timeoutMs: 90_000,
  },
  {
    name: "odysseus app shell page",
    path: "/odysseus",
    selector: '[data-testid="odysseus-shell"]',
    timeoutMs: 90_000,
  },
  {
    name: "orchestrator tui app shell page",
    path: "/orchestrator/tui",
    readyChecks: [
      { text: "elizaos://orchestrator --type=tui" },
      { text: "orchestrator-status" },
    ],
    timeoutMs: 90_000,
  },
];

const managerVisibleViewTileCases = [
  { viewId: "2004scape", path: "/2004scape" },
  { viewId: "clawville", path: "/clawville" },
  { viewId: "companion", path: "/companion" },
  { viewId: "contacts", path: "/contacts" },
  { viewId: "defense-of-the-agents", path: "/defense-of-the-agents" },
  { viewId: "facewear", path: "/apps/hearwear" },
  { viewId: "feed", path: "/feed" },
  { viewId: "hyperliquid", path: "/hyperliquid" },
  { viewId: "hyperscape", path: "/hyperscape" },
  { viewId: "lifeops", path: "/lifeops" },
  { viewId: "messages", path: "/messages" },
  { viewId: "model-tester", path: "/model-tester" },
  { viewId: "orchestrator", path: "/orchestrator" },
  { viewId: "phone", path: "/phone" },
  { viewId: "polymarket", path: "/polymarket" },
  { viewId: "scape", path: "/scape" },
  { viewId: "screenshare", path: "/screenshare" },
  { viewId: "shopify", path: "/shopify" },
  { viewId: "smartglasses", path: "/apps/smartglasses" },
  { viewId: "steward", path: "/steward" },
  { viewId: "task-coordinator", path: "/task-coordinator" },
  { viewId: "training", path: "/apps/fine-tuning" },
  { viewId: "trajectory-logger", path: "/trajectory-logger" },
  { viewId: "views-manager", path: "/views" },
  { viewId: "vincent", path: "/vincent" },
  { viewId: "wallet", path: "/wallet" },
  { viewId: "vector-browser", path: "/vector-browser" },
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
  { viewId: "companion", path: "/companion" },
  { viewId: "lifeops", path: "/lifeops" },
  { viewId: "model-tester", path: "/model-tester" },
].map(({ viewId, path }) => ({
  viewId,
  testId: viewCardTestId(viewId),
  name: `view tile ${viewId}`,
  expectedPath: path,
}));
