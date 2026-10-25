/**
 * Real-browser render pass for OrchestratorAccountsView (the coding-accounts +
 * per-room roster sidebar widget). Bundles the fixture with esbuild (single
 * React copy), loads it in headless chromium, screenshots all four visual
 * states, and asserts the key content renders with a clean console. The same
 * states are exposed as Storybook stories (agent-orchestrator.stories.tsx) for
 * interactive, brand-faithful visual review.
 *
 * Run: bun run --cwd packages/ui test:orchestrator-accounts-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const result = await build({
  entryPoints: [join(here, "orchestrator-accounts-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;

// Minimal legibility CSS — the project's brand tokens (text-txt/bg-bg/…) need
// the bundled stylesheet, which Storybook loads for the faithful view; here we
// map the few used utilities so the render is readable for the smoke shot.
const css = `
:root{color-scheme:dark}
body{background:#0b0b0c;color:#e8e8e8;font:13px/1.45 system-ui,sans-serif;margin:0}
.text-txt{color:#ededed}.font-medium{font-weight:600}
.text-muted{color:#a0a0a8}
.text-muted\\/70{color:#a0a0a8b3}.text-muted\\/60{color:#a0a0a899}.text-muted\\/50{color:#a0a0a880}
.text-ok{color:#34d399}
.bg-bg\\/40{background:#15151a99}
.bg-muted\\/15{background:#a0a0a826}.bg-muted\\/10{background:#a0a0a81a}
.bg-ok\\/15{background:#34d39926}
.border,.border-t,.border-b{border-style:solid;border-width:1px}
.border-border\\/40,.border-t{border-color:#33333a99}
.rounded-lg{border-radius:8px}.rounded-full{border-radius:999px}
.uppercase{text-transform:uppercase}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tabular-nums{font-variant-numeric:tabular-nums}
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>orchestrator accounts e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "orchestrator-accounts.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sink = { errors: [] };
const browser = await chromium.launch();
try {
  const p = await browser.newPage({
    viewport: { width: 1320, height: 900 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => sink.errors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") sink.errors.push(`[console.error] ${m.text()}`);
  });
  await p.goto(url);
  await p.waitForSelector('[data-testid="orchestrator-accounts-fixture"]', {
    timeout: 15_000,
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(outDir, "orchestrator-accounts.png") });
  console.log("  📸 orchestrator-accounts.png");

  // Empty state.
  assert(
    await p.getByText("No coding subscriptions connected.").isVisible(),
    "empty state renders the connect prompt",
  );
  // Accounts + usage.
  assert(
    (await p.getByText("Claude — Work").count()) > 0,
    "account rows render (Claude — Work)",
  );
  assert(
    (await p.getByText("Codex — Main").count()) > 0,
    "account rows render (Codex — Main)",
  );
  assert(
    (await p.getByText("least-used").count()) > 0,
    "selection strategy chip renders",
  );
  // Room roster: the section + the three participant kinds.
  assert(
    (await p.locator('[data-testid="orchestrator-room-roster"]').count()) > 0,
    "room roster section renders",
  );
  assert(
    (await p.getByText("Task rooms").count()) > 0,
    "room roster heading renders",
  );
  assert(
    (await p.getByText("Orchestrator").count()) > 0,
    "orchestrator participant row renders",
  );
  assert(
    (await p.getByText("Ada (claude)").count()) > 0,
    "sub-agent participant row renders with account",
  );
  assert(
    (await p.getByText("2 agents").count()) > 0,
    "multi-party badge renders",
  );
  await p.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `clean console (${sink.errors.length} errors)`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshot written to ${outDir}`);
if (failures > 0) {
  console.error(`\nORCHESTRATOR ACCOUNTS E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nORCHESTRATOR ACCOUNTS E2E PASSED");
