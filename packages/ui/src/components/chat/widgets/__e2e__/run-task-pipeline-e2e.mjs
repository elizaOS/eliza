/**
 * Real-browser render pass for the inline task-activity pipeline (#13536).
 * Bundles the fixture with esbuild (single React copy), loads it in headless
 * chromium, and screenshots the grouped task → sub-agent → step tree at desktop
 * and mobile widths — asserting the nested sub-agents, in-place tool steps, live
 * plan checklist, workflow pipeline, and standalone checklist all render with a
 * clean console. This is the rendered-pixel half: the fixture mounts the real
 * pipeline components on the exact `SubagentActivity`/plan shapes the store
 * produces. The WS stream → those shapes seam is proven separately (real
 * `client.deliverWsMessageForTest` → `bindWs`) in `task-activity-store.test.ts`.
 *
 * Run: bun run --cwd packages/ui test:task-pipeline-e2e
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ChatWidgetShell reads only the i18n function through the app-state selector.
// Keep this screenshot fixture static/presentational instead of booting the
// full AppProvider and its transport/agent side effects.
const stubAppState = {
  name: "stub-app-state",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/state$/ }, (args) => ({
      path: args.path,
      namespace: "app-state-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "app-state-stub" }, () => ({
      contents: `
        const state = {
          t: (key, options) => options?.defaultValue ?? key,
        };
        export const useAppSelector = (selector) => selector(state);
        export const useAppSelectorShallow = (selector) => selector(state);
      `,
      loader: "js",
    }));
  },
};

// Map the brand tokens the widgets use (text-ok/bg-card/border-border/…) so the
// render is faithful; the Tailwind CDN supplies the layout/animation utilities.
const css = `
:root{color-scheme:dark}
body{background:#0b0b0c;color:#e8e8e8;font:13px/1.45 system-ui,sans-serif;margin:0}
.text-txt{color:#ededed}.text-txt\\/80{color:#edededcc}.text-txt\\/70{color:#ededed;opacity:.7}
.text-muted{color:#9aa0a6}
.text-muted\\/40{color:#9aa0a666}.text-muted\\/50{color:#9aa0a680}.text-muted\\/60{color:#9aa0a699}
.text-ok{color:#34d399}.text-danger{color:#f87171}.text-warn{color:#fbbf24}
.text-accent{color:#ff7a1a}.text-accent-hover{color:#e56a10}
.bg-card{background:#161619}.bg-bg{background:#101014}.bg-bg-hover{background:#1f1f24}
.border,.border-t,.border-l{border-style:solid;border-width:0}
.border{border-width:1px}.border-t{border-top-width:1px}.border-l{border-left-width:1px}
.border-border{border-color:#33333a}
.rounded-sm{border-radius:6px}.rounded-none{border-radius:0}
.tabular-nums{font-variant-numeric:tabular-nums}
.line-through{text-decoration:line-through}
`;
const url = await writeFixturePage({
  entry: join(here, "task-pipeline-fixture.tsx"),
  outDir,
  htmlName: "task-pipeline.html",
  title: "task pipeline e2e",
  plugins: [stubAppState, stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  headHtml: `<style>${css}</style>`,
});

const sink = { errors: [] };
const browser = await chromium.launch();
try {
  const p = await browser.newPage({
    viewport: { width: 900, height: 1000 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => sink.errors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") sink.errors.push(`[console.error] ${m.text()}`);
  });
  await p.goto(url);
  await p.waitForSelector('[data-testid="task-pipeline-fixture"]', {
    timeout: 15_000,
  });
  await p.waitForSelector('[data-testid="subagent-block"]', { timeout: 10_000 });
  await p.waitForTimeout(300);
  await p.screenshot({
    path: join(outDir, "task-pipeline-desktop.png"),
    fullPage: true,
  });
  console.log("  📸 task-pipeline-desktop.png");

  assert(
    (await p.getByText("Ship the planner loop").count()) > 0,
    "task card header renders the task title",
  );
  assert(
    (await p.locator('[data-testid="subagent-block"]').count()) === 2,
    "both sub-agents render (builder + nested reviewer)",
  );
  assert(
    (await p.locator('[data-session-id="reviewer-2c8b"]').count()) > 0,
    "the nested reviewer child session renders",
  );
  assert(
    (await p.locator('[data-testid="plan-checklist"]').count()) > 0,
    "the live plan checklist renders inside the card",
  );
  assert(
    (await p.getByText("turn-controller.ts").count()) > 0,
    "tool-call steps render with their input preview",
  );
  assert(
    (await p.locator('[data-testid="workflow-steps"]').count()) > 0,
    "the [WORKFLOW] step pipeline renders",
  );
  assert(
    (await p.getByText("Migration").count()) > 0,
    "the standalone [CHECKLIST] renders",
  );

  // Mobile viewport — the pipeline must stay readable narrow.
  await p.setViewportSize({ width: 390, height: 900 });
  await p.waitForTimeout(300);
  await p.screenshot({
    path: join(outDir, "task-pipeline-mobile.png"),
    fullPage: true,
  });
  console.log("  📸 task-pipeline-mobile.png");
  assert(
    (await p.locator('[data-testid="subagent-block"]').count()) === 2,
    "sub-agents still render at mobile width",
  );

  await p.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `clean console (${sink.errors.length} errors)`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots written to ${outDir}`);
if (failures > 0) {
  console.error(`\nTASK PIPELINE E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nTASK PIPELINE E2E PASSED");
