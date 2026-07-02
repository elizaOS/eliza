// Real-gesture coverage for the kiosk shell's in-canvas view manager
// (#10722 item 5): KioskViewCanvas / FloatingViewWindow title-bar drag had
// ZERO tests anywhere. The kiosk shell (`?shellMode=kiosk`) is the locked
// appliance surface — agent-spawned dynamic views mount as in-window iframes,
// and a `floating` (alwaysOnTop) view is a movable panel dragged by its
// title bar (pointer capture on the header, position state on the wrapper).
//
// The DRAG under test is fully real (staged Playwright mouse through the
// browser's hit-test + pointer-capture pipeline against the real component).
// Only the native-host event SOURCE is seeded: kiosk surfaces arrive over the
// Electrobun `kioskViewEvent` renderer-RPC channel
// (`useKioskViewSurfaces` → `subscribeDesktopBridgeEvent` →
// `window.__ELIZA_ELECTROBUN_RPC__`), which does not exist in a browser
// context — so the spec installs a minimal RPC bridge before boot and emits
// the same `mount`/`unmount` payloads the Electrobun KioskCanvas sends. This
// is the seam's real injection point, not a mock of the component under test.

import { expect, type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";

declare global {
  interface Window {
    __kioskTestEmit?: (payload: unknown) => number;
  }
}

/**
 * Install a minimal Electrobun renderer-RPC bridge before app boot. Listeners
 * registered by the app (`rpc.onMessage(name, fn)`) are stored per-channel;
 * `window.__kioskTestEmit(payload)` fans a payload out to every
 * `kioskViewEvent` listener and returns how many listeners received it.
 */
async function installKioskBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const bridge = {
      onMessage(name: string, fn: (payload: unknown) => void) {
        const set = listeners.get(name) ?? new Set();
        set.add(fn);
        listeners.set(name, set);
      },
      offMessage(name: string, fn: (payload: unknown) => void) {
        listeners.get(name)?.delete(fn);
      },
    };
    (
      window as unknown as { __ELIZA_ELECTROBUN_RPC__: typeof bridge }
    ).__ELIZA_ELECTROBUN_RPC__ = bridge;
    window.__kioskTestEmit = (payload: unknown) => {
      const set = listeners.get("kioskViewEvent");
      if (!set) return 0;
      for (const fn of set) fn(payload);
      return set.size;
    };
  });
}

function floatingMountEvent(windowId: string, title: string) {
  return {
    kind: "mount",
    windowId,
    url: "/kiosk-test-view",
    title,
    width: 320,
    height: 200,
    alwaysOnTop: true,
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installKioskBridge(page);
  // The floating window hosts a sandboxed iframe; serve deterministic bytes
  // for its entrypoint so the view content is real (rendered) but hermetic.
  await page.route("**/kiosk-test-view", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><p>kiosk view body</p></body></html>",
    });
  });
  await page.goto("/?shellMode=kiosk", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("kiosk-shell")).toBeVisible({
    timeout: 120_000,
  });
});

test("kiosk canvas: empty state, floating mount, REAL title-bar drag moves the window, unmount restores empty state", async ({
  page,
}) => {
  // Empty state before any mount event.
  await expect(
    page.getByText("Ask Eliza below to open something."),
  ).toBeVisible({ timeout: 15_000 });

  // Mount a floating view through the real bridge seam. At least one
  // subscriber (useKioskViewSurfaces) must have registered — 0 listeners
  // would mean the seam under test never wired up.
  const delivered = await page.evaluate(
    (payload) => window.__kioskTestEmit?.(payload) ?? 0,
    floatingMountEvent("win-drag", "Drag Me"),
  );
  expect(delivered).toBeGreaterThan(0);

  const titleBar = page.getByText("Drag Me", { exact: true });
  await expect(titleBar).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("Ask Eliza below to open something."),
  ).toHaveCount(0);
  // The iframe rendered the served entrypoint (surface content is real).
  await expect(
    page.frameLocator('iframe[title="Drag Me"]').getByText("kiosk view body"),
  ).toBeVisible({ timeout: 15_000 });

  // The floating wrapper is the title bar's parent (position state lives
  // there: left/top from `position`).
  const windowBox = async () => {
    const box = await titleBar.locator("..").boundingBox();
    if (!box) throw new Error("floating window has no bounding box");
    return box;
  };
  const before = await windowBox();

  // REAL staged pointer drag on the title bar: down → 8 intermediate moves →
  // up, through pointer capture on the header.
  const startX = before.x + before.width / 2;
  const startY = before.y + 14; // inside the h-8 title bar
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(startX + (120 * i) / 8, startY + (90 * i) / 8);
  }
  await page.mouse.up();

  const after = await windowBox();
  expect(after.x - before.x).toBeGreaterThan(100);
  expect(after.y - before.y).toBeGreaterThan(70);

  // Pointer released: further mouse movement must NOT drag the window.
  await page.mouse.move(after.x + after.width / 2, after.y + 14);
  await page.mouse.move(after.x + after.width / 2 + 150, after.y + 200);
  const settled = await windowBox();
  expect(Math.abs(settled.x - after.x)).toBeLessThan(2);
  expect(Math.abs(settled.y - after.y)).toBeLessThan(2);

  // Unmount through the same seam → back to the empty state.
  await page.evaluate((payload) => window.__kioskTestEmit?.(payload), {
    kind: "unmount",
    windowId: "win-drag",
  });
  await expect(
    page.getByText("Ask Eliza below to open something."),
  ).toBeVisible({ timeout: 15_000 });
});

test("kiosk canvas: newest floating view wins, malformed events are ignored, remount replaces by windowId", async ({
  page,
}) => {
  // Adversarial input on the seam: malformed payloads must be dropped
  // without breaking the canvas (isKioskViewEvent guard).
  await page.evaluate(() => {
    window.__kioskTestEmit?.(null);
    window.__kioskTestEmit?.("garbage");
    window.__kioskTestEmit?.({ kind: "explode" });
    window.__kioskTestEmit?.({});
  });
  await expect(
    page.getByText("Ask Eliza below to open something."),
  ).toBeVisible({ timeout: 15_000 });

  // Two floating mounts: only ONE surface is ever rendered (single active
  // view contract) and the newest floating one wins.
  await page.evaluate(
    (payload) => window.__kioskTestEmit?.(payload),
    floatingMountEvent("win-a", "First View"),
  );
  await expect(page.getByText("First View", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(
    (payload) => window.__kioskTestEmit?.(payload),
    floatingMountEvent("win-b", "Second View"),
  );
  await expect(page.getByText("Second View", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("First View", { exact: true })).toHaveCount(0);
  expect(await page.locator("iframe").count()).toBe(1);

  // Re-mount with the SAME windowId replaces (dedupes), not duplicates.
  await page.evaluate(
    (payload) => window.__kioskTestEmit?.(payload),
    floatingMountEvent("win-b", "Second View v2"),
  );
  await expect(page.getByText("Second View v2", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  expect(await page.locator("iframe").count()).toBe(1);

  // Unmounting the hidden older surface leaves the visible one alone;
  // unmounting the visible one falls back to the older... which was removed,
  // so the canvas returns to empty.
  await page.evaluate((payload) => window.__kioskTestEmit?.(payload), {
    kind: "unmount",
    windowId: "win-a",
  });
  await expect(page.getByText("Second View v2", { exact: true })).toBeVisible();
  await page.evaluate((payload) => window.__kioskTestEmit?.(payload), {
    kind: "unmount",
    windowId: "win-b",
  });
  await expect(
    page.getByText("Ask Eliza below to open something."),
  ).toBeVisible({ timeout: 15_000 });
});
