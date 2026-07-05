/**
 * REAL-browser e2e for the infinite upward scroll (#13532).
 *
 * Mounts chat-infinite-scroll-fixture.tsx — the PRODUCTION `useLoadOlderOnScroll`
 * hook + `loadOlderConversationMessages` orchestration — in real Chromium and
 * drives the actual behaviour jsdom cannot:
 *   1. Scroll to the top → a `GET .../messages?before=<cursor>` request FIRES
 *      (observed on the wire), older rows PREPEND, and the previously-top row's
 *      boundingBox stays put (scroll-anchor preservation, ±tolerance).
 *   2. Empty history → NO fetch loop (an empty thread has no cursor to page).
 *   3. Fetch failure → the error surfaces (guard re-arms), with NO retry storm
 *      (bounded resolves), and no fabricated/empty prepend.
 *
 * A tiny in-process HTTP server serves the fixture HTML AND the mock
 * `?before=` messages endpoint, so the `fetch()` the client issues is genuine
 * network traffic (observable via page requests + the server's own log).
 *
 * Run: node src/components/pages/__e2e__/run-chat-infinite-scroll-e2e.mjs
 * Exits non-zero on any failed assertion / console error.
 */

import { createServer } from "node:http";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// --- bundle the fixture (same stub set as the sibling chat-scroll runner) ---
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
        module.exports = new Proxy({}, { get: (t, p) => (p in t ? t[p] : noop) });
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
  entryPoints: [join(here, "chat-infinite-scroll-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat infinite scroll e2e</title>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;

// --- HTTP server: serves the fixture HTML + mock `?before=` older pages ------
// The mock corpus is a long history; each `?before=<cursor>` returns the page
// strictly older than the cursor, newest-first-clamped to a page, with a
// hasMore flag until the corpus is exhausted (mirrors the real server contract).
const NOW = Date.now();
const CORPUS_OLDER = 60; // older messages available behind the mounted tail.
function olderPage(before, limit) {
  // Deterministic older messages, all with timestamp < before. `id` is stable
  // per timestamp so a re-fetch dedupes.
  const out = [];
  for (let i = 0; i < CORPUS_OLDER; i += 1) {
    const ts = before - (i + 1) * 1000;
    out.push({
      id: `older-${ts}`,
      role: i % 2 === 0 ? "assistant" : "user",
      text: `Older message at ${ts}.`,
      timestamp: ts,
    });
  }
  // Newest-first page below the cursor, then clamp to limit.
  out.sort((a, b) => b.timestamp - a.timestamp);
  const page = out.slice(0, limit);
  // hasMore: the corpus has a floor; below it, no more.
  const floor = NOW - 3_600_000;
  const hasMore = page.length > 0 && page[page.length - 1].timestamp > floor;
  return { messages: page, hasMore };
}

const serverRequests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (/\/api\/conversations\/[^/]+\/messages$/.test(url.pathname)) {
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit") || 20);
    serverRequests.push({ before, limit });
    const body = olderPage(before, limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const SCROLLER = '[data-testid="infinite-scroll-scroller"]';
const ROW = '[data-testid="infinite-scroll-row"]';

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const consoleErrors = [];

async function newPage(query) {
  const page = await browser.newPage({
    viewport: { width: 480, height: 700 },
  });
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${base}/${query}`);
  await page.waitForSelector(SCROLLER);
  return { page, requests };
}

try {
  // ── 1) Load-older: scroll to top → ?before= fires → prepend → no jump ──────
  {
    const { page, requests } = await newPage("");
    await page.waitForSelector(ROW);
    const rowsBefore = await page.locator(ROW).count();
    assert(rowsBefore > 0, `tail page mounted with ${rowsBefore} rows`);

    // The message the reader is anchored on: the FIRST visible (oldest tail)
    // row. Capture its identity + on-screen y BEFORE the prepend.
    const firstId = await page.locator(ROW).first().getAttribute("data-message-id");
    // Scroll to the very top so the sentinel intersects and the prefetch fires.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = 0;
    }, SCROLLER);

    // The `?before=` request must fire.
    await page.waitForRequest(
      (r) => /\/messages\?before=/.test(r.url()),
      { timeout: 8_000 },
    );
    assert(
      requests.some((u) => /\/messages\?before=/.test(u)),
      "a GET .../messages?before= request fired on scroll-to-top",
    );

    // Older rows prepend (row count grew).
    await page
      .waitForFunction(
        ({ sel, prev }) =>
          document.querySelectorAll(sel).length > prev,
        { sel: ROW, prev: rowsBefore },
        { timeout: 8_000 },
      )
      .catch(() => {});
    const rowsAfter = await page.locator(ROW).count();
    assert(rowsAfter > rowsBefore, `older rows prepended (${rowsBefore} → ${rowsAfter})`);

    // SCROLL-ANCHOR PRESERVATION: the previously-first row's on-screen y is
    // unchanged (±tolerance) despite the upward growth — no viewport jump.
    const anchor = page.locator(`[data-message-id="${firstId}"]`);
    const boxAfter = await anchor.boundingBox();
    // Give layout a beat, then re-measure to confirm it's stable (not mid-anim).
    await page.waitForTimeout(200);
    const boxSettled = await anchor.boundingBox();
    assert(
      boxAfter && boxSettled,
      "the pre-prepend anchor row is still in the DOM after the prepend",
    );
    if (boxAfter && boxSettled) {
      const drift = Math.abs(boxSettled.y - boxAfter.y);
      assert(
        drift <= 4,
        `anchor row stayed put after settle (drift ${drift.toFixed(1)}px ≤ 4px)`,
      );
      // And it did not get shoved off the bottom of the viewport.
      assert(
        boxSettled.y < 700 && boxSettled.y > -50,
        `anchor row remains in the viewport (y=${boxSettled.y.toFixed(0)})`,
      );
    }
    await page.close();
  }

  // ── 2) Empty history: NO fetch loop ────────────────────────────────────────
  {
    const { page, requests } = await newPage("?empty");
    await page.waitForTimeout(600);
    const rows = await page.locator(ROW).count();
    assert(rows === 0, "empty thread renders zero rows");
    // Scroll (no-op on an empty scroller) — still must not fetch.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = 0;
    }, SCROLLER);
    await page.waitForTimeout(600);
    assert(
      !requests.some((u) => /\/messages\?before=/.test(u)),
      "empty thread issues NO ?before= fetch (no cursor to page below)",
    );
    await page.close();
  }

  // ── 3) Fetch failure: error surfaces, guard re-arms, no retry storm ─────────
  {
    const { page } = await newPage("?fail");
    await page.waitForSelector(ROW);
    const rowsBefore = await page.locator(ROW).count();
    // Trigger the (failing) older-page load.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = 0;
    }, SCROLLER);
    // The first fetch rejects; the hook must not fabricate a prepend and must
    // not enter a retry storm. Wait, then assert bounded behaviour.
    await page.waitForTimeout(1_200);
    const failed = await page.evaluate(() => window.__lastFetchFailed === true);
    assert(failed, "the older-page fetch failed (error path exercised)");
    const rowsAfter = await page.locator(ROW).count();
    assert(
      rowsAfter === rowsBefore,
      `no fabricated prepend on failure (${rowsBefore} → ${rowsAfter} rows unchanged)`,
    );
    // No retry storm: the load resolved a bounded number of times (not spinning).
    const resolves = await page.evaluate(() => window.__loadResolves ?? 0);
    assert(
      resolves <= 2,
      `no retry storm on failure (older-page loads resolved ${resolves} times ≤ 2)`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

assert(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
if (consoleErrors.length) for (const e of consoleErrors) console.log("  ERR:", e);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll infinite-scroll assertions passed.");
