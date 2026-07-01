/**
 * Real-browser e2e for the pull-DOWN notification center (#10706) — no app
 * server. Bundles home-pull-notification-fixture.tsx with esbuild (stubbing the
 * data sources exactly like run-home-screen-e2e.mjs), loads it in headless
 * chromium, and asserts:
 *   1. A pull-DOWN on the `home-screen` div opens the notification center panel.
 *   2. The panel exposes a priority↔time sort toggle (and the toggle flips it).
 *   3. Closing the panel works.
 *   4. Home ↔ launcher HORIZONTAL swipes STILL work afterward — proving the new
 *      pull-down gesture and the launcher pager (and, by construction, the chat
 *      sheet's bottom grabber) do not fight.
 *
 * Run: bun run --cwd packages/ui test:home-pull-notification-e2e
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-pull-notification");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Redirect the live data sources to deterministic stubs — identical to
// run-home-screen-e2e.mjs (the home subtree is the same real tree).
const stubResolver = {
  name: "home-stub-resolver",
  setup(b) {
    // Use the pull-down-specific api-stub: it re-exports the shared client but
    // hydrates the notification store from the mixed-attention set the sort
    // toggle asserts against.
    b.onResolve({ filter: /(\/api|\/api\/client)$/ }, () => ({
      path: join(here, "home-pull-notification-fixture.api-stub.ts"),
    }));
    b.onResolve({ filter: /useActivityEvents$/ }, () => ({
      path: join(here, "home-screen-fixture.activity-stub.ts"),
    }));
    b.onResolve({ filter: /useDocumentVisibility$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
    }));
    b.onResolve({ filter: /useAvailableViews$/ }, () => ({
      path: join(here, "home-screen-fixture.views-stub.ts"),
    }));
    b.onResolve({ filter: /useViewCatalog$/ }, () => ({
      path: join(here, "home-screen-fixture.catalog-stub.ts"),
    }));
    b.onResolve({ filter: /useViewKinds$/ }, () => ({
      path: join(here, "home-screen-fixture.view-kinds-stub.ts"),
    }));
    b.onResolve({ filter: /platform-guards$/ }, () => ({
      path: join(here, "home-screen-fixture.platform-stub.ts"),
    }));
    b.onResolve({ filter: /\/hooks$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
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
  entryPoints: [join(here, "home-pull-notification-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubResolver, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>home pull notification e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16}
:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--safe-area-top:0px;--eliza-mobile-nav-offset:0px}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "home-pull-notification.html");
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

// A vertical pull DOWN across an element, dispatched as real touch pointer
// events (Playwright's mouse API grabs pointer capture; touch matches the device
// the home pull-down targets). Starts near the top of the element and drags
// DOWN by `px`, past the 80px pull-down distance threshold.
async function pullDown(page, testId, px) {
  await page.getByTestId(testId).evaluate((el, dropPx) => {
    const box = el.getBoundingClientRect();
    const x = box.x + box.width * 0.5;
    const startY = box.y + Math.min(40, box.height * 0.1);
    const fire = (type, y) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 9,
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    fire("pointerdown", startY);
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      fire("pointermove", startY + (dropPx * i) / steps);
    }
    fire("pointerup", startY + dropPx);
  }, px);
}

// A horizontal LEFT touch-swipe (home → launcher) on the given element, as real
// touch pointer events — the same helper shape run-home-screen-e2e.mjs uses.
async function touchSwipeLeft(page, testId) {
  await page.getByTestId(testId).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const y = box.y + box.height * 0.4;
    const startX = box.x + box.width * 0.82;
    const endX = box.x + box.width * 0.14;
    const fire = (type, x) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      );
    fire("pointerdown", startX);
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      fire("pointermove", startX + ((endX - startX) * i) / steps);
    }
    fire("pointerup", endX);
  });
}

async function waitForSurfacePageSettled(p, pageName) {
  await p.waitForFunction((expectedPage) => {
    const surface = document.querySelector(
      '[data-testid="home-launcher-surface"]',
    );
    const rail = document.querySelector('[data-testid="home-launcher-rail"]');
    if (!(surface instanceof HTMLElement) || !(rail instanceof HTMLElement)) {
      return false;
    }
    if (surface.getAttribute("data-page") !== expectedPage) return false;
    const surfaceRect = surface.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const expectedLeft =
      expectedPage === "launcher"
        ? surfaceRect.left - surfaceRect.width
        : surfaceRect.left;
    const railSettled = Math.abs(railRect.left - expectedLeft) < 1;
    const transitionsDone = rail
      .getAnimations()
      .every((animation) => animation.playState === "finished");
    return railSettled && transitionsDone;
  }, pageName);
}

try {
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => sink.errors.push(String(e)));
  await page.goto(`${url}?native`);
  await page.waitForSelector('[data-testid="home-launcher-surface"]');
  await page.waitForSelector('[data-testid="home-screen"]');
  await page.waitForTimeout(500);

  // Panel starts closed.
  assert(
    (await page.getByTestId("notification-center-panel").count()) === 0,
    "notification center panel is closed on load",
  );
  await snap(page, "01-home-rest");

  // ── 1. Pull DOWN while the scroll container is NOT at top must NOT open the
  // panel. This is the iOS-style pull-to-reveal guard: a normal downward scroll
  // in overflowing home content should keep scrolling, not summon notifications.
  const scrollGuardState = await page.getByTestId("home-screen").evaluate((el) => {
    const spacer = document.createElement("div");
    spacer.setAttribute("data-testid", "scroll-guard-spacer");
    spacer.style.height = "1200px";
    spacer.style.pointerEvents = "none";
    el.dataset.previousHeight = el.style.height;
    el.dataset.previousMaxHeight = el.style.maxHeight;
    el.dataset.previousOverflowY = el.style.overflowY;
    el.style.height = "480px";
    el.style.maxHeight = "480px";
    el.style.overflowY = "auto";
    el.appendChild(spacer);
    el.scrollTop = 320;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
  assert(
    scrollGuardState.scrollTop > 0,
    `home-screen is scrolled before guarded pull (${JSON.stringify(scrollGuardState)})`,
  );
  await pullDown(page, "home-screen", 160);
  await page.waitForTimeout(250);
  assert(
    (await page.getByTestId("notification-center-panel").count()) === 0,
    "pull-DOWN while home-screen is scrolled down does not open the panel",
  );
  await page.getByTestId("home-screen").evaluate((el) => {
    el.querySelector('[data-testid="scroll-guard-spacer"]')?.remove();
    el.style.height = el.dataset.previousHeight ?? "";
    el.style.maxHeight = el.dataset.previousMaxHeight ?? "";
    el.style.overflowY = el.dataset.previousOverflowY ?? "";
    delete el.dataset.previousHeight;
    delete el.dataset.previousMaxHeight;
    delete el.dataset.previousOverflowY;
    el.scrollTop = 0;
  });

  // ── 2. Pull DOWN on the home widget area opens the panel when already at top.
  await pullDown(page, "home-screen", 160);
  await page
    .getByTestId("notification-center-panel")
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => {});
  assert(
    await page.getByTestId("notification-center-panel").isVisible(),
    "pull-DOWN on home-screen opens the notification center panel",
  );
  await snap(page, "02-panel-open");

  // ── 3. The priority↔time sort toggle is present and flips the order.
  // Assert on the RELATIVE order of the three fixture-seeded items (the store
  // may also carry the api-stub's own notification, which is irrelevant here).
  const titles = () =>
    page
      .getByTestId("notification-center-panel")
      .locator("ul > li .font-medium")
      .allTextContents();
  const relOrder = (list) =>
    list.filter((t) =>
      ["Urgent but old", "Normal middle", "High and recent"].some((k) =>
        t.includes(k),
      ),
    );
  const toggle = page.getByTestId("notification-sort-toggle");
  assert((await toggle.count()) === 1, "sort toggle exists in the panel");
  const priorityLabel = await toggle.getAttribute("aria-label");
  assert(
    /time/i.test(priorityLabel ?? ""),
    `default (priority) toggle offers time sort (aria-label="${priorityLabel}")`,
  );
  // Priority sort: urgent → high → normal (all unread, so priority decides).
  const priorityOrder = relOrder(await titles());
  assert(
    JSON.stringify(priorityOrder) ===
      JSON.stringify(["Urgent but old", "High and recent", "Normal middle"]),
    `priority sort orders urgent → high → normal (got ${JSON.stringify(priorityOrder)})`,
  );
  await toggle.click();
  const timeLabel = await toggle.getAttribute("aria-label");
  assert(
    /priority/i.test(timeLabel ?? ""),
    `after toggle the label offers priority sort (aria-label="${timeLabel}")`,
  );
  // Time sort: newest-createdAt first → high-recent (min 20) → normal (min 10)
  // → urgent-old (min 0), ignoring priority.
  const timeOrder = relOrder(await titles());
  assert(
    JSON.stringify(timeOrder) ===
      JSON.stringify(["High and recent", "Normal middle", "Urgent but old"]),
    `time sort orders newest → oldest by createdAt (got ${JSON.stringify(timeOrder)})`,
  );
  await snap(page, "03-panel-time-sort");

  // ── 4. Close the panel.
  await page.getByTestId("notification-center-close").click();
  await page
    .getByTestId("notification-center-panel")
    .waitFor({ state: "hidden", timeout: 4000 })
    .catch(() => {});
  assert(
    (await page.getByTestId("notification-center-panel").count()) === 0,
    "closing the panel removes it",
  );

  // ── 5. Home ↔ launcher HORIZONTAL swipes STILL work — the pull-down gesture
  // did not steal the pager's horizontal handling.
  assert(
    (await page.getByTestId("home-launcher-surface").getAttribute(
      "data-page",
    )) === "home",
    "surface is back on Home after closing the panel",
  );
  await touchSwipeLeft(page, "home-launcher-home-page");
  await waitForSurfacePageSettled(page, "launcher").catch(() => {});
  assert(
    (await page.getByTestId("home-launcher-surface").getAttribute(
      "data-page",
    )) === "launcher",
    "horizontal LEFT swipe still pages home → launcher (gestures don't fight)",
  );
  await snap(page, "04-launcher-after-swipe");

  await context.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nHOME-PULL-NOTIFICATION E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nHOME-PULL-NOTIFICATION E2E PASSED");
