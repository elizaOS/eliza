// @vitest-environment node
/**
 * Real-browser e2e for the drag-to-resize handles with no web-reachable live
 * mount (#10722 item 5): the conversations `Sidebar` resize handle, the
 * `TasksEventsPanel` widgets-bar resize handle, and the cloud
 * `ResizablePanelGroup` handle. Bundles `resize-handles-fixture.tsx` (the
 * REAL shipped components) with esbuild, loads it in headless Chromium, and
 * drives every handle with genuine staged pointer input — pointer capture,
 * window-level move/up listeners, rAF-coalesced width writes, collapse
 * thresholds, clamping, and localStorage persistence all execute for real.
 *
 * Auto-discovered by `vitest.e2e.config.ts` (`src/**​/__e2e__/**​/*.test.ts`)
 * → `bun run --cwd packages/ui test:e2e` → the repo `test:e2e` lane.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";
import { build, type Plugin as EsbuildPlugin } from "esbuild";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import postcss, { type AcceptedPlugin } from "postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../.."); // packages/ui
const stylesDir = join(uiRoot, "src/styles");
const outDir = join(here, "output-resize-handles");
const toUrl = (p: string) => p.replace(/\\/g, "/");

// Compile the REAL @elizaos/ui Tailwind v4 theme scoped to the rendered
// surfaces so the handle geometry (w-3 gutters, collapse strips) matches the
// shipped pixels, not a CDN approximation.
async function compileTheme(): Promise<string> {
  const input = `@import "tailwindcss" source(none);
@import "${toUrl(join(stylesDir, "base.css"))}";
@import "${toUrl(join(stylesDir, "theme.css"))}";
@import "${toUrl(join(stylesDir, "tailwind-theme.css"))}";
@source "${toUrl(join(uiRoot, "src/components/composites"))}";
@source "${toUrl(join(uiRoot, "src/components/chat"))}";
@source "${toUrl(join(uiRoot, "src/components/ui"))}";
@source "${toUrl(join(uiRoot, "src/cloud-ui/components"))}";
@source "${toUrl(here)}";
`;
  // @tailwindcss/postcss ships its own bundled postcss type declarations, so
  // its plugin type is not nominally the workspace postcss AcceptedPlugin even
  // though the runtime object is a standard postcss plugin (the .mjs __e2e__
  // runners pair the same two packages untyped). Bridge once at the boundary.
  const tailwindPlugin = tailwind() as unknown as AcceptedPlugin;
  const res = await postcss([tailwindPlugin]).process(input, {
    from: toUrl(join(stylesDir, "styles.css")),
  });
  return res.css;
}

// Same browser-stub strategy as the shell __e2e__ runners: the chat/widgets
// import graph transitively reaches server-only @elizaos/core init; replace it
// with an inert proxy for this raw esbuild bundle (production Vite resolves
// core's `browser` export instead).
const stubElizaCore: EsbuildPlugin = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      // Named ESM imports are interop-copied from OWN keys, so the functions
      // WidgetHost/agent-surface actually call must exist as real properties;
      // everything else falls through to the inert proxy.
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
const stubNodeBuiltins: EsbuildPlugin = {
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

async function bundleFixture(): Promise<string> {
  const result = await build({
    entryPoints: [join(here, "resize-handles-fixture.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    // NODE_ENV=test → useAppSelector's provider-less fallback proxy powers the
    // TasksEventsPanel widget slot exactly as it does under vitest.
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [stubElizaCore, stubNodeBuiltins],
    write: false,
  });
  const js = result.outputFiles[0].text;
  const themeCss = await compileTheme();
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>resize handles e2e</title>
<script>
window.process=window.process||{env:{NODE_ENV:"test"},platform:"browser",cwd:function(){return "/"}};
// The widgets bar's AppsSection polls the agent API; this page is file:// and
// hermetic — serve every fetch an empty-ok JSON (list endpoints get [] so
// iteration paths run) so the poll path executes without network noise.
window.fetch=function(input){
  var url=String(input&&input.url?input.url:input);
  var body=/\\/api\\/apps\\/(runs|installed)/.test(url)?"[]":"{}";
  return Promise.resolve(new Response(body,{status:200,headers:{"Content-Type":"application/json"}}));
};
</script>
<style>${themeCss}</style>
<style>html,body{margin:0;height:100%;background:#08080d}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "resize-handles.html");
  await writeFile(htmlPath, html);
  return `file://${htmlPath}`;
}

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no bounding box for ${testId}`);
  return box;
}

/**
 * Staged pointer drag on a resize gutter: down, N moves, up.
 *
 * `grab` picks which horizontal part of the gutter to grip. Both drag gutters
 * hang half OUTSIDE their `overflow-hidden` panel via a negative margin
 * (`-mr-1.5` / `-ml-1.5`), and the clipped outer half is NOT hit-testable —
 * `document.elementFromPoint` on the gutter's centerline already resolves to
 * the panel behind it (verified in Chromium). A real cursor grabs the visible
 * inner half, so the tests do too. (Product note: the effective grab area is
 * ~6px, not the authored 12px — see the leg findings.)
 */
async function dragHandle(
  page: Page,
  testId: string,
  dx: number,
  {
    grab = "center",
    dy = 0,
    steps = 10,
  }: { grab?: "left" | "center" | "right"; dy?: number; steps?: number } = {},
): Promise<void> {
  const box = await boxOf(page, testId);
  const startX =
    grab === "left"
      ? box.x + 3
      : grab === "right"
        ? box.x + box.width - 3
        : box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
  }
  await page.mouse.up();
  // Let the rAF-coalesced width write flush.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
let shot = 0;
async function snap(name: string): Promise<void> {
  shot += 1;
  await page.screenshot({
    path: join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`),
  });
}

beforeAll(async () => {
  const url = await bundleFixture();
  browser = await chromium.launch({
    timeout: Number(process.env.PW_LAUNCH_TIMEOUT_MS || 300_000),
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1100 },
  });
  page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto(url);
  await page.waitForSelector('[data-testid="sidebar-resize-handle"]', {
    timeout: 30_000,
  });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

describe("sidebar resize handle (sidebar-root.tsx)", () => {
  it("drag grows the sidebar and clamps at maxWidth; reverse drag clamps at minWidth", async () => {
    await snap("sidebar-resting");
    const before = await boxOf(page, "fixture-sidebar");
    expect(Math.round(before.width)).toBe(280);

    // Drag right +100 → width 380.
    await dragHandle(page, "sidebar-resize-handle", 100, { grab: "left" });
    const grown = await boxOf(page, "fixture-sidebar");
    expect(grown.width).toBeGreaterThan(before.width + 80);
    await snap("sidebar-grown");

    // Drag far right → clamp at maxWidth 480 (never past).
    await dragHandle(page, "sidebar-resize-handle", 400, { grab: "left" });
    const clamped = await boxOf(page, "fixture-sidebar");
    expect(Math.round(clamped.width)).toBe(480);

    // Drag back left toward minWidth 200 but above the collapse threshold
    // (160): width clamps at 200 and NO collapse fires.
    await dragHandle(page, "sidebar-resize-handle", -300, { grab: "left" });
    const shrunk = await boxOf(page, "fixture-sidebar");
    expect(Math.round(shrunk.width)).toBe(200);
    const collapsedAttr = await page
      .getByTestId("fixture-sidebar")
      .getAttribute("data-collapsed");
    expect(collapsedAttr).toBeNull();
    await snap("sidebar-min-clamped");

    // The aria contract on the handle tracks the live width.
    const handle = page.getByTestId("sidebar-resize-handle");
    expect(await handle.getAttribute("aria-valuenow")).toBe("200");
    expect(await handle.getAttribute("aria-valuemin")).toBe("200");
    expect(await handle.getAttribute("aria-valuemax")).toBe("480");
  }, 120_000);

  it("dragging past the collapse threshold requests collapse (width → 0 rail)", async () => {
    // From minWidth 200, drag left another 80 → below threshold 160 →
    // onCollapseRequest fires → the fixture collapses the sidebar.
    await dragHandle(page, "sidebar-resize-handle", -80, { grab: "left" });
    // The collapsed rail is zero-width (hidden to visibility checks) — wait
    // for attachment and measure layout width directly.
    await page.waitForSelector(
      '[data-testid="fixture-sidebar"][data-collapsed]',
      { timeout: 10_000, state: "attached" },
    );
    // The width animates to the zero-width rail over the collapse transition
    // (~320ms) — poll the settled layout width.
    await expect
      .poll(
        () =>
          page
            .getByTestId("fixture-sidebar")
            .evaluate((el) => (el as HTMLElement).offsetWidth),
        { timeout: 10_000 },
      )
      .toBeLessThan(8);
    // Collapsed state removes the resize handle (resizeActive false).
    expect(
      await page.locator('[data-testid="sidebar-resize-handle"]').count(),
    ).toBe(0);
    await snap("sidebar-collapsed");
  }, 120_000);
});

describe("TasksEventsPanel widgets-bar resize handle", () => {
  it("drag left grows the bar, clamps at max, and persists the width", async () => {
    const bar = await boxOf(page, "chat-widgets-bar");
    expect(Math.round(bar.width)).toBe(320); // WIDGETS_DEFAULT_WIDTH

    // Handle sits on the LEFT edge: dragging left increases width.
    await dragHandle(page, "chat-widgets-resize-handle", -100, { grab: "right" });
    const grown = await boxOf(page, "chat-widgets-bar");
    expect(grown.width).toBeGreaterThan(bar.width + 80);
    await snap("widgets-grown");

    // Clamp at WIDGETS_MAX_WIDTH 560.
    await dragHandle(page, "chat-widgets-resize-handle", -400, { grab: "right" });
    const clamped = await boxOf(page, "chat-widgets-bar");
    expect(Math.round(clamped.width)).toBe(560);

    // Width persists to localStorage once on drag release (mouse.up above).
    const persisted = await page.evaluate(() =>
      localStorage.getItem("eliza:chat:widgets-bar:width"),
    );
    expect(persisted).toBe("560");
  }, 120_000);

  it("dragging right past the collapse threshold collapses to the floating expand strip, and expand restores", async () => {
    // From 560, drag right far enough that the computed width falls under the
    // collapse threshold (200) → onToggleCollapsed(true).
    await dragHandle(page, "chat-widgets-resize-handle", 420, { grab: "right" });
    // The collapsed strip is zero-width (hidden to visibility checks) — wait
    // for attachment and measure layout width directly.
    await page.waitForSelector(
      '[data-testid="chat-widgets-bar"][data-collapsed]',
      { timeout: 10_000, state: "attached" },
    );
    const stripWidth = await page
      .getByTestId("chat-widgets-bar")
      .evaluate((el) => (el as HTMLElement).offsetWidth);
    expect(stripWidth).toBeLessThan(2);
    await snap("widgets-collapsed");

    await page.getByTestId("chat-widgets-expand-floating").click();
    await page.waitForSelector(
      '[data-testid="chat-widgets-bar"]:not([data-collapsed])',
      { timeout: 10_000 },
    );
    // Expanded again at the LAST APPLIED width: on the way to the collapse
    // threshold the drag clamps every applied write at WIDGETS_MIN_WIDTH
    // (240), so that floor is what persisted and what the bar reopens at.
    const expanded = await boxOf(page, "chat-widgets-bar");
    expect(Math.round(expanded.width)).toBe(240);
    const persistedAfter = await page.evaluate(() =>
      localStorage.getItem("eliza:chat:widgets-bar:width"),
    );
    expect(persistedAfter).toBe("240");
    await snap("widgets-expanded-again");
  }, 120_000);
});

describe("cloud ResizablePanelGroup handle", () => {
  it("drag moves the split, respects min/max clamps, and the panels stay complementary", async () => {
    const left = await boxOf(page, "cloud-panel-left");
    const right = await boxOf(page, "cloud-panel-right");
    expect(Math.abs(left.width - right.width)).toBeLessThan(4); // 50/50

    // Drag right +120px in a 600px group → left grows to ~70%.
    await dragHandle(page, "cloud-resize-handle", 120);
    const grownLeft = await boxOf(page, "cloud-panel-left");
    const shrunkRight = await boxOf(page, "cloud-panel-right");
    expect(grownLeft.width).toBeGreaterThan(left.width + 90);
    expect(shrunkRight.width).toBeLessThan(right.width - 90);
    // Complementary: the two panels still fill the group.
    expect(grownLeft.width + shrunkRight.width).toBeGreaterThan(
      left.width + right.width - 20,
    );
    await snap("cloud-split-moved");

    // Drag far right → clamp at maxSize 85% / minSize 15%.
    await dragHandle(page, "cloud-resize-handle", 600);
    const maxLeft = await boxOf(page, "cloud-panel-left");
    const minRight = await boxOf(page, "cloud-panel-right");
    const total = maxLeft.width + minRight.width;
    expect(maxLeft.width / total).toBeLessThan(0.86);
    expect(minRight.width / total).toBeGreaterThan(0.14);
    await snap("cloud-split-clamped");
  }, 120_000);
});

describe("harness health", () => {
  it("no page errors or console errors leaked from the real components", () => {
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
