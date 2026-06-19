/**
 * Real-browser screenshot of the redesigned orchestrator dashboard cards.
 * Bundles dashboard-fixture.tsx with esbuild (stubbing the agent-surface hook),
 * loads it in headless chromium with the brand palette wired into Tailwind, and
 * captures the populated + empty states at desktop + mobile.
 *
 * Run: bun run plugins/plugin-task-coordinator/src/__e2e__/run-dashboard-shot.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "dashboard-shots");
await mkdir(outDir, { recursive: true });

// Stub the agent-surface hook (a virtual module, nothing written to src) so the
// pure card components mount without a provider — it is provider-optional anyway.
const stub = {
  name: "agent-surface-stub",
  setup(b) {
    b.onResolve({ filter: /agent-surface$/ }, () => ({
      path: "agent-surface-stub",
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export function useAgentElement(){return {ref:()=>{},agentProps:{}};}",
      loader: "ts",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "dashboard-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stub],
  write: false,
});
const js = result.outputFiles[0].text;

// Brand palette (dark theme) wired so Tailwind opacity modifiers (bg-ok/12,
// text-muted/70, …) resolve against real values.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>orchestrator dashboard</title>
<script>
window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: { extend: { colors: {
    bg: "#07090e", "bg-accent": "#10131b", "bg-hover": "#1a1e28",
    surface: "#161a23", card: "#0c0f16",
    txt: "#f4f5f7", "txt-strong": "#ffffff",
    muted: "#9aa0ad", "muted-strong": "#c3c8d2", border: "#272b36",
    accent: "#ff5800", "accent-subtle": "rgba(255,88,0,0.14)",
    ok: "#4ade80", warn: "#ff8a3d", danger: "#f87171", info: "#5b9dff",
  } } },
};
</script>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#07090e}
.text-2xs{font-size:.6875rem;line-height:1rem}.text-xs-tight{font-size:.75rem;line-height:1.1rem}
/* Brand palette injected explicitly so it survives whichever Tailwind the CDN
   serves (v4 ignores the JS color config). Source order wins. */
.text-txt{color:#f4f5f7}.text-txt-strong{color:#fff}
.text-muted{color:#9aa0ad}.text-muted\\/70{color:rgba(154,160,173,.7)}.text-muted\\/80{color:rgba(154,160,173,.8)}
.text-accent{color:#ff5800}.text-ok{color:#4ade80}.text-warn{color:#ff8a3d}.text-danger{color:#f87171}
.bg-bg{background-color:#07090e}.bg-surface{background-color:#161a23}
.bg-bg-accent\\/20{background-color:rgba(255,255,255,.025)}.bg-bg-hover\\/50{background-color:rgba(255,255,255,.05)}
.bg-accent-subtle{background-color:rgba(255,88,0,.14)}
.bg-accent{background-color:#ff5800}.bg-ok{background-color:#4ade80}.bg-warn{background-color:#ff8a3d}.bg-danger{background-color:#f87171}.bg-muted{background-color:#9aa0ad}
.bg-ok\\/12{background-color:rgba(74,222,128,.12)}.bg-warn\\/12{background-color:rgba(255,138,61,.12)}.bg-danger\\/12{background-color:rgba(248,113,113,.12)}.bg-accent\\/12{background-color:rgba(255,88,0,.12)}
.ring-1{box-shadow:0 0 0 1px var(--tw-ring-color,transparent)}
.ring-accent\\/25{--tw-ring-color:rgba(255,88,0,.25)}.ring-ok\\/25{--tw-ring-color:rgba(74,222,128,.25)}.ring-warn\\/25{--tw-ring-color:rgba(255,138,61,.25)}.ring-danger\\/25{--tw-ring-color:rgba(248,113,113,.25)}.ring-border{--tw-ring-color:#272b36}
</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "dashboard.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const errors = [];
try {
  const desktop = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
  });
  desktop.on("pageerror", (e) => errors.push(String(e)));
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="dashboard-fixture"]');
  await desktop.waitForTimeout(500);
  assert(
    (await desktop.getByTestId("task-card").count()) === 5,
    "5 task cards render",
  );
  assert(
    (await desktop.getByText("Refactor the auth pipeline").count()) > 0,
    "task titles render",
  );
  await desktop.screenshot({ path: join(outDir, "01-dashboard-desktop.png") });
  console.log("  📸 01-dashboard-desktop.png");

  await desktop.goto(`${url}?empty`);
  await desktop.waitForSelector('[data-testid="task-empty-state"]');
  await desktop.waitForTimeout(300);
  await desktop.screenshot({ path: join(outDir, "02-empty-desktop.png") });
  console.log("  📸 02-empty-desktop.png");
  await desktop.close();

  const mobile = await browser.newPage({
    viewport: { width: 402, height: 900 },
    deviceScaleFactor: 2,
  });
  mobile.on("pageerror", (e) => errors.push(String(e)));
  await mobile.goto(url);
  await mobile.waitForSelector('[data-testid="dashboard-fixture"]');
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: join(outDir, "03-dashboard-mobile.png") });
  console.log("  📸 03-dashboard-mobile.png");
  await mobile.close();
} finally {
  await browser.close();
}

assert(errors.length === 0, `no page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);
console.log(`\nScreenshots → ${outDir}`);
if (failures > 0) {
  console.error(`\nDASHBOARD SHOT FAILED (${failures})`);
  process.exit(1);
}
console.log("\nDASHBOARD SHOT PASSED");
