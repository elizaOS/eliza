/**
 * Browser regression run + screenshots for the notification shade, desktop +
 * mobile: rested Z-stacks, real-layout pull expansion, directional wheel
 * behavior, per-stack fan/fold controls, explicit shade collapse, and
 * swipe-to-dismiss. It saves full-page screenshots plus walkthrough video.
 * No app server:
 * bundles the fixture with esbuild (core/node builtins stubbed dead-in-browser)
 * and drives it in headless chromium.
 *
 * Run: bun run --cwd packages/ui test:notifications-e2e
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_FIXTURE_BOOTSTRAP,
  bundleFixture,
  compileTailwindTheme,
  stubElizaCore,
  stubNodeBuiltins,
  withChromium,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-notifications");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const js = await bundleFixture({
  entry: join(here, "notifications-center-fixture.tsx"),
  plugins: [stubElizaCore(), stubNodeBuiltins()],
});
console.log(`bundled (${js.length} bytes)`);

const themeCss = await compileTailwindTheme({
  uiRoot: resolve(here, "../../../.."),
  sources: [resolve(here, ".."), resolve(here, "../../ui")],
});

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>notifications e2e</title>
<style>${themeCss}</style>
<style>html,body{margin:0;height:100%;color:#f4f4f5;font-family:ui-sans-serif,system-ui;
  background-color:#0a0d16;
  background-image:
    radial-gradient(55% 50% at 22% 14%, rgba(255,150,60,0.30), transparent 60%),
    radial-gradient(50% 45% at 80% 82%, rgba(255,90,40,0.20), transparent 60%),
    repeating-linear-gradient(120deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 24px),
    repeating-linear-gradient(30deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 24px);
  background-attachment:fixed;}</style>
<script>${FILE_FIXTURE_BOOTSTRAP}</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "notifications.html");
await writeFile(htmlPath, html);

// Serve over loopback HTTP, not file:// — the Eliza API client refuses to
// fire without an HTTP origin, and a rejected write REVERTS the optimistic
// dismiss (correct app behavior that would fake a swipe regression here).
// Every /api/* write gets a happy ok-JSON so acted-on rows stay acted-on.
const server = createServer((req, res) => {
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
try {
await withChromium({
  headless: !HEADFUL,
  slowMo: HEADFUL ? 120 : 0,
}, async (browser) => {
for (const [name, width, height] of [
  ["desktop", 1280, 900],
  ["mobile", 390, 844],
]) {
  console.log(`\n── ${name} (${width}x${height}) ──`);
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: outDir, size: { width, height } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // Headless: still the entrance + scroll-driven (`animation-timeline: view()`)
  // effects for deterministic pixels and to dodge the headless-shell compositor
  // crash driving view-timeline rows while the scroller transforms. Headful
  // shows the real motion + the SVG backdrop-filter refraction (which
  // headless-shell can't composite), which is the whole point of --headful.
  if (!HEADFUL) await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.error(e.stack ?? e.message); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ROW);
  // Readiness = an applied Tailwind effect. The runtime global lands before
  // the JIT has styled the DOM, so probing the global would still permit an
  // unstyled screenshot.
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-testid="notification-row"]');
    // The row button carries `text-left`; buttons default to center, so left
    // alignment proves the generated utility styles reached the real element.
    return !!row && getComputedStyle(row).textAlign === "left";
  });
  await page.waitForTimeout(200);
  const viewportState = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    visualViewportHeight: window.visualViewport?.height ?? null,
    visualViewportWidth: window.visualViewport?.width ?? null,
  }));
  check(
    `${name} capture uses the requested CSS viewport`,
    viewportState.innerWidth === width && viewportState.innerHeight === height,
    JSON.stringify(viewportState),
  );
  check("populated inbox starts expanded", (await shadeMode(page)) === "expanded");
  const initialList = page.locator(LIST);
  await initialList.hover();
  await page.mouse.wheel(0, 30);
  await page.mouse.wheel(0, 30);
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute("data-shade-mode") === "rested",
    LIST,
  );
  await page.waitForTimeout(500);
  check("rested mode", (await shadeMode(page)) === "rested");
  check(
    "collapsed projection retains the two producer cards",
    (await page.locator(ROW).count()) === 2,
  );
  check(
    "stack top is the urgent row",
    (await page.locator(ROW).first().textContent())?.includes(
      "Build failed on main",
    ),
  );
  check(
    "two producer stacks retain their glass peeks",
    (await page.locator('[data-testid="notification-stack-peek"]').count()) ===
      4,
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
  const restedPreviewFaces = await page
    .locator("[data-notification-stack-preview-content]")
    .evaluateAll((previews) =>
      previews.map((preview) => {
        const style = getComputedStyle(preview);
        return {
          opacity: Number.parseFloat(style.opacity),
          visibility: style.visibility,
        };
      }),
    );
  check(
    "folded stack masks every underlying notification face at rest",
    restedPreviewFaces.length === 4 &&
      restedPreviewFaces.every(
        ({ opacity, visibility }) =>
          opacity === 0 && visibility === "hidden",
      ),
    JSON.stringify(restedPreviewFaces),
  );
  check("collapsed retained cards are hidden from interaction", await page.locator("[data-notification-group]").evaluateAll((groups) => groups.length > 0 && groups.every((group) => group.hasAttribute("inert") && group.getAttribute("aria-hidden") === "true")));
  await pullDown(page);
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-shade-mode") === "expanded", LIST);
  const glass = await page.locator(".eliza-notif-row-surface").first().evaluate((el) => {
    const style = getComputedStyle(el, "::after");
    return { background: style.backgroundColor, border: style.borderTopStyle, width: style.borderTopWidth };
  });
  check(
    "cards paint a visible fill and border",
    glass.background !== "rgba(0, 0, 0, 0)" && glass.border === "solid" && Number.parseFloat(glass.width) > 0,
    JSON.stringify(glass),
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-folded.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-folded.png`);

  // A partial horizontal swipe exposes the actual next notification rather
  // than a blank decorative plate. Release below threshold restores the stack
  // without changing inbox state.
  const restedSwipe = page
    .locator('[data-testid="notification-row-swipe"]')
    .first();
  const restedSwipeBox = await restedSwipe.boundingBox();
  const underlyingPeek = page
    .locator('[data-testid="notification-stack-peek"]')
    .first();
  await page.mouse.move(
    restedSwipeBox.x + 40,
    restedSwipeBox.y + restedSwipeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    restedSwipeBox.x + 124,
    restedSwipeBox.y + restedSwipeBox.height / 2,
    { steps: 8 },
  );
  await page.waitForFunction(() => {
    const content = document.querySelector('[data-testid="notification-stack-peek"] [data-notification-stack-preview-content]');
    return content && getComputedStyle(content).visibility === "visible";
  });
  const underCard = await underlyingPeek.evaluate((peek) => {
    const content = peek.querySelector(
      "[data-notification-stack-preview-content]",
    );
    const title = peek.querySelector("[data-notification-stack-preview-title]");
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      opacity: contentStyle
        ? Number.parseFloat(contentStyle.opacity)
        : Number.NaN,
      title: title?.getAttribute("data-notification-stack-preview-title"),
      renderedTitle: title ? getComputedStyle(title, "::before").content : "",
      visibility: contentStyle?.visibility ?? "",
    };
  });
  const deeperCard = await page
    .locator('[data-testid="notification-stack-peek"]')
    .nth(1)
    .locator("[data-notification-stack-preview-content]")
    .evaluate((content) => {
      const style = getComputedStyle(content);
      return {
        opacity: Number.parseFloat(style.opacity),
        visibility: style.visibility,
      };
    });
  check(
    "partial stack swipe reveals the next notification face",
    underCard.title === "PR #42 approved" &&
      underCard.renderedTitle.includes("PR #42 approved") &&
      underCard.opacity === 1 &&
      underCard.visibility === "visible",
    JSON.stringify(underCard),
  );
  check(
    "partial stack swipe keeps deeper folded faces masked",
    deeperCard.opacity === 0 && deeperCard.visibility === "hidden",
    JSON.stringify(deeperCard),
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-during-stack-swipe.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-during-stack-swipe.png`);
  await page.mouse.up();
  await page.waitForFunction(
    (selector) =>
      !document
        .querySelector(selector)
        ?.getAttribute("style")
        ?.includes("translateX"),
    '[data-testid="notification-row-swipe"]',
  );
  check(
    "cancelled stack swipe restores the original inbox",
    (await page.locator(ROW).count()) === 2,
  );

  check("pull-down expands the shade", (await shadeMode(page)) === "expanded");
  check(
    "stacks persist through the shade expand",
    (await page.locator('[data-testid="notification-stack-peek"]').count()) >
      0,
  );
  // Fan every multi-row group via its peeked cards (headers are gone). Only
  // the peek's bottom sliver protrudes beneath the top card, so click there —
  // a center click would land on the card covering it.
  while (
    (await page.locator('[data-testid="notification-stack-peek"]').count()) > 0
  ) {
    const peek = page
      .locator('[data-testid="notification-stack-peek"]')
      .first();
    const peekBox = await peek.boundingBox();
    await peek.click({
      position: { x: peekBox.width / 2, y: peekBox.height - 3 },
    });
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

  // Direct collapse fades the painted layer and information without applying
  // a second opacity multiplier to the parent; reversing restores the shade.
  const verticalList = page.locator(LIST);
  await verticalList.evaluate((list) => {
    list.scrollTop = 0;
  });
  const verticalListBox = await verticalList.boundingBox();
  const verticalX = verticalListBox.x + verticalListBox.width / 2;
  const verticalStartY = verticalListBox.y + 96;
  await page.mouse.move(verticalX, verticalStartY);
  await page.mouse.down();
  await page.mouse.move(verticalX, verticalStartY - 44, { steps: 8 });
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.hasAttribute("data-shade-dragging"),
    LIST,
  );
  const directCollapseFrame = await verticalList.evaluate((list) => {
    const viewport = list.getBoundingClientRect();
    const visibleGroups = Array.from(
      list.querySelectorAll("[data-notification-group-content]"),
    ).filter((group) => {
      const bounds = group.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    const visibleSurfaces = Array.from(
      list.querySelectorAll(".eliza-notif-row-surface"),
    ).filter((surface) => {
      const bounds = surface.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    const visibleContents = Array.from(
      list.querySelectorAll(".eliza-notif-row-content"),
    ).filter((content) => {
      const bounds = content.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    return {
      contentOpacities: visibleContents.map((content) =>
        Number.parseFloat(getComputedStyle(content).opacity),
      ),
      groupOpacities: visibleGroups.map((group) =>
        Number.parseFloat(getComputedStyle(group).opacity),
      ),
      materialOpacities: visibleSurfaces.map((surface) =>
        Number.parseFloat(getComputedStyle(surface, "::after").opacity),
      ),
      surfaceOpacities: visibleSurfaces.map((surface) =>
        Number.parseFloat(getComputedStyle(surface).opacity),
      ),
    };
  });
  check(
    "direct collapse fades the painted material without fading its parent twice",
    directCollapseFrame.groupOpacities.length > 0 &&
      directCollapseFrame.groupOpacities.every((opacity) => opacity === 1) &&
      directCollapseFrame.surfaceOpacities.every((opacity) => opacity === 1) &&
      directCollapseFrame.materialOpacities.some((opacity) => opacity > 0 && opacity < 1),
    JSON.stringify(directCollapseFrame),
  );
  check(
    "direct collapse still fades card information toward the resting projection",
    directCollapseFrame.contentOpacities.some(
      (opacity) => opacity > 0 && opacity < 1,
    ),
    JSON.stringify(directCollapseFrame.contentOpacities),
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-during-vertical-collapse.png`),
    fullPage: true,
  });
  console.log(
    `  📸 notifications-${name}-during-vertical-collapse.png`,
  );
  await page.mouse.move(verticalX, verticalStartY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (selector) =>
      !document.querySelector(selector)?.hasAttribute("data-shade-dragging"),
    LIST,
  );
  check(
    "reversing direct collapse restores the expanded shade",
    (await shadeMode(page)) === "expanded",
  );

  // Release a short, slow collapse so it starts its cancel animation, then
  // immediately re-grab. The second gesture must take direct ownership:
  // content and painted fill track the finger with no inherited easing.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(50);
  await page.mouse.move(verticalX, verticalStartY);
  await page.mouse.down();
  await page.mouse.move(verticalX, verticalStartY - 28, { steps: 8 });
  await page.waitForTimeout(350);
  await page.mouse.up();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="home-notification-center"]')
      ?.hasAttribute("data-notification-shade-cancelling"),
  );
  await page.mouse.move(verticalX, verticalStartY);
  await page.mouse.down();
  await page.mouse.move(verticalX, verticalStartY - 52, { steps: 8 });
  await page.waitForFunction(
    (selector) => {
      const list = document.querySelector(selector);
      const center = document.querySelector(
        '[data-testid="home-notification-center"]',
      );
      return (
        list?.hasAttribute("data-shade-dragging") &&
        !center?.hasAttribute("data-notification-shade-cancelling")
      );
    },
    LIST,
  );
  const regrabFrame = await verticalList.evaluate((list) => {
    const contents = Array.from(
      list.querySelectorAll(".eliza-notif-row-content"),
    );
    const surfaces = Array.from(
      list.querySelectorAll(".eliza-notif-row-surface"),
    );
    return {
      contentOpacities: contents.map((content) =>
        Number.parseFloat(getComputedStyle(content).opacity),
      ),
      materialOpacities: surfaces.map((surface) =>
        Number.parseFloat(getComputedStyle(surface, "::after").opacity),
      ),
      transitionDurations: contents.map(
        (content) => getComputedStyle(content).transitionDuration,
      ),
    };
  });
  check(
    "an immediate re-grab tracks content and painted material without inherited easing",
    regrabFrame.contentOpacities.some(
      (opacity) => opacity > 0 && opacity < 1,
    ) &&
      regrabFrame.materialOpacities.some((opacity) => opacity > 0 && opacity < 1) &&
      regrabFrame.transitionDurations.every((duration) =>
        duration
          .split(",")
          .every((part) => Number.parseFloat(part.trim()) === 0),
      ),
    JSON.stringify(regrabFrame),
  );
  await page.screenshot({
    path: join(
      outDir,
      `notifications-${name}-during-cancel-regrab.png`,
    ),
    fullPage: true,
  });
  console.log(
    `  📸 notifications-${name}-during-cancel-regrab.png`,
  );
  await page.mouse.move(verticalX, verticalStartY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (selector) =>
      !document.querySelector(selector)?.hasAttribute("data-shade-dragging"),
    LIST,
  );
  check(
    "cancelled re-grab returns to the expanded shade",
    (await shadeMode(page)) === "expanded",
  );
  if (!HEADFUL) await page.emulateMedia({ reducedMotion: "reduce" });

  // 3. STACK FOLD/RESTORE: fanned groups expose controls above their rows.
  //    Folding restores one top card plus its peeks; tapping that stack fans
  //    the same group back out.
  check(
    "fanned stack exposes Show Less and clear controls",
    (await page.locator('[data-testid="notification-stack-controls"]').count()) >
      0 &&
      (await page.locator('[data-testid="notification-stack-collapse"]').count()) >
        0 &&
      (await page.locator('[data-testid="notification-stack-clear"]').count()) >
        0,
  );
  await page
    .locator('[data-testid="notification-stack-collapse"]')
    .first()
    .click();
  await page.waitForFunction(
    ({ rowSelector, peekSelector }) =>
      document.querySelectorAll(rowSelector).length === 5 &&
      document.querySelectorAll(peekSelector).length === 2,
    {
      rowSelector: ROW,
      peekSelector: '[data-testid="notification-stack-peek"]',
    },
  );
  check(
    "Show Less folds the producer back into a stack",
    (await page.locator(ROW).count()) === 5 &&
      (await page.locator('[data-testid="notification-stack-peek"]').count()) ===
        2,
  );
  await page.locator(ROW).first().click();
  await page.waitForFunction(
    (selector) => document.querySelectorAll(selector).length === 7,
    ROW,
  );
  check(
    "tapping the folded stack restores its fanned rows",
    (await page.locator(ROW).count()) === 7,
  );
  await page.screenshot({
    path: join(outDir, `notifications-${name}-stack-controls.png`),
    fullPage: true,
  });
  console.log(`  📸 notifications-${name}-stack-controls.png`);

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

  // 5. DIRECTIONAL SETTLE: fingers-down (negative wheel deltas) while expanded
  //    is a no-op, so trailing trackpad momentum cannot snap the shade shut.
  const listBox = await page.locator(LIST).boundingBox();
  await page.locator(LIST).evaluate((list) => {
    list.scrollTop = 0;
  });
  await page.mouse.move(
    listBox.x + listBox.width / 2,
    listBox.y + listBox.height / 3,
  );
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(120);
  check(
    "fingers-down while expanded does NOT collapse (momentum-proof)",
    (await shadeMode(page)) === "expanded",
  );
  await page.mouse.wheel(0, 30);
  await page.mouse.wheel(0, 30);
  await page.waitForFunction(
    (sel) =>
      document.querySelector(sel)?.getAttribute("data-shade-mode") === "rested",
    LIST,
  );
  check(
    "the upward wheel gesture returns to triage",
    (await shadeMode(page)) === "rested",
  );

  if (errors.length) {
    console.log(`  page errors:`, errors);
    failures += 1;
  }
  const video = page.video();
  await page.close();
  await context.close();
  if (video) {
    await video.saveAs(join(outDir, `notifications-${name}-walkthrough.webm`));
  }
}
if (HEADFUL) {
  console.log("HEADFUL: holding the window open 8s for live inspection…");
  await new Promise((r) => setTimeout(r, 8000));
}
});
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
