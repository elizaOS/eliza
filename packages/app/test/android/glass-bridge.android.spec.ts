/**
 * On-device contract for the Android GlassBridge plugin against the real
 * installed APK: native-view lifecycle (insert / replace-on-reattach / animated
 * move / detach) read back from the actual View objects, adversarial rect
 * rejection at the untrusted boundary, and pixel captures proving the tinted
 * native material renders through a real transparency hole.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { expect, test, waitForShellReady } from "./android-harness";

type RegionState = {
  exists: boolean;
  regionCount: number;
  attachedBelowWebView?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
};

type GlassPlugin = {
  isAvailable(): Promise<{ available: boolean }>;
  attachGlass(o: unknown): Promise<{ attached: boolean }>;
  updateRect(o: unknown): Promise<void>;
  detachGlass(o: unknown): Promise<void>;
  getRegionState(o: unknown): Promise<RegionState>;
};

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-glass-bridge",
);

function adb(args: string[], serial: string): Buffer {
  const adbBin = process.env.ANDROID_HOME
    ? `${process.env.ANDROID_HOME}/platform-tools/adb`
    : "adb";
  return execFileSync(adbBin, ["-s", serial, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Mean RGB of a device-pixel rect inside a screencap PNG (2px sampling). */
function meanRgb(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.round(rect.y + rect.height));
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (png.width * y + x) * 4;
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

test("GlassBridge native-view lifecycle, boundary validation, and rendered pixels", async ({
  device,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await waitForShellReady(page);

  const serial = device.serial();
  const sdk = Number.parseInt(
    (await device.shell("getprop ro.build.version.sdk")).toString().trim(),
    10,
  );
  expect(Number.isFinite(sdk)).toBe(true);
  const expectedAvailable = sdk >= 31;

  const CSS_RECT = { x: 40, y: 200, width: 240, height: 180 };
  const MOVED_RECT = { x: 80, y: 320, width: 300, height: 220 };

  const boot = await page.evaluate(async (rect) => {
    const cap = (
      window as unknown as {
        Capacitor?: {
          registerPlugin?: (name: string) => unknown;
          Plugins?: Record<string, unknown>;
        };
      }
    ).Capacitor;
    const plugin = (
      cap?.registerPlugin
        ? cap.registerPlugin("GlassBridge")
        : cap?.Plugins?.GlassBridge
    ) as GlassPlugin | undefined;
    if (!plugin) return { error: "GlassBridge plugin not registered" } as const;
    (window as unknown as { __glass: GlassPlugin }).__glass = plugin;
    const availability = await plugin.isAvailable();
    // Bright saturated tint so the pixel capture proves the panel is OUR
    // native material, not the window background.
    const attach = await plugin.attachGlass({
      id: "e2e-probe",
      rect,
      cornerRadius: 24,
      colorScheme: "dark",
      tintColor: "#ff6600",
    });
    const afterAttach = await plugin.getRegionState({ id: "e2e-probe" });
    // Same-id reattach must REPLACE the region, never stack a second panel.
    const reattach = await plugin.attachGlass({
      id: "e2e-probe",
      rect,
      cornerRadius: 24,
      colorScheme: "dark",
      tintColor: "#ff6600",
    });
    const afterReattach = await plugin.getRegionState({ id: "e2e-probe" });
    return {
      availability,
      attach,
      reattach,
      afterAttach,
      afterReattach,
      dpr: window.devicePixelRatio,
    };
  }, CSS_RECT);
  if ("error" in boot) throw new Error(String(boot.error));

  expect(boot.availability.available).toBe(expectedAvailable);
  expect(boot.attach.attached).toBe(expectedAvailable);
  expect(boot.reattach.attached).toBe(expectedAvailable);
  if (!expectedAvailable) return; // pre-31 device: CSS tier, nothing to render

  // Native truth: exactly one panel, inserted below the WebView, at the
  // device-pixel geometry the CSS rect maps to.
  const dpr = boot.dpr;
  expect(boot.afterAttach.exists).toBe(true);
  expect(boot.afterAttach.regionCount).toBe(1);
  expect(boot.afterAttach.attachedBelowWebView).toBe(true);
  expect(boot.afterAttach.rect?.width).toBeCloseTo(CSS_RECT.width * dpr, -1);
  expect(boot.afterAttach.rect?.height).toBeCloseTo(CSS_RECT.height * dpr, -1);
  expect(boot.afterReattach.regionCount).toBe(1);

  // Rendered pixels: hide the web layer so the page is a true transparency
  // hole, screencap, and prove the tinted native material shows through.
  await page.evaluate(() => {
    const root = document.getElementById("root");
    if (root) root.style.display = "none";
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  });
  await page.waitForTimeout(700);
  const attachedShot = PNG.sync.read(
    adb(["exec-out", "screencap", "-p"], serial),
  );
  // The panel offsets by the WebView's container position; its own reported
  // x/y are container coordinates. For the screen-space sample, use the REAL
  // panel geometry the plugin read back rather than re-deriving it.
  const attachedRect = boot.afterAttach.rect ?? {
    x: CSS_RECT.x * dpr,
    y: CSS_RECT.y * dpr,
    width: CSS_RECT.width * dpr,
    height: CSS_RECT.height * dpr,
  };
  const attachedColor = meanRgb(attachedShot, attachedRect);
  // The orange-tinted material must dominate red over blue; the bare window
  // background (black/neutral) cannot produce this.
  expect(attachedColor.r).toBeGreaterThan(attachedColor.b + 40);
  expect(attachedColor.r).toBeGreaterThan(60);

  // Animated move: the REAL view geometry must land on the new rect.
  const afterMove = await page.evaluate(async (rect) => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    await plugin.updateRect({ id: "e2e-probe", rect });
    await new Promise((resolve) => setTimeout(resolve, 450)); // 150ms anim + slack
    return plugin.getRegionState({ id: "e2e-probe" });
  }, MOVED_RECT);
  expect(afterMove.exists).toBe(true);
  expect(afterMove.rect?.width).toBeCloseTo(MOVED_RECT.width * dpr, -1);
  expect(afterMove.rect?.height).toBeCloseTo(MOVED_RECT.height * dpr, -1);
  const containerOffsetX = (boot.afterAttach.rect?.x ?? 0) - CSS_RECT.x * dpr;
  const containerOffsetY = (boot.afterAttach.rect?.y ?? 0) - CSS_RECT.y * dpr;
  expect(afterMove.rect?.x).toBeCloseTo(
    MOVED_RECT.x * dpr + containerOffsetX,
    -1,
  );
  expect(afterMove.rect?.y).toBeCloseTo(
    MOVED_RECT.y * dpr + containerOffsetY,
    -1,
  );

  const movedShot = PNG.sync.read(adb(["exec-out", "screencap", "-p"], serial));
  const movedColor = meanRgb(movedShot, afterMove.rect ?? attachedRect);
  expect(movedColor.r).toBeGreaterThan(movedColor.b + 40);

  // Adversarial rects: every one must REJECT at the boundary (never clamp),
  // and none may disturb the live region.
  const adversarial = await page.evaluate(async () => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    const bad = [
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: -50, height: 100 },
      { x: 0, y: 0, width: 100, height: Number.NaN },
      { x: Number.POSITIVE_INFINITY, y: 0, width: 100, height: 100 },
      { x: 0, y: 9e9, width: 100, height: 100 },
      { x: 0, y: 0, width: 5_000_000, height: 100 },
    ];
    const rejections: boolean[] = [];
    for (const rect of bad) {
      try {
        await plugin.updateRect({ id: "e2e-probe", rect });
        rejections.push(false);
      } catch {
        rejections.push(true);
      }
    }
    try {
      await plugin.attachGlass({ id: "bad", rect: bad[0], cornerRadius: 0 });
      rejections.push(false);
    } catch {
      rejections.push(true);
    }
    const state = await plugin.getRegionState({ id: "e2e-probe" });
    return { rejections, state };
  });
  expect(adversarial.rejections).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(adversarial.state.exists).toBe(true);
  expect(adversarial.state.regionCount).toBe(1);

  // Detach: the panel leaves the hierarchy, count drops to zero, and the
  // pixels no longer carry the tint.
  const afterDetach = await page.evaluate(async () => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    await plugin.detachGlass({ id: "e2e-probe" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return plugin.getRegionState({ id: "e2e-probe" });
  });
  expect(afterDetach.exists).toBe(false);
  expect(afterDetach.regionCount).toBe(0);

  const detachedShot = PNG.sync.read(
    adb(["exec-out", "screencap", "-p"], serial),
  );
  const detachedColor = meanRgb(detachedShot, attachedRect);
  expect(detachedColor.r).toBeLessThan(attachedColor.r - 40);

  // Restore the web layer for subsequent specs.
  await page.evaluate(() => {
    const root = document.getElementById("root");
    if (root) root.style.display = "";
  });

  // Evidence artifacts: attached / moved / detached screencaps.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const [name, shot] of [
    ["attached", attachedShot],
    ["moved", movedShot],
    ["detached", detachedShot],
  ] as const) {
    const file = path.join(ARTIFACT_DIR, `${name}.png`);
    writeFileSync(file, PNG.sync.write(shot));
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  }
});
