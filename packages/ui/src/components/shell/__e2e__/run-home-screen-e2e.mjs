/**
 * Real-browser screenshot e2e for the iOS-style HomeScreen — no app server.
 * Bundles home-screen-fixture.tsx with esbuild (stubbing the data sources), loads
 * it in headless chromium, and asserts the clock / widgets / tiles render +
 * captures mobile + desktop screenshots.
 *
 * Run: bun run --cwd packages/ui test:home-screen-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-home");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Redirect the live data sources to deterministic stubs.
const stubResolver = {
  name: "home-stub-resolver",
  setup(b) {
    b.onResolve({ filter: /\/api$/ }, (a) =>
      a.importer.includes("HomeScreen")
        ? { path: join(here, "home-screen-fixture.api-stub.ts") }
        : undefined,
    );
    b.onResolve({ filter: /useActivityEvents$/ }, () => ({
      path: join(here, "home-screen-fixture.activity-stub.ts"),
    }));
    b.onResolve({ filter: /useDocumentVisibility$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
    }));
    b.onResolve({ filter: /useAvailableViews$/ }, () => ({
      path: join(here, "home-screen-fixture.views-stub.ts"),
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "home-screen-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubResolver],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>home screen e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16}
:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "home-screen.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sink = { errors: [] };
const browser = await chromium.launch();
let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}
try {
  // Mobile (Pixel-ish) — the primary target.
  const mobile = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
  });
  mobile.on("pageerror", (e) => sink.errors.push(String(e)));
  await mobile.goto(`${url}?native`);
  await mobile.waitForSelector('[data-testid="home-screen"]');
  await mobile.waitForTimeout(600);
  assert(
    (await mobile.getByTestId("home-clock").count()) === 0,
    "no clock (home kept minimal)",
  );
  assert(
    await mobile.getByTestId("home-widget-activity").isVisible(),
    "activity widget renders",
  );
  assert(
    await mobile.getByTestId("home-widget-messages").isVisible(),
    "messages widget renders",
  );
  assert(
    (await mobile.getByText("Shipped the chat-sheet redesign").count()) > 0,
    "activity items render",
  );
  assert(
    (await mobile.getByText("Alex Rivera").count()) > 0,
    "message threads render",
  );
  // No general quick-access tiles anymore — Home/Views/Settings moved to the
  // chat nav. The only tiles left are the AOSP native-OS surfaces, shown here
  // because the mobile page sets ?native (see HomeScreen.tsx HOME_TILES).
  for (const id of ["messages", "phone", "contacts", "camera"]) {
    assert(
      await mobile.getByTestId(`home-tile-${id}`).isVisible(),
      `native-OS tile ${id} renders (native enabled)`,
    );
  }
  // The removed defaults must NOT appear, even with native enabled.
  for (const id of ["tutorial", "help", "settings", "views"]) {
    assert(
      (await mobile.getByTestId(`home-tile-${id}`).count()) === 0,
      `removed default tile ${id} is gone`,
    );
  }
  await snap(mobile, "mobile-home");
  // The home is a clean, action-driven dashboard: no Edit chrome, no "Pinned"
  // label (edit-dashboard is an agent action, not a button).
  assert(
    (await mobile.getByTestId("home-edit-toggle").count()) === 0,
    "no Edit toggle (clean dashboard)",
  );
  assert(
    (await mobile.getByText("Pinned", { exact: true }).count()) === 0,
    'no "Pinned" label',
  );
  await mobile.close();

  // Desktop width
  const desktop = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  desktop.on("pageerror", (e) => sink.errors.push(String(e)));
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="home-screen"]');
  await desktop.waitForTimeout(500);
  // Off-AOSP: no pinned tiles at all — the tile grid is omitted entirely.
  assert(
    (await desktop.getByTestId("home-tiles").count()) === 0,
    "no pinned tiles off-AOSP (grid omitted)",
  );
  assert(
    (await desktop.getByTestId("home-tile-phone").count()) === 0,
    "phone tile hidden when native disabled",
  );
  await snap(desktop, "desktop-home");
  await desktop.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nHOME-SCREEN E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nHOME-SCREEN E2E PASSED");
