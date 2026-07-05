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
//
// The corpus holds exactly ONE page older than the mounted tail, then latches
// hasMore=false. This is deliberate: the hook prefetches a full viewport of
// runway before the literal top, so parking the scroller at the top would
// otherwise cascade page after page while the sentinel stays intersecting. A
// single bounded page makes the scroll-anchor-preservation assertion below an
// isolated, deterministic measurement of ONE prepend rather than a moving target.
const PAGE_LIMIT_DEFAULT = 20;
// Serve exactly one older page, ever. The first `?before=` request gets a full
// page + hasMore=false (which latches the loader off); any subsequent request
// (should never happen once hasMore=false, but the prefetch margin can race one
// in) gets an empty page. This keeps the prepend a single isolated event.
let servedFirstPage = false;
function olderPage(before, limit) {
  if (servedFirstPage) return { messages: [], hasMore: false };
  servedFirstPage = true;
  const size = limit || PAGE_LIMIT_DEFAULT;
  // One page of deterministic older messages strictly below the cursor, newest
  // first. `id` is stable per timestamp so a re-fetch dedupes cleanly.
  const page = [];
  for (let i = 0; i < size; i += 1) {
    const ts = before - (i + 1) * 1000;
    page.push({
      id: `older-${ts}`,
      role: i % 2 === 0 ? "assistant" : "user",
      text: `Older message at ${ts}.`,
      timestamp: ts,
    });
  }
  return { messages: page, hasMore: false };
}

const serverRequests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/") {
    // Each page load starts a fresh single-page budget (the runner opens the
    // fixture several times for the different modes).
    servedFirstPage = false;
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
    // The thread mounts pinned to the bottom (sentinel off-screen), so NO fetch
    // has fired yet — the load-older is entirely reader-driven below.
    await page.waitForTimeout(300);

    const rowsBefore = await page.locator(ROW).count();
    assert(rowsBefore > 0, `thread mounted with ${rowsBefore} rows`);
    assert(
      requests.filter((u) => /\/messages\?before=/.test(u)).length === 0,
      "no ?before= fetch fired at mount (thread starts pinned to bottom)",
    );

    // Scroll to the very top and, in the SAME evaluate, capture the anchor: the
    // top-most row's identity + viewport-y at scrollTop=0, BEFORE the prepend
    // lands. The prefetch fires from this scroll; the only thing that then moves
    // this row is the older-page grow — exactly the anchor behaviour under test.
    const anchorInfo = await page.evaluate(
      ({ scrollerSel, rowSel }) => {
        const scroller = document.querySelector(scrollerSel);
        if (!scroller) return null;
        scroller.scrollTop = 0;
        const firstRow = document.querySelector(rowSel);
        if (!firstRow) return null;
        return {
          id: firstRow.getAttribute("data-message-id"),
          y: firstRow.getBoundingClientRect().top,
        };
      },
      { scrollerSel: SCROLLER, rowSel: ROW },
    );
    assert(
      anchorInfo && anchorInfo.id,
      "captured the top anchor row at scrollTop=0 before the load-older",
    );

    // The `?before=` request must fire on scroll-to-top.
    await page.waitForRequest((r) => /\/messages\?before=/.test(r.url()), {
      timeout: 8_000,
    });
    assert(
      requests.some((u) => /\/messages\?before=/.test(u)),
      "a GET .../messages?before= request fired on scroll-to-top",
    );

    // Older rows prepend (row count grew).
    await page
      .waitForFunction(
        ({ sel, prev }) => document.querySelectorAll(sel).length > prev,
        { sel: ROW, prev: rowsBefore },
        { timeout: 8_000 },
      )
      .catch(() => {});
    const rowsAfter = await page.locator(ROW).count();
    assert(
      rowsAfter > rowsBefore,
      `older rows prepended (${rowsBefore} → ${rowsAfter})`,
    );

    // SCROLL-ANCHOR PRESERVATION: despite a page inserted ABOVE it, the anchor
    // row's viewport-y is unchanged (±tolerance) — the hook's useLayoutEffect
    // added the grown height back to scrollTop so the reader's viewport did not
    // jump. This is the whole point of the load-older contract, and jsdom cannot
    // fake the real scrollHeight/scrollTop geometry.
    await page.waitForTimeout(200);
    const yAfter = await page.evaluate((id) => {
      const el = document.querySelector(`[data-message-id="${id}"]`);
      return el ? el.getBoundingClientRect().top : null;
    }, anchorInfo.id);
    assert(
      yAfter !== null,
      "the pre-prepend anchor row is still in the DOM after the prepend",
    );
    if (yAfter !== null) {
      const drift = Math.abs(yAfter - anchorInfo.y);
      assert(
        drift <= 4,
        `anchor row viewport-y preserved across the prepend (drift ${drift.toFixed(1)}px ≤ 4px, ${anchorInfo.y.toFixed(0)} → ${yAfter.toFixed(0)})`,
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
