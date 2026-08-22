/**
 * Deterministic Chromium acceptance for the Devices & Runtimes surface.
 * Covers keyboard order and names, focus visibility under the global outline
 * reset, reduced motion, forced colors, 200% text, and narrow/wide layout.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindPostcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, "../../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-devices-runtimes-a11y");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(condition, message) {
  console.log(`${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures += 1;
}

const bundle = await build({
  entryPoints: [join(here, "devices-runtimes-a11y-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  conditions: ["eliza-source", "browser"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
  absWorkingDir: repoRoot,
});
const js = bundle.outputFiles[0].text;
const bundlePath = join(outDir, "fixture.js");
await writeFile(bundlePath, js);

const cssInput = `
@import "${join(uiSrc, "styles/styles.css")}";
@source "${bundlePath}";
`;
const css = (
  await postcss([tailwindPostcss()]).process(cssInput, {
    from: join(outDir, "fixture-input.css"),
  })
).css;

const html = `<!doctype html>
<html class="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Devices &amp; Runtimes accessibility acceptance</title>
    <style>${css}</style>
    <style>html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}</style>
  </head>
  <body><div id="root"></div><script>Date.now=()=>Date.parse("2099-01-01T00:00:00.000Z")</script><script>${js}</script></body>
</html>`;
const htmlPath = join(outDir, "fixture.html");
await writeFile(htmlPath, html);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
await page.goto(`file://${htmlPath}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="devices-runtimes"]');

const reducedMotion = await page.evaluate(() =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches,
);
assert(reducedMotion, "prefers-reduced-motion is active in the real browser");
const transitionSeconds = await page
  .getByRole("button", { name: "Refresh", exact: true })
  .evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((duration) => {
        const value = Number.parseFloat(duration);
        return duration.trim().endsWith("ms") ? value / 1_000 : value;
      }),
  );
assert(
  transitionSeconds.every((duration) => duration <= 0.000_01),
  `reduced motion collapses transitions (${transitionSeconds.join(", ")}s)`,
);

const wideBoxes = await Promise.all(
  ["local", "cloud"].map((id) =>
    page.locator(`[data-testid="runtime-target-${id}"]`).boundingBox(),
  ),
);
assert(
  wideBoxes.every(Boolean) &&
    Math.abs(wideBoxes[0].y - wideBoxes[1].y) < 2 &&
    wideBoxes[1].x > wideBoxes[0].x,
  "wide layout renders runtime cards in two columns",
);
await page.screenshot({
  path: join(outDir, "wide.png"),
  animations: "disabled",
  fullPage: true,
});

for (const name of [
  "Copy session ID",
  "Refresh",
  "Use runtime",
  "Pair device",
  "Retry",
  "Revoke",
  "Remove",
  "Stop relay",
  "Revoke host",
  "Approve this pairing on this Linux computer",
]) {
  assert(
    (await page.getByRole("button", { name, exact: true }).count()) === 1,
    `screen-reader button name is unique: ${name}`,
  );
}
assert(
  (await page.getByRole("img", {
    name: "QR code for this one-use pairing session",
  }).count()) === 1,
  "pairing QR exposes a screen-reader name",
);

async function activeDescriptor() {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) {
      return `input:${[...active.labels]
        .map((label) => label.textContent?.trim())
        .filter(Boolean)
        .join(" ")}`;
    }
    if (active instanceof HTMLButtonElement) {
      return `button:${active.innerText.trim().replace(/\s+/g, " ")}`;
    }
    if (active instanceof HTMLElement && active.tagName === "SUMMARY") {
      return `summary:${active.innerText.trim().replace(/\s+/g, " ")}`;
    }
    return `${active?.tagName.toLowerCase() ?? "none"}:unnamed`;
  });
}

const expectedInitialOrder = [
  "button:Copy session ID",
  "button:Refresh",
  "button:Use runtime",
  "button:Pair device",
  "button:Retry",
  "button:Revoke",
  "button:Remove",
  "button:Stop relay",
  "button:Revoke host",
  "button:Approve this pairing on this Linux computer",
  "input:6-digit code",
  "summary:Advanced SSH",
];
await page.locator("body").click({ position: { x: 2, y: 2 } });
const actualInitialOrder = [];
for (let index = 0; index < expectedInitialOrder.length; index += 1) {
  await page.keyboard.press("Tab");
  actualInitialOrder.push(await activeDescriptor());
  const focusStyle = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return {
      outline: style.outlineStyle,
      borderStyle: style.borderStyle,
      borderWidth: Number.parseFloat(style.borderTopWidth),
      decoration: style.textDecorationLine,
    };
  });
  assert(
    focusStyle.outline === "none" &&
      focusStyle.borderStyle === "solid" &&
      focusStyle.borderWidth >= 2 &&
      focusStyle.decoration.includes("underline"),
    `tab stop ${index + 1} has a visible filled/bordered/underlined focus state`,
  );
}
assert(
  JSON.stringify(actualInitialOrder) === JSON.stringify(expectedInitialOrder),
  `keyboard order and names match: ${actualInitialOrder.join(" -> ")}`,
);

await page.keyboard.press("Enter");
assert(
  await page.locator("details").evaluate((details) => details.open),
  "Advanced SSH expands from the keyboard",
);
const expectedSshOrder = [
  "input:Name",
  "input:SSH target",
  "input:SSH port",
  "input:Remote Eliza port",
  "input:Private key path (optional)",
  "input:Runtime access token (optional)",
];
const actualSshOrder = [];
for (const _expected of expectedSshOrder) {
  await page.keyboard.press("Tab");
  actualSshOrder.push(await activeDescriptor());
}
assert(
  JSON.stringify(actualSshOrder) === JSON.stringify(expectedSshOrder),
  `expanded SSH fields stay in label order: ${actualSshOrder.join(" -> ")}`,
);

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo(0, 0));
const narrowBoxes = await Promise.all(
  ["local", "cloud"].map((id) =>
    page.locator(`[data-testid="runtime-target-${id}"]`).boundingBox(),
  ),
);
assert(
  narrowBoxes.every(Boolean) &&
    Math.abs(narrowBoxes[0].x - narrowBoxes[1].x) < 2 &&
    narrowBoxes[1].y > narrowBoxes[0].y,
  "narrow layout stacks runtime cards in one column",
);
await page.screenshot({
  path: join(outDir, "narrow.png"),
  animations: "disabled",
  fullPage: true,
});

const normalTextSize = await page
  .getByRole("button", { name: "Refresh", exact: true })
  .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
await page.evaluate(() => {
  document.documentElement.style.fontSize = "32px";
});
await page.evaluate(() => new Promise(requestAnimationFrame));
const scaled = await page.evaluate(() => {
  const root = document.documentElement;
  const controls = [...document.querySelectorAll("button,input,summary")];
  const viewportWidth = root.clientWidth;
  return {
    textSize: Number.parseFloat(
      getComputedStyle(
        document.querySelector('[data-testid="devices-runtimes"] button'),
      ).fontSize,
    ),
    horizontalOverflow: root.scrollWidth - viewportWidth,
    clippedControls: controls.filter((control) => {
      const rect = control.getBoundingClientRect();
      return rect.left < -1 || rect.right > viewportWidth + 1;
    }).length,
    clippedElements: [
      ...document.querySelectorAll('[data-testid="devices-runtimes"] *'),
    ].filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        (rect.left < -1 || rect.right > viewportWidth + 1)
      );
    }).length,
  };
});
assert(
  scaled.textSize >= normalTextSize * 1.95,
  `200% root text setting scales control text (${normalTextSize}px -> ${scaled.textSize}px)`,
);
assert(
  scaled.horizontalOverflow <= 1 &&
    scaled.clippedControls === 0 &&
    scaled.clippedElements === 0,
  `200% text stays within the narrow viewport (overflow ${scaled.horizontalOverflow}px, clipped controls ${scaled.clippedControls}, clipped elements ${scaled.clippedElements})`,
);
await page.screenshot({
  path: join(outDir, "narrow-200-percent-text.png"),
  animations: "disabled",
  fullPage: true,
});

await page.evaluate(() => {
  document.documentElement.style.fontSize = "";
  document.activeElement?.blur();
});
await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
assert(
  await page.evaluate(() =>
    window.matchMedia("(forced-colors: active)").matches,
  ),
  "forced-colors mode is active in the real browser",
);
const copyButton = page.getByRole("button", {
  name: "Copy session ID",
  exact: true,
});
const unfocusedForcedBackground = await copyButton.evaluate(
  (element) => getComputedStyle(element).backgroundColor,
);
await page.locator("body").click({ position: { x: 2, y: 2 } });
await page.keyboard.press("Tab");
const forcedFocus = await copyButton.evaluate((element) => {
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    color: style.color,
    borderWidth: Number.parseFloat(style.borderTopWidth),
    focusedForcedColorAdjust: style.forcedColorAdjust,
    forcedColorAdjust: getComputedStyle(
      document.querySelector('[data-testid="devices-runtimes"]'),
    ).forcedColorAdjust,
  };
});
assert(
  forcedFocus.forcedColorAdjust === "auto" &&
    forcedFocus.focusedForcedColorAdjust === "none" &&
    forcedFocus.borderWidth >= 2 &&
    forcedFocus.color !== forcedFocus.background &&
    forcedFocus.background !== unfocusedForcedBackground,
  "forced-colors preserves a distinct system-colored keyboard focus state",
);
await page.screenshot({
  path: join(outDir, "forced-colors-focus.png"),
  animations: "disabled",
  fullPage: true,
});

assert(
  pageErrors.length === 0,
  `fixture has no uncaught page errors: ${pageErrors[0] ?? "none"}`,
);

await context.close();
await browser.close();

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log(`\n✅ Devices & Runtimes accessibility acceptance passed (${outDir})`);
