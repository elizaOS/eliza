/**
 * Browser regression run + screenshots for the inline notification inbox,
 * desktop + mobile: priority/all modes through the sole persistent mode
 * toggle, a bounded native scrollport, stack-local tap/mouse-drag/trackpad fan
 * gestures, fold controls, and swipe-to-dismiss. No app server:
 * bundles the fixture with esbuild (core/node builtins stubbed dead-in-browser)
 * and drives it in headless chromium.
 *
 * Run: bun packages/ui/src/components/shell/__e2e__/capture-default-notifications.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-notifications");
await mkdir(outDir, { recursive: true });

const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      // tierForPriority must carry the REAL tier semantics: the rested shade
      // filters on tierForPriority(p) === "interrupt", so a proxy-noop here
      // would blank the rested state and fake a regression.
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            DEFAULT_NOTIFICATION_CATEGORY: "general",
            DEFAULT_NOTIFICATION_PRIORITY: "normal",
            tierForPriority: (priority) =>
              priority === "urgent" || priority === "high"
                ? "interrupt"
                : priority === "low"
                  ? "silent"
                  : "ambient",
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
  entryPoints: [join(here, "notifications-center-fixture.tsx")],
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
console.log(`bundled (${js.length} bytes)`);

// Fetch the tailwind runtime ONCE and serve it from the loopback server: the
// CDN can take >8s cold, which used to screenshot the first page unstyled.
let tailwindJs = "";
try {
  const res = await fetch("https://cdn.tailwindcss.com");
  if (res.ok) tailwindJs = await res.text();
} catch {
  // offline — the checks are DOM/computed-style based; pixels go unstyled.
}
if (!tailwindJs) console.log("(tailwind CDN unavailable — unstyled pixels)");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>notifications e2e</title>
${tailwindJs ? '<script src="/tailwind.js"></script>' : ""}
<style>html,body{margin:0;height:100%;color:#f4f4f5;font-family:ui-sans-serif,system-ui;
  background-color:#0a0d16;
  background-image:
    radial-gradient(55% 50% at 22% 14%, rgba(255,150,60,0.30), transparent 60%),
    radial-gradient(50% 45% at 80% 82%, rgba(255,90,40,0.20), transparent 60%),
    repeating-linear-gradient(120deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 24px),
    repeating-linear-gradient(30deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 24px);
  background-attachment:fixed;}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "notifications.html");
await writeFile(htmlPath, html);

// Serve over loopback HTTP, not file:// — the Eliza API client refuses to
// fire without an HTTP origin, and a rejected write REVERTS the optimistic
// dismiss (correct app behavior that would fake a swipe regression here).
// Every /api/* write gets a happy ok-JSON so acted-on rows stay acted-on.
const server = createServer((req, res) => {
  if (req.url === "/tailwind.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(tailwindJs);
    return;
  }
  if (!req.url || req.url === "/" || req.url.startsWith("/notifications")) {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, notifications: [], unreadCount: 0 }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const ROW = '[data-testid="notification-row"]';
const LIST = '[data-testid="home-notification-list"]';
const CENTER = '[data-testid="home-notification-center"]';
const APPS = '[data-testid="fixture-apps-section"]';

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function verticalDrag(page, locator, distance = 72) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  // Stay inside the row for the full gesture: the stack-local Y path does not
  // capture the pointer (native list scrolling must remain available), and a
  // pointer that leaves the card correctly stops delivering row-local moves.
  const travel = Math.min(distance, Math.max(50, box.height - 12));
  const startY = box.y + 6;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY + travel, { steps: 10 });
  await page.mouse.up();
}

/** Genuine touch pan through Chromium's input pipeline (not synthetic DOM events). */
async function cdpTouchDrag(page, locator, dx, dy, steps = 12) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("touch target has no bounding box");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    for (let i = 1; i <= steps; i += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps },
        ],
      });
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await client.detach();
  }
}

async function inboxMode(page) {
  return page.locator(LIST).getAttribute("data-inbox-mode");
}

async function homeGeometry(page) {
  return page.evaluate(
    ({ appsSelector, centerSelector, listSelector }) => {
      const apps = document.querySelector(appsSelector);
      const center = document.querySelector(centerSelector);
      const list = document.querySelector(listSelector);
      if (!(apps instanceof HTMLElement)) throw new Error("Apps not rendered");
      if (!(center instanceof HTMLElement)) {
        throw new Error("Notification center not rendered");
      }
      if (!(list instanceof HTMLElement)) {
        throw new Error("Notification list not rendered");
      }
      const appsRect = apps.getBoundingClientRect();
      const centerRect = center.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return {
        appsTop: appsRect.top,
        centerBottom: centerRect.bottom,
        centerHeight: centerRect.height,
        directSibling: apps.previousElementSibling === center,
        gap: appsRect.top - centerRect.bottom,
        listHeight: listRect.height,
        listScrollHeight: list.scrollHeight,
      };
    },
    { appsSelector: APPS, centerSelector: CENTER, listSelector: LIST },
  );
}

async function foldFirstStack(page) {
  const control = page
    .locator('[data-testid="notification-stack-collapse"]')
    .first();
  if ((await control.count()) === 0) return false;
  await control.click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="notification-row"]').length === 2,
  );
  // motion/react settles the restored stack position for 340ms. Subsequent
  // real pointer/wheel input must target the card at its final geometry.
  await page.waitForTimeout(400);
  return true;
}

const HEADFUL =
  process.argv.includes("--headful") || process.env.HEADFUL === "1";
console.log(HEADFUL ? "mode: HEADFUL (real Chromium)" : "mode: headless");
const browser = await chromium.launch({
  headless: !HEADFUL,
  slowMo: HEADFUL ? 120 : 0,
});
for (const [name, width, height] of [
  ["desktop", 1280, 900],
  ["mobile", 390, 844],
]) {
  console.log(`\n── ${name} (${width}x${height}) ──`);
  const page = await browser.newPage({
    viewport: { width, height },
    hasTouch: name === "mobile",
  });
  // Headless: still the entrance + scroll-driven (`animation-timeline: view()`)
  // effects for deterministic pixels and to dodge the headless-shell compositor
  // crash driving view-timeline rows while the scroller transforms. Headful
  // shows the real motion + the SVG backdrop-filter refraction (which
  // headless-shell can't composite), which is the whole point of --headful.
  if (!HEADFUL) await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW);
  // Readiness = an APPLIED tailwind effect (the runtime's global lands before
  // the JIT has styled the DOM, so probing the global would screenshot an
  // unstyled tree). Skipped when the runtime couldn't be fetched.
  if (tailwindJs) {
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-testid="notification-row"]');
      // The row button carries `text-left`; buttons default to center, so a
      // left alignment proves the JIT styles landed.
      return !!row && getComputedStyle(row).textAlign === "left";
    });
  }
  await page.waitForTimeout(200);

  // 1. RESTED: interrupt triage — the task group is a Z-stack (urgent on top,
  //    two glass peeks, no header eyebrow), the solo system row is flat, the
  //    rest hides behind the "N more" button.
  check("priority mode", (await inboxMode(page)) === "priority");
  check(
    "two interactive cards at rest (stack top + solo)",
    (await page.locator(ROW).count()) === 2,
  );
  check(
    "stack top is the urgent row",
    (await page.locator(ROW).first().textContent())?.includes(
      "Build failed on main",
    ),
  );
  check(
    "two glass peeks",
    (await page.locator('[data-testid="notification-stack-peek"]').count()) ===
      2,
  );
  check(
    "no group header eyebrows / stack counts",
    (await page
      .locator('[data-testid="notification-group-label"]')
      .count()) === 0 &&
      (await page
        .locator('[data-testid="notification-stack-count"]')
        .count()) === 0,
  );
  check(
    "persistent mode toggle reports the hidden quiet digest",
    (
      await page
        .locator('[data-testid="notifications-mode-toggle"]')
        .textContent()
    )?.includes("7 More") &&
      (await page
        .locator('[data-testid="notifications-mode-toggle"]')
        .getAttribute("aria-expanded")) === "false",
  );
  check(
    "hidden tier not visible at rest",
    (await page.locator("text=Take the tour").count()) === 0,
  );
  const restedHomeGeometry = await homeGeometry(page);
  check(
    "Apps are the notification center's direct normal-flow sibling",
    restedHomeGeometry.directSibling &&
      restedHomeGeometry.gap >= 0 &&
      restedHomeGeometry.gap <= 16,
    `appsTop=${restedHomeGeometry.appsTop.toFixed(1)}, centerBottom=${restedHomeGeometry.centerBottom.toFixed(1)}, gap=${restedHomeGeometry.gap.toFixed(1)}`,
  );
  const glass = await page
    .locator(ROW)
    .filter({ hasText: "Disk almost full" })
    .locator('xpath=..')
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        blur: s.backdropFilter || s.webkitBackdropFilter || "",
        shadow: s.boxShadow,
      };
    });
  check(
    "cards are liquid glass (backdrop blur + inset edge)",
    glass.blur.includes("blur") && glass.shadow.includes("inset"),
    glass.blur,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-rested.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-rested.png`);

  // 2. THE INBOX DOES NOT OWN DRAG/WHEEL MODE CHANGES. A vertical gesture on
  //    the solo priority row and a wheel run over the list leave priority mode
  //    untouched; only the explicit control below may reveal the quiet digest.
  const soloSwipe = page
    .locator(ROW)
    .filter({ hasText: "Disk almost full" })
    .locator('xpath=..');
  await verticalDrag(page, soloSwipe);
  check(
    "vertical drag on a flat row does not change inbox mode",
    (await inboxMode(page)) === "priority",
  );
  const soloBox = await soloSwipe.boundingBox();
  await page.mouse.move(
    soloBox.x + soloBox.width / 2,
    soloBox.y + soloBox.height / 2,
  );
  await page.mouse.wheel(0, 80);
  check(
    "wheel over a flat row does not change inbox mode",
    (await inboxMode(page)) === "priority",
  );

  // 3. PRODUCER-LOCAL FAN GESTURES: tap, vertical mouse drag, and a trackpad
  //    wheel run each fan the GitHub stack while the inbox remains in priority
  //    mode. Fold between paths so every gesture starts from the same state.
  const stack = () => page.locator('[data-testid="notification-stack"]').first();
  await stack().locator(ROW).click();
  check(
    "tap fans only the producer stack",
    (await page.locator(ROW).count()) === 4 &&
      (await inboxMode(page)) === "priority" &&
      (await page.locator("text=Take the tour").count()) === 0,
  );
  await foldFirstStack(page);

  await verticalDrag(
    page,
    stack().locator('[data-testid="notification-row-swipe"]'),
  );
  check(
    "vertical mouse drag fans only the producer stack",
    (await page.locator(ROW).count()) === 4 &&
      (await inboxMode(page)) === "priority",
  );
  await foldFirstStack(page);

  const foldedSwipe = stack().locator(
    '[data-testid="notification-row-swipe"]',
  );
  const foldedBox = await foldedSwipe.boundingBox();
  await page.mouse.move(
    foldedBox.x + foldedBox.width / 2,
    foldedBox.y + foldedBox.height / 2,
  );
  await page.mouse.wheel(0, 64);
  await page.waitForTimeout(80);
  check(
    "two-finger wheel fans only the producer stack",
    (await page.locator(ROW).count()) === 4 &&
      (await inboxMode(page)) === "priority",
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-stack-local.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-stack-local.png`);
  await foldFirstStack(page);

  // 4. EXPLICIT ALL MODE: the persistent toggle is the sole transition. It
  //    remains present as the collapse control, starts inside the newly
  //    revealed quiet digest, and the list itself owns a real max height and
  //    native scrolling.
  const modeToggle = page.locator('[data-testid="notifications-mode-toggle"]');
  await modeToggle.click();
  await page.waitForFunction(
    (sel) =>
      document.querySelector(sel)?.getAttribute("data-inbox-mode") === "all",
    LIST,
  );
  await page.waitForTimeout(80);
  check(
    "mode toggle alone reveals all priorities and stays available",
    (await inboxMode(page)) === "all" &&
      (await page.locator("text=Take the tour").count()) === 1 &&
      (await modeToggle.getAttribute("aria-expanded")) === "true" &&
      (await modeToggle.textContent())?.includes("Show Less"),
  );
  const geometry = await page.locator(LIST).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  check(
    "list is height-capped and overflows internally",
    geometry.maxHeight !== "none" &&
      geometry.overflowY === "auto" &&
      geometry.scrollHeight > geometry.clientHeight,
    `${geometry.clientHeight}/${geometry.scrollHeight}, max=${geometry.maxHeight}`,
  );
  check(
    "opening starts into newly revealed quiet content",
    geometry.scrollTop > 0,
    `scrollTop=${geometry.scrollTop}`,
  );
  const expandedHomeGeometry = await homeGeometry(page);
  check(
    "explicit expansion pushes Apps down while keeping them directly below",
    expandedHomeGeometry.directSibling &&
      expandedHomeGeometry.appsTop > restedHomeGeometry.appsTop + 20 &&
      expandedHomeGeometry.gap >= 0 &&
      expandedHomeGeometry.gap <= 16,
    `appsTop ${restedHomeGeometry.appsTop.toFixed(1)}->${expandedHomeGeometry.appsTop.toFixed(1)}, centerHeight ${restedHomeGeometry.centerHeight.toFixed(1)}->${expandedHomeGeometry.centerHeight.toFixed(1)}, gap=${expandedHomeGeometry.gap.toFixed(1)}`,
  );
  check(
    "bounded notification list, not empty flex, determines the Apps offset",
    expandedHomeGeometry.listHeight < expandedHomeGeometry.listScrollHeight &&
      Math.abs(
        expandedHomeGeometry.appsTop -
          expandedHomeGeometry.centerBottom -
          restedHomeGeometry.gap,
      ) <= 1,
    `list=${expandedHomeGeometry.listHeight.toFixed(1)}/${expandedHomeGeometry.listScrollHeight}, appsGap=${expandedHomeGeometry.gap.toFixed(1)}`,
  );

  await page.locator(LIST).evaluate((element) => {
    element.scrollTop = 0;
  });
  const quietRow = page.locator(ROW).filter({ hasText: "Take the tour" });
  await quietRow.scrollIntoViewIfNeeded();
  const quietBox = await quietRow.boundingBox();
  const beforeNativeWheel = await page.locator(LIST).evaluate((element) =>
    element.scrollTop,
  );
  await page.mouse.move(
    quietBox.x + quietBox.width / 2,
    quietBox.y + quietBox.height / 2,
  );
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(80);
  const afterNativeWheel = await page.locator(LIST).evaluate((element) =>
    element.scrollTop,
  );
  check(
    "native wheel scrolls the bounded list without changing inbox mode",
    afterNativeWheel > beforeNativeWheel && (await inboxMode(page)) === "all",
    `${beforeNativeWheel}->${afterNativeWheel}`,
  );
  if (name === "mobile") {
    await page.locator(LIST).evaluate((element) => {
      element.scrollTop = 0;
    });
    const beforeTouchPan = await page.locator(LIST).evaluate(
      (element) => element.scrollTop,
    );
    await cdpTouchDrag(page, page.locator(LIST), 4, -160, 10);
    await page.waitForTimeout(300);
    const afterTouchPan = await page.locator(LIST).evaluate(
      (element) => element.scrollTop,
    );
    check(
      "continued touch pull scrolls the bounded list without changing inbox mode",
      afterTouchPan > beforeTouchPan && (await inboxMode(page)) === "all",
      `${beforeTouchPan}->${afterTouchPan}`,
    );
  }
  check(
    "obsolete clear and separate collapse controls stay absent",
    (await page.locator('[data-testid="notifications-clear-all"]').count()) ===
      0 &&
      (await page.locator('[data-testid="notification-stack-clear"]').count()) ===
        0 &&
      (await page.locator('[data-testid="notifications-collapse"]').count()) ===
        0,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-expanded.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-expanded.png`);

  // Fanning in all mode remains stack-local and exposes only the fold control.
  await page.locator(LIST).evaluate((element) => {
    element.scrollTop = 0;
  });
  await stack().locator(ROW).click();
  check(
    "stack fan in all mode preserves inbox mode and exposes Show Less only",
    (await page.locator(ROW).count()) === 11 &&
      (await inboxMode(page)) === "all" &&
      (await page.locator('[data-testid="notification-stack-collapse"]').count()) ===
        1 &&
      (await page.locator('[data-testid="notification-stack-clear"]').count()) ===
        0,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-stack-controls.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-stack-controls.png`);
  await page
    .locator('[data-testid="notification-stack-collapse"]')
    .first()
    .click();

  // 5. SWIPE TO DISMISS: drag a row horizontally off the inbox; it leaves the
  //    list (optimistic remove; the mocked-away HTTP write is dead in-browser).
  const beforeSwipe = await page.locator(ROW).count();
  const swipeTarget = page.locator(ROW).filter({ hasText: "Take the tour" });
  await swipeTarget.scrollIntoViewIfNeeded();
  const rowBox = await swipeTarget.boundingBox();
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + 300, rowBox.y + rowBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.waitForFunction(
    ({ sel, expected }) => document.querySelectorAll(sel).length === expected,
    { sel: ROW, expected: beforeSwipe - 1 },
  );
  check(
    "horizontal swipe dismisses the row",
    (await page.locator(ROW).count()) === beforeSwipe - 1,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-after-swipe.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-after-swipe.png`);

  // 6. EXPLICIT COLLAPSE: the same persistent toggle returns to priority mode,
  //    resets the native scrollport, and remains available for the quiet rows
  //    that are still present after the swipe.
  await modeToggle.click();
  await page.waitForFunction(
    (sel) =>
      document.querySelector(sel)?.getAttribute("data-inbox-mode") === "priority",
    LIST,
  );
  const collapsedScrollTop = await page.locator(LIST).evaluate(
    (element) => element.scrollTop,
  );
  check(
    "persistent toggle collapses back to priority mode",
    (await inboxMode(page)) === "priority" &&
      (await page.locator(ROW).count()) === 2 &&
      (await modeToggle.getAttribute("aria-expanded")) === "false" &&
      collapsedScrollTop === 0,
  );
  await page.waitForTimeout(100);
  const collapsedHomeGeometry = await homeGeometry(page);
  check(
    "collapse returns Apps to their original position",
    collapsedHomeGeometry.directSibling &&
      Math.abs(collapsedHomeGeometry.appsTop - restedHomeGeometry.appsTop) <= 2 &&
      collapsedHomeGeometry.gap >= 0 &&
      collapsedHomeGeometry.gap <= 16,
    `appsTop ${expandedHomeGeometry.appsTop.toFixed(1)}->${collapsedHomeGeometry.appsTop.toFixed(1)} (rest=${restedHomeGeometry.appsTop.toFixed(1)}), gap=${collapsedHomeGeometry.gap.toFixed(1)}`,
  );

  if (errors.length) {
    console.log(`  page errors:`, errors);
    failures += 1;
  }
  await page.close();
}
if (HEADFUL) {
  console.log("HEADFUL: holding the window open 8s for live inspection…");
  await new Promise((r) => setTimeout(r, 8000));
}
await browser.close();
server.close();
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
