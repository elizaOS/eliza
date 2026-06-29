/**
 * Real-browser e2e for the first-time-user welcome lifecycle (#9959) — no app
 * server. Bundles ftu-home-fixture.tsx (the REAL FTU widget behind WidgetHost's
 * sunset gate) with esbuild, loads it in headless chromium, and proves the
 * show-once-then-retire lifecycle end to end:
 *   - a cold home shows the welcome card with tappable chips;
 *   - tapping a chip prefills the chat (event captured) AND retires the card;
 *   - the retirement persists across a reload (localStorage);
 *   - the dismiss control retires the card on its own.
 * Captures desktop + mobile screenshots (cold + retired) and a mobile video.
 *
 * Run: bun run --cwd packages/ui test:ftu-home-e2e
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = join(here, "../../../../styles");
const outDir = join(here, "output-ftu");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const baseCss = await readFile(join(stylesDir, "base.css"), "utf8");
const TOKEN_SHIM = `
.bg-accent-subtle{background-color:var(--accent-subtle)}
.text-accent{color:var(--accent)}
.bg-accent{background-color:var(--accent)}
.text-accent-foreground{color:var(--accent-foreground)}
`;

// Stub usePromptSuggestions so the fixture needs no API client / network. The
// stub module is written into the gitignored output dir to keep the source clean.
const stubPath = join(outDir, "suggestions-stub.ts");
await writeFile(
  stubPath,
  `export function usePromptSuggestions() {\n  return ["Plan my day", "Draft a reply", "What can you do?"];\n}\n`,
);
const stubSuggestions = {
  name: "stub-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({ path: stubPath }));
  },
};

const result = await build({
  entryPoints: [join(here, "ftu-home-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubSuggestions],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>ftu home e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style>
<style>${TOKEN_SHIM}</style>
<style>html,body{margin:0;height:100%;background:var(--brand-orange)}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "ftu-home.html");
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
  // ── Chip-tap → prefill + retire + persistence (desktop + mobile) ────────────
  for (const view of [
    { name: "desktop", viewport: { width: 1180, height: 820 } },
    { name: "mobile", viewport: { width: 402, height: 874 } },
  ]) {
    const ctx = await browser.newContext({ viewport: view.viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => sink.errors.push(`[${view.name}] ${e}`));
    await page.goto(url);
    await page.waitForSelector('[data-testid="home-grid"]');

    assert(
      await page.getByTestId("chat-widget-ftu-welcome").isVisible(),
      `[${view.name}] cold home shows the FTU welcome card`,
    );
    assert(
      (await page.getByTestId("ftu-welcome-chip").count()) === 3,
      `[${view.name}] welcome card shows 3 tappable chips`,
    );
    await snap(page, `${view.name}-cold`);

    const prefilled = [];
    await page.exposeFunction("__onPrefill", (text) => prefilled.push(text));
    await page.evaluate(() =>
      window.addEventListener("eliza:chat:prefill", (e) =>
        window.__onPrefill(e.detail?.text ?? ""),
      ),
    );
    await page.getByTestId("ftu-welcome-chip").first().click();
    await page.waitForSelector('[data-testid="ftu-retired"]');
    assert(
      prefilled.length === 1 && prefilled[0].length > 0,
      `[${view.name}] tapping a chip prefilled the chat ("${prefilled[0] ?? ""}")`,
    );
    assert(
      (await page.getByTestId("chat-widget-ftu-welcome").count()) === 0,
      `[${view.name}] the welcome card retired after the chip tap`,
    );
    await snap(page, `${view.name}-retired`);

    // Reload — the retirement must persist (localStorage).
    await page.reload();
    await page.waitForSelector('[data-testid="home-grid"]');
    assert(
      (await page.getByTestId("chat-widget-ftu-welcome").count()) === 0,
      `[${view.name}] the card stays retired after a reload (persisted)`,
    );
    await ctx.close();
  }

  // ── Dismiss control retires the card on its own (fresh storage) ─────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 402, height: 874 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => sink.errors.push(`[dismiss] ${e}`));
    await page.goto(url);
    await page.waitForSelector('[data-testid="chat-widget-ftu-welcome"]');
    await page.getByTestId("ftu-welcome-dismiss").click();
    await page.waitForSelector('[data-testid="ftu-retired"]');
    assert(
      (await page.getByTestId("chat-widget-ftu-welcome").count()) === 0,
      "the dismiss control retires the card",
    );
    await ctx.close();
  }

  // ── Video walkthrough: cold → tap chip → retired ────────────────────────────
  const vctx = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    recordVideo: { dir: outDir, size: { width: 402, height: 874 } },
  });
  const movie = await vctx.newPage();
  movie.on("pageerror", (e) => sink.errors.push(`[video] ${e}`));
  await movie.goto(url);
  await movie.waitForSelector('[data-testid="chat-widget-ftu-welcome"]');
  await movie.waitForTimeout(900);
  await movie.getByTestId("ftu-welcome-chip").first().click();
  await movie.waitForTimeout(900);
  const video = await movie.video();
  await movie.close();
  await vctx.close();
  if (video) console.log(`  🎥 ${await video.path()}`);
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nFTU HOME E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nFTU HOME E2E PASSED");
