/**
 * Real-browser screenshots for the #13535 agent-activity surfaces — no app
 * server. Bundles activity-feedback-fixture.tsx (the REAL TurnStatus working
 * indicator + the REAL ToolCallEventLog inline row) with esbuild, loads it in
 * headless Chromium via Playwright, waits for the elapsed clock to tick past its
 * 900ms grace, and captures desktop + mobile rest screenshots of the three turn
 * states (thinking / tool-running / settled). Exits non-zero on any page error.
 *
 * Run: bun run --cwd packages/ui test:activity-feedback-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-activity-feedback");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "activity-feedback-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);

// The components use the app's semantic token classes (text-primary, bg-bg/40,
// text-success, …). Map them to concrete colors via the Tailwind CDN config so
// the capture is faithful: primary is the brand orange (accent), success green,
// danger red — no blue anywhere.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>activity feedback</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { theme: { extend: { colors: {
    primary: "#f5842a", txt: "#f4f4f5", muted: "#a1a1aa",
    bg: "#0b0e17", border: "#2a2f3a",
    success: "#3fb57f", danger: "#e5624a",
  }, fontSize: { "xs-tight": ["11px", "16px"] } } } };
</script>
<style>html,body{margin:0;min-height:100%;background:#0b0e17;color:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "activity-feedback.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const errors = [];
const browser = await chromium.launch();

async function capture(name, viewport, deviceScaleFactor) {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('[data-testid="activity-feedback-fixture"]');
  // The three surfaces must actually render.
  const spinner = await page.getByTestId("turn-status-spinner").count();
  assert(spinner >= 2, `${name}: working-indicator spinners render (${spinner})`);
  const rows = await page.getByTestId("tool-call-event-log").count();
  assert(rows >= 2, `${name}: inline tool rows render (${rows})`);
  // Let the elapsed clock cross its 900ms grace so "Thinking · Ns" shows.
  await page.waitForTimeout(2600);
  const elapsed = await page.getByTestId("turn-status-elapsed").first().innerText();
  assert(/\d+s/.test(elapsed), `${name}: elapsed clock ticks (${elapsed.trim()})`);
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  console.log(`  📸 ${name}.png`);
  await page.close();
}

try {
  await capture("desktop", { width: 900, height: 1000 }, undefined);
  await capture("mobile", { width: 402, height: 900 }, 2);
} catch (err) {
  assert(false, `capture threw: ${err}`);
}

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

await browser.close();

if (failures > 0) {
  console.error(`\nACTIVITY FEEDBACK E2E FAILED (${failures})`);
  process.exit(1);
}
console.log(`\nACTIVITY FEEDBACK E2E PASSED → ${outDir}`);
process.exit(0);
