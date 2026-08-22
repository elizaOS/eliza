/**
 * Focused real-browser contract for the detached macOS pill presentation.
 *
 * This mounts the canonical ChatOverlay through chat-sheet-fixture.tsx with
 * the same host-boundary props used by Electrobun. It deliberately does not
 * cover native NSWindow bounds or click-through; the packaged-app matrix owns
 * those. It does prove renderer hit-testing against a real clickable underlay,
 * real mouse capture, staged detents, the open-grabber tap contract, and the
 * absence of the normal app's fullscreen morph.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-detached-pill");
await mkdir(outDir, { recursive: true });

// The current shared loopback validator imports these Node-only symbols. The
// fixture never calls them, but esbuild still validates named exports before
// dead-code elimination. Keep the browser stub local to this harness.
const stubNodeNet = {
  name: "detached-pill-node-net-stub",
  setup(build) {
    build.onResolve({ filter: /^node:net$/ }, () => ({
      path: "node:net",
      namespace: "detached-pill-node-net",
    }));
    build.onLoad({ filter: /.*/, namespace: "detached-pill-node-net" }, () => ({
      contents:
        "export class BlockList { addAddress() {} addRange() {} addSubnet() {} check() { return false; } } export const isIP = () => 0;",
      loader: "js",
    }));
  },
};

const fixtureUrl = await writeFixturePage({
  entry: join(here, "chat-sheet-fixture.tsx"),
  outDir,
  htmlName: "detached-pill.html",
  title: "detached pill e2e",
  plugins: [stubElizaCore(), stubNodeNet, stubNodeBuiltins()],
  processShim: true,
  background: "#0a0d16",
  headHtml: "<style>.bg-bg{background-color:#0a0d16}</style>",
});

let failures = 0;
function assert(condition, message) {
  console.log(`${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures += 1;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 820 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const sheet = page.getByTestId("chat-sheet");
const detent = () => sheet.getAttribute("data-detent");
const waitForDetent = (value) =>
  page.waitForFunction(
    (want) =>
      document
        .querySelector('[data-testid="chat-sheet"]')
        ?.getAttribute("data-detent") === want,
    value,
    { timeout: 4000, polling: 50 },
  );

async function visibleBox(testId) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: 4000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${testId} has no visible bounding box`);
  return box;
}

async function assertUnderlayClickThrough(expectedDetent) {
  const materialTestId = expectedDetent === "pill" ? "chat-pill" : "chat-sheet";
  const box = await visibleBox(materialTestId);
  const inset = 3;
  const probes = [
    { name: "top", x: box.x + box.width / 2, y: box.y - inset },
    { name: "top-left", x: box.x - inset, y: box.y - inset },
    { name: "top-right", x: box.x + box.width + inset, y: box.y - inset },
    { name: "left-middle", x: box.x - inset, y: box.y + box.height / 2 },
    { name: "right-middle", x: box.x + box.width + inset, y: box.y + box.height / 2 },
    { name: "left-bottom", x: box.x - inset, y: box.y + box.height - inset },
    { name: "right-bottom", x: box.x + box.width + inset, y: box.y + box.height - inset },
  ];
  const before = await page.evaluate(() => window.__underlayPointerCount ?? 0);
  const targets = await page.evaluate((points) =>
    points.map(({ name, x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        name,
        tag: element?.tagName ?? null,
        testId: element?.getAttribute("data-testid") ?? null,
        className:
          typeof element?.className === "string" ? element.className : null,
      };
    }), probes);
  for (const probe of probes) {
    await page.mouse.click(probe.x, probe.y);
  }
  const after = await page.evaluate(() => window.__underlayPointerCount ?? 0);
  if (after - before !== probes.length) {
    console.log(
      `[detached-pill] ${expectedDetent} underlay targets ${JSON.stringify(targets)}`,
    );
  }
  assert(
    after - before === probes.length,
    `${expectedDetent} passes ${probes.length} edge/corner clicks to the underlying target`,
  );
  assert(
    (await detent()) === expectedDetent,
    `${expectedDetent} is unchanged by outside clicks`,
  );
}

async function pointerDrag(deltaY, { hold = false, slow = true } = {}) {
  // Detached macOS keeps one persistent white-bar node across every detent.
  // Drive that exact physical owner instead of the hidden embedded grabber.
  const target = "chat-pill";
  const box = await visibleBox(target);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const steps = slow ? 12 : 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x, y + (deltaY * step) / steps);
    if (slow) await page.waitForTimeout(28);
  }
  if (slow && deltaY !== 0) {
    await page.waitForTimeout(80);
    await page.mouse.move(x, y + deltaY - Math.sign(deltaY));
    await page.waitForTimeout(28);
  }
  if (!hold) await page.mouse.up();
}

async function settledDrag(deltaY, expected, { slow = true } = {}) {
  await page.evaluate(() => {
    window.__detachedPointerTrace = [];
  });
  await pointerDrag(deltaY, { slow });
  try {
    await waitForDetent(expected);
  } catch (error) {
    const state = await page.evaluate(() => ({
      detent: document
        .querySelector('[data-testid="chat-sheet"]')
        ?.getAttribute("data-detent"),
      trace: window.__detachedPointerTrace,
    }));
    throw new Error(
      `drag ${deltaY}px did not reach ${expected}: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  await page.waitForTimeout(480);
  assert((await detent()) === expected, `real drag ${deltaY}px settles at ${expected}`);
}

try {
  await page.goto(`${fixtureUrl}?desktop-overlay`, {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(() => {
    window.__detachedPointerTrace = [];
    const record = (event) => {
      window.__detachedPointerTrace.push({
        type: event.type,
        clientY: event.clientY,
        screenY: event.screenY,
      });
    };
    document.addEventListener("pointerdown", record, { capture: true });
    document.addEventListener("pointermove", record, { capture: true });
    document.addEventListener("pointerup", record, { capture: true });
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="underlay-click-target"]')
        ?.contentDocument?.readyState === "complete",
  );
  await page.evaluate(() => {
    window.__underlayPointerCount = 0;
  });
  await sheet.waitFor({ state: "visible" });
  await waitForDetent("pill");
  assert((await detent()) === "pill", "detached host starts at the resting pill");
  await assertUnderlayClickThrough("pill");

  await page.getByTestId("chat-pill").click();
  await waitForDetent("collapsed");
  await page.waitForTimeout(480);
  assert((await detent()) === "collapsed", "resting pill click opens the composer");
  await assertUnderlayClickThrough("collapsed");
  assert(
    (await page.getByPlaceholder("Hey Eliza...").count()) === 1,
    'shared composer renders "Hey Eliza..."',
  );
  assert(
    !(await page.locator("body").innerText()).toLowerCase().includes("cerebras"),
    "detached presentation contains no provider branding",
  );

  await settledDrag(-40, "half", { slow: false });
  await assertUnderlayClickThrough("half");
  await settledDrag(-40, "full", { slow: false });
  await assertUnderlayClickThrough("full");
  const detachedTopFade = await page
    .getByTestId("chat-thread-top-fade")
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  assert(
    detachedTopFade === "none",
    "detached transcript top edge has no glow/fade gradient",
  );
  assert(
    (await page.getByTestId("chat-sheet-specular-sheen").count()) === 0,
    "detached sheet mounts no specular sheen layer",
  );

  const before = await sheet.boundingBox();
  const beforeRadius = await sheet.evaluate(
    (element) => getComputedStyle(element).borderRadius,
  );
  await pointerDrag(-180, { hold: true });
  await page.waitForTimeout(180);
  const held = await sheet.boundingBox();
  const heldRadius = await sheet.evaluate(
    (element) => getComputedStyle(element).borderRadius,
  );
  const maximized = await sheet.getAttribute("data-maximized");
  assert(
    !!before &&
      !!held &&
      Math.abs(before.x - held.x) <= 1 &&
      Math.abs(before.width - held.width) <= 1 &&
      beforeRadius === heldRadius &&
      maximized !== "true",
    "held over-pull stays inset with stable width/radius and never maximizes",
  );
  await page.mouse.up();
  await waitForDetent("full");

  await page.getByTestId("chat-pill").click();
  await waitForDetent("collapsed");
  assert(
    (await detent()) === "collapsed",
    "open grabber tap stops at the visible composer",
  );
  await settledDrag(40, "pill");

  // Repeat the whole staged path once to catch state left behind by a prior
  // pointer capture or spring tail.
  await page.getByTestId("chat-pill").click();
  await waitForDetent("collapsed");
  await settledDrag(-40, "half", { slow: false });
  await settledDrag(40, "collapsed");
  await settledDrag(40, "pill");

  assert(consoleErrors.length === 0, "no browser console/page errors");
  await page.screenshot({ path: join(outDir, "detached-pill-final.png") });
} finally {
  await browser.close();
}

if (consoleErrors.length > 0) {
  console.error(consoleErrors.join("\n"));
}
if (failures > 0) {
  console.error(`detached pill E2E failed: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("detached pill E2E passed");
