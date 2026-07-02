/**
 * Real-browser e2e for #11670 — a user message sent during local-model warm-up
 * must never be silently evicted from the thread.
 *
 * Bundles warmup-eviction-fixture.tsx (the REAL useChatSend pipeline + the real
 * ContinuousChatOverlay, with the warm-up 503 simulated at the client-API
 * boundary), loads it in headless chromium via Playwright, and drives the flow
 * with real typing + clicks:
 *
 *   1. Send a message while the agent 503s every turn (warm-up window).
 *   2. Assert the optimistic bubble renders, then SURVIVES the post-turn
 *      reconcile (on the pre-fix code it vanished here), with a retryable
 *      failed assistant turn + Retry chip.
 *   3. Mark the model ready, click Retry, and assert the message is delivered
 *      exactly once with the agent's reply.
 *
 * Screenshots every stage into output-warmup-eviction/; fails on any page
 * error. Run: bun run --cwd packages/ui test:warmup-eviction-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-warmup-eviction");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── Bundle (mirrors run-chat-sheet-e2e.mjs) ────────────────────────────────
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
    }));
  },
};
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};
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
  entryPoints: [join(here, "warmup-eviction-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubPromptSuggestions, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>warmup eviction e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "warmup-eviction.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

// ── DOM probes ─────────────────────────────────────────────────────────────
const userBubbles = (p, text) =>
  p
    .locator('[data-testid="thread-line"][data-role="user"]', { hasText: text })
    .count();
const retryChips = (p) => p.getByTestId("thread-line-retry").count();
const assistantWithText = (p, text) =>
  p
    .locator('[data-testid="thread-line"][data-role="assistant"]', {
      hasText: text,
    })
    .count();

// ── Drive ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const consoleLogs = [];
const pageErrors = [];
page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(url);
await page.waitForSelector('[data-testid="chat-sheet"]');

const MESSAGE = "hello while you warm up";

// 1) Send during the warm-up window (every turn 503s, nothing persisted).
await page.getByTestId("chat-composer-textarea").click();
await page.getByTestId("chat-composer-textarea").fill(MESSAGE);
await page.keyboard.press("Enter");

// Optimistic bubble is on screen while the send is in flight.
await page.waitForSelector('[data-testid="thread-line"][data-role="user"]');
assert(
  (await userBubbles(page, MESSAGE)) === 1,
  "optimistic user bubble renders on send",
);
await page.screenshot({
  path: join(outDir, "01-optimistic-bubble-in-flight.png"),
});

// 2) Let the 503 + post-turn reconcile settle. Pre-fix: the reload full-replaced
//    the thread with the (empty) server truth and the bubble vanished here.
await page.waitForTimeout(2200);
assert(
  (await userBubbles(page, MESSAGE)) === 1,
  "user bubble SURVIVES the warm-up 503 + reconcile reload (#11670)",
);
assert(
  (await retryChips(page)) === 1,
  "a retryable failed assistant turn (Retry chip) is attached",
);
assert(
  (await assistantWithText(page, "didn't reach the agent")) === 1,
  "the failed turn explains the message did not reach the agent",
);
await page.screenshot({ path: join(outDir, "02-survived-with-retry.png") });

// 3) Model comes online → one tap on Retry delivers the turn exactly once.
await page.evaluate(() => window.__setModelReady(true));
await page.getByTestId("thread-line-retry").click();
await page.waitForSelector(
  '[data-testid="thread-line"][data-role="assistant"]',
);
// Wait for the reply + the post-turn reconcile (server truth now holds the turn).
await page.waitForFunction(
  () =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="thread-line"][data-role="assistant"]',
      ),
    ).some((el) => el.textContent?.includes("I'm awake now")),
  undefined,
  { timeout: 8000 },
);
await page.waitForTimeout(600);
assert(
  (await userBubbles(page, MESSAGE)) === 1,
  "retry delivers the message exactly once (no duplicate bubble)",
);
assert(
  (await assistantWithText(page, "I'm awake now")) === 1,
  "the agent's reply lands after retry",
);
assert(
  (await retryChips(page)) === 0,
  "the failed turn is reconciled away once the turn persisted",
);
await page.screenshot({ path: join(outDir, "03-delivered-after-retry.png") });

await writeFile(
  join(outDir, "console.log"),
  `${consoleLogs.join("\n")}\n`,
  "utf8",
);
assert(pageErrors.length === 0, `no page errors (got: ${pageErrors.join()})`);

await browser.close();
console.log(
  failures === 0
    ? `\nPASS — screenshots in ${outDir}`
    : `\nFAIL — ${failures} assertion(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
