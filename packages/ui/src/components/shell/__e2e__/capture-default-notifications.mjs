/**
 * Browser regression run + screenshots for the notification shade, desktop +
 * mobile: rested Z-stacks, the pull-gesture expand/collapse (real mouse drag
 * and wheel — the paths jsdom cannot exercise against real layout),
 * single-open chromeless option strips, and swipe-to-dismiss. No app server:
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

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

/** Mouse-drag straight down from the top of the list — the pull gesture. */
async function pullDown(page) {
  const box = await page.locator(LIST).boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 172, { steps: 10 });
  await page.mouse.up();
}

async function shadeMode(page) {
  return page.locator(LIST).getAttribute("data-shade-mode");
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
  const page = await browser.newPage({ viewport: { width, height } });
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
      const label = document.querySelector(
        '[data-testid="notification-group-label"]',
      );
      return !!label && getComputedStyle(label).textTransform === "uppercase";
    });
  }
  await page.waitForTimeout(200);

  // 1. RESTED: interrupt triage — the task group is a Z-stack (urgent on top,
  //    two glass peeks), the solo system row is flat, the rest hides behind a
  //    passive "N more" hint. No more/less buttons anywhere.
  check("rested mode", (await shadeMode(page)) === "rested");
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
    "stack count names the group size",
    (
      await page
        .locator('[data-testid="notification-stack-count"]')
        .textContent()
    )?.trim() === "3",
  );
  check(
    "passive pull hint counts the hidden rows",
    (
      await page.locator('[data-testid="notifications-pull-hint"]').textContent()
    )?.includes("5 more"),
  );
  check(
    "no show-all / show-less buttons",
    (await page.locator('[data-testid="notifications-show-all"]').count()) ===
      0 &&
      (await page
        .locator('[data-testid="notifications-show-less"]')
        .count()) === 0,
  );
  check(
    "hidden tier not visible at rest",
    (await page.locator("text=Take the tour").count()) === 0,
  );
  const glass = await page
    .locator('[data-testid="notification-row-swipe"]')
    .first()
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

  // 2. PULL TO EXPAND: a real mouse drag down from the list top reveals every
  //    priority tier — but the Z-stacks PERSIST (per-stack fan-out below).
  await pullDown(page);
  await page.waitForFunction(
    (sel) =>
      document
        .querySelector(sel)
        ?.getAttribute("data-shade-mode") === "expanded",
    LIST,
  );
  check("pull-down expands the shade", (await shadeMode(page)) === "expanded");
  check(
    "stacks persist through the shade expand",
    (await page.locator('[data-testid="notification-stack-peek"]').count()) >
      0,
  );
  // Fan every multi-row group via its eyebrow (the peek sliver taps too).
  for (const label of await page
    .locator('[data-testid="notification-group-label"]:not([disabled])')
    .all()) {
    await label.click();
  }
  check("all seven rows visible", (await page.locator(ROW).count()) === 7);
  check(
    "stacks fanned out per group (no peeks left)",
    (await page.locator('[data-testid="notification-stack-peek"]').count()) ===
      0,
  );
  check(
    "onboarding row appears after expand",
    (await page.locator("text=Take the tour").count()) === 1,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-expanded.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-expanded.png`);

  // 3. SINGLE-OPEN CHROMELESS ACTIONS: tapping a row opens its option strip;
  //    tapping another collapses the first; option buttons are bare text.
  await page.locator(ROW).nth(0).click();
  check(
    "tap opens one option strip",
    (await page.locator('[data-testid="notification-row-options"]').count()) ===
      1,
  );
  await page.locator(ROW).nth(1).click();
  check(
    "pressing another row collapses the first (still one strip)",
    (await page.locator('[data-testid="notification-row-options"]').count()) ===
      1 &&
      (await page.locator(ROW).nth(0).getAttribute("aria-expanded")) ===
        "false" &&
      (await page.locator(ROW).nth(1).getAttribute("aria-expanded")) === "true",
  );
  const optionStyle = await page
    .locator('[data-testid="notification-row-options"] button')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      // Tailwind preflight leaves border-style:solid at width 0 on every
      // element — width is the visible truth.
      return { bg: s.backgroundColor, borderWidth: s.borderTopWidth };
    });
  check(
    "options are bare action text (no fill, no border)",
    optionStyle.bg === "rgba(0, 0, 0, 0)" &&
      parseFloat(optionStyle.borderWidth) === 0,
    `${optionStyle.bg} / ${optionStyle.borderWidth}`,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-actions.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-actions.png`);

  // 4. SWIPE TO DISMISS: drag a row horizontally off the shade; it leaves the
  //    list (optimistic remove; the mocked-away HTTP write is dead in-browser).
  const beforeSwipe = await page.locator(ROW).count();
  const rowBox = await page.locator(ROW).nth(1).boundingBox();
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

  // 5. SCROLL BACK UP TO COLLAPSE: wheel-up while the list sits at its top
  //    compresses the shade back to triage.
  const listBox = await page.locator(LIST).boundingBox();
  await page.mouse.move(
    listBox.x + listBox.width / 2,
    listBox.y + listBox.height / 3,
  );
  await page.mouse.wheel(0, -80);
  await page.waitForFunction(
    (sel) =>
      document.querySelector(sel)?.getAttribute("data-shade-mode") === "rested",
    LIST,
  );
  check(
    "wheel-up at the top collapses back to triage",
    (await shadeMode(page)) === "rested",
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
