/**
 * Real-browser e2e for the agent surface — no app server required.
 *
 * Bundles a fixture with esbuild, loads it in headless chromium via Playwright,
 * drives the view purely through the agent capability bridge
 * (window.__agentSurface) the way the floating pill does, asserts the view
 * reacts, and captures aesthetic screenshots.
 *
 * Two targets run in sequence:
 *   1. `fixture` (default) — the synthetic fixture's own controls.
 *   2. `real-view` — REAL components from @elizaos/plugin-task-coordinator
 *      (TaskCard / BackChip / TaskSearchInput) mounted in the host
 *      AgentSurfaceProvider. Their `useAgentElement` calls resolve to the same
 *      `@elizaos/ui/agent-surface` registry singleton as the host, so the bridge
 *      discovers and drives real plugin source — list-elements → agent-click /
 *      agent-fill → state change — exactly as DynamicViewLoader does in-app.
 *
 * Run: bun run packages/ui/src/agent-surface/__e2e__/run-e2e.mjs
 * Exits non-zero on any failed assertion.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, "..");
const repoRoot = resolve(here, "../../../../..");
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

/**
 * Bundle one fixture into a self-contained IIFE HTML page. `alias` lets a real
 * plugin view + the host both resolve `@elizaos/ui/agent-surface` to the same
 * local source so they share the registry singleton (mirrors the host-external
 * singleton in packages/scripts/view-bundle-vite.config.ts, but bundled-in for
 * a hermetic no-server e2e).
 */
async function bundleFixture(name, entry, alias) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias,
    write: false,
  });
  const js = result.outputFiles[0].text;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>agent-surface e2e — ${name}</title></head><body><div id="root"></div><script>${js}</script></body></html>`;
  const htmlPath = join(outDir, `${name}.html`);
  await writeFile(htmlPath, html);
  return htmlPath;
}

// ── Target 1: synthetic fixture ──────────────────────────────────────────────
async function driveSyntheticFixture(browser) {
  console.log("\n── target: fixture (synthetic) ──");
  const htmlPath = await bundleFixture("fixture", join(here, "fixture.tsx"));
  const page = await browser.newPage({
    viewport: { width: 720, height: 520 },
  });
  try {
    await page.goto(`file://${htmlPath}`);
    await page.waitForSelector("[data-agent-id='name']");

    const ids = await page.evaluate(() =>
      window
        .__agentSurface("list-elements")
        .map((e) => e.id)
        .sort(),
    );
    assert(
      ["increment", "name", "status-online"].every((id) => ids.includes(id)),
      `list-elements exposes the view's controls: ${ids.join(", ")}`,
    );

    await page.evaluate(() =>
      window.__agentSurface("agent-fill", {
        id: "name",
        value: "Ada Lovelace",
      }),
    );
    assert(
      (await page.getByTestId("name-mirror").textContent())?.includes(
        "Ada Lovelace",
      ),
      "agent-fill updates the controlled input + view state",
    );

    await page.evaluate(() =>
      window.__agentSurface("agent-click", { id: "increment" }),
    );
    await page.evaluate(() =>
      window.__agentSurface("agent-click", { id: "increment" }),
    );
    assert(
      (await page.getByTestId("count-mirror").textContent()) === "count=2",
      "agent-click activates the button (count=2)",
    );

    await page.evaluate(() =>
      window.__agentSurface("agent-focus", { id: "name" }),
    );
    const focused = await page.evaluate(
      () => window.__agentSurface("get-focus").focusedId,
    );
    assert(focused === "name", `get-focus reports the focused element (${focused})`);

    await page.screenshot({ path: join(outDir, "agent-surface-rest.png") });

    await page.evaluate(() =>
      window.__agentSurface("set-highlight", { on: true }),
    );
    await page.waitForSelector("[data-agent-overlay] [data-agent-indicator]");
    const indicators = await page.locator("[data-agent-indicator]").count();
    assert(
      indicators >= 3,
      `indicator overlay highlights elements (${indicators})`,
    );
    await page.screenshot({
      path: join(outDir, "agent-surface-highlight.png"),
    });
  } finally {
    await page.close();
  }
}

// ── Target 2: real plugin view (plugin-task-coordinator) ─────────────────────
async function driveRealView(browser) {
  console.log("\n── target: real-view (@elizaos/plugin-task-coordinator) ──");
  const htmlPath = await bundleFixture(
    "real-view",
    join(here, "real-view-fixture.tsx"),
    {
      // Resolve the plugin view to source so we drive the real component, and
      // resolve its `@elizaos/ui/agent-surface` import to the local
      // `useAgentElement` source (all TaskCardList needs). It transitively pulls
      // the same AgentSurfaceContext + registry modules the host imports
      // relatively → one shared registry singleton, no app-server, no heavy
      // barrel (the full agent-surface index would drag node-only transitive deps
      // into the browser bundle).
      "@elizaos/plugin-task-coordinator/TaskCardList": join(
        repoRoot,
        "plugins/plugin-task-coordinator/src/TaskCardList.tsx",
      ),
      "@elizaos/ui/agent-surface": join(uiSrc, "useAgentElement.ts"),
    },
  );
  const page = await browser.newPage({
    viewport: { width: 720, height: 600 },
  });
  try {
    await page.goto(`file://${htmlPath}`);
    // The real TaskCard registers `task-card-abc`; wait for the registry to bind.
    await page.waitForSelector("[data-agent-id='task-card-abc']");

    const ids = await page.evaluate(() =>
      window
        .__agentSurface("list-elements")
        .map((e) => e.id)
        .sort(),
    );
    assert(
      ["task-back-chip", "task-card-abc", "task-search"].every((id) =>
        ids.includes(id),
      ),
      `real view exposes its controls via list-elements: ${ids.join(", ")}`,
    );

    // agent-fill drives the real TaskSearchInput.
    await page.evaluate(() =>
      window.__agentSurface("agent-fill", {
        id: "task-search",
        value: "ship audit",
      }),
    );
    assert(
      (await page.getByTestId("query-mirror").textContent())?.includes(
        "ship audit",
      ),
      "agent-fill updates the real TaskSearchInput's view state",
    );

    // agent-click activates the real TaskCard's onOpen handler.
    await page.evaluate(() =>
      window.__agentSurface("agent-click", { id: "task-card-abc" }),
    );
    assert(
      (await page.getByTestId("opened-mirror").textContent()) === "opened=abc",
      "agent-click activates the real TaskCard (opened=abc)",
    );

    // agent-click the real BackChip button.
    await page.evaluate(() =>
      window.__agentSurface("agent-click", { id: "task-back-chip" }),
    );
    assert(
      (await page.getByTestId("back-mirror").textContent()) === "back=1",
      "agent-click activates the real BackChip (back=1)",
    );

    await page.screenshot({ path: join(outDir, "agent-surface-real-view.png") });
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await driveSyntheticFixture(browser);
  await driveRealView(browser);
  console.log(`\nScreenshots written to ${outDir}`);
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error("\nE2E FAILED");
  process.exit(1);
}
console.log("\nE2E PASSED");
