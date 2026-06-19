/**
 * Real-browser e2e for the agent surface — no app server required.
 *
 * Bundles fixture.tsx with esbuild, loads it in headless chromium via
 * Playwright, drives the view purely through the agent capability bridge
 * (window.__agentSurface) the way the floating pill does, asserts the view
 * reacts, and captures aesthetic screenshots (rest + agent-highlight overlay).
 *
 * Run: bun run packages/ui/src/agent-surface/__e2e__/run-e2e.mjs
 * Exits non-zero on any failed assertion.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
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

// 1) Bundle the fixture into a self-contained IIFE.
const result = await build({
  entryPoints: [join(here, "fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>agent-surface e2e</title></head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "fixture.html");
await writeFile(htmlPath, html);

// 2) Drive it in a real browser through the capability bridge.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
  await page.goto(`file://${htmlPath}`);
  await page.waitForSelector("[data-agent-id='name']");

  // list-elements returns the registered, addressable controls.
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

  // agent-fill drives the controlled input.
  await page.evaluate(() =>
    window.__agentSurface("agent-fill", { id: "name", value: "Ada Lovelace" }),
  );
  assert(
    (await page.getByTestId("name-mirror").textContent())?.includes(
      "Ada Lovelace",
    ),
    "agent-fill updates the controlled input + view state",
  );

  // agent-click activates the button handler.
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

  // get-focus reflects agent-driven focus.
  await page.evaluate(() =>
    window.__agentSurface("agent-focus", { id: "name" }),
  );
  const focused = await page.evaluate(
    () => window.__agentSurface("get-focus").focusedId,
  );
  assert(
    focused === "name",
    `get-focus reports the focused element (${focused})`,
  );

  // Rest screenshot.
  await page.screenshot({ path: join(outDir, "agent-surface-rest.png") });

  // set-highlight draws the indicator overlay → aesthetic screenshot.
  await page.evaluate(() =>
    window.__agentSurface("set-highlight", { on: true }),
  );
  await page.waitForSelector("[data-agent-overlay] [data-agent-indicator]");
  const indicators = await page.locator("[data-agent-indicator]").count();
  assert(
    indicators >= 3,
    `indicator overlay highlights elements (${indicators})`,
  );
  await page.screenshot({ path: join(outDir, "agent-surface-highlight.png") });

  console.log(`\nScreenshots written to ${outDir}`);
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error("\nE2E FAILED");
  process.exit(1);
}
console.log("\nE2E PASSED");
