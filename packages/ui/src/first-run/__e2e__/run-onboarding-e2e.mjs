/**
 * Real-browser screenshot pass for the onboarding (CompactOnboarding) — no app
 * server. Bundles onboarding-fixture.tsx with esbuild (stubbing the first-run
 * controller), loads it in headless chromium, and screenshots every onboarding
 * state (desktop + mobile) so the copy/icons can be reviewed. Asserts the key
 * controls render and the console stays clean.
 *
 * Run: bun run --cwd packages/ui test:onboarding-e2e
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

// CompactOnboarding renders <img src="./brand/logos/logo_white_nobg.svg">;
// mirror the real brand asset next to the HTML so review screenshots aren't
// littered with a broken-image glyph (it resolves at runtime in the app).
await mkdir(join(outDir, "brand", "logos"), { recursive: true });
await copyFile(
  join(here, "..", "..", "..", "..", "shared", "assets", "logos", "logo_white_nobg.svg"),
  join(outDir, "brand", "logos", "logo_white_nobg.svg"),
).catch(() => {});

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const stubController = {
  name: "stub-first-run-controller",
  setup(b) {
    b.onResolve({ filter: /use-first-run-controller$/ }, () => ({
      path: join(here, "use-first-run-controller.stub.ts"),
    }));
  },
};
// FirstRunShell imports ../first-run (normalizeFirstRunName), which pulls
// @elizaos/shared's Node fs-extra; only the name normalizer is needed at runtime.
const stubFirstRun = {
  name: "stub-first-run",
  setup(b) {
    b.onResolve({ filter: /first-run\/first-run$/ }, () => ({
      path: join(here, "first-run.stub.ts"),
    }));
  },
};
// FirstRunShell's useTranslation throws without a provider; render defaultValues.
const stubTranslation = {
  name: "stub-translation",
  setup(b) {
    b.onResolve({ filter: /TranslationContext\.hooks$/ }, () => ({
      path: join(here, "TranslationContext.hooks.stub.ts"),
    }));
  },
};
const result = await build({
  entryPoints: [join(here, "onboarding-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubController, stubFirstRun, stubTranslation],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>onboarding e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "onboarding.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const sink = { logs: [], errors: [] };
function attachConsole(p) {
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

const STATES = [
  { q: "", name: "choose", desktop: true },
  { q: "?nolocal", name: "choose-no-local-runtime", desktop: true },
  { q: "?connected", name: "choose-cloud-connected", desktop: true },
  { q: "?step=remote", name: "remote", desktop: true },
  { q: "?cloudlogin", name: "cloud-signin", desktop: true },
  { q: "?busy=Starting+your+agent%E2%80%A6", name: "busy", desktop: true },
];

const browser = await chromium.launch();
try {
  // Mobile (the primary surface) + a desktop width.
  for (const view of [
    { w: 402, h: 874, tag: "mobile", scale: 2 },
    { w: 1180, h: 820, tag: "desktop", scale: 1 },
  ]) {
    for (const st of STATES) {
      if (view.tag === "desktop" && !st.desktop) continue;
      const p = await browser.newPage({
        viewport: { width: view.w, height: view.h },
        deviceScaleFactor: view.scale,
      });
      attachConsole(p);
      await p.goto(`${url}${st.q}`);
      await p.waitForSelector('[data-testid="onboarding-toast"]', { timeout: 10_000 });
      await p.waitForTimeout(450);
      await snap(p, `${view.tag}-${st.name}`);
      await p.close();
    }
  }

  // Full-screen FirstRunShell (the "onboarding" view). reduced-motion makes the
  // typed-prompt reveal instant so the controls are up for the screenshot.
  const FULL_STATES = [
    { q: "?shell=full", name: "full-runtime-cloud" },
    { q: "?shell=full&runtime=local", name: "full-runtime-local" },
    {
      q: "?shell=full&runtime=local&localinference=cloud-inference",
      name: "full-local-inference-cloud",
    },
    { q: "?shell=full&step=remote", name: "full-remote" },
    { q: "?shell=full&mic=denied", name: "full-mic-denied" },
  ];
  for (const st of FULL_STATES) {
    const p = await browser.newPage({
      viewport: { width: 1180, height: 860 },
      deviceScaleFactor: 1,
    });
    attachConsole(p);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.goto(`${url}${st.q}`);
    await p.waitForSelector('[data-testid="first-run-shell"]', { timeout: 10_000 });
    await p.waitForTimeout(500);
    await snap(p, st.name);
    await p.close();
  }

  // Assertions on the default "choose" state (mobile).
  const p = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
  attachConsole(p);
  await p.goto(url);
  await p.waitForSelector('[data-testid="onboarding-toast"]');
  await p.waitForTimeout(300);
  assert(await p.getByTestId("onboarding-option-cloud").isVisible(), "cloud option card shown");
  assert(await p.getByTestId("onboarding-option-remote").isVisible(), "remote option card shown");
  assert(await p.getByTestId("onboarding-option-local").isVisible(), "local option card shown");
  await p.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nONBOARDING E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nONBOARDING E2E PASSED");
