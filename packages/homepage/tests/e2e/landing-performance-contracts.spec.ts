/**
 * Browser-level contracts for landing transfer, frame scheduling, and reduced motion.
 */
import { expect, test } from "playwright/test";

declare global {
  interface Window {
    __homepageIdleCallbacks?: Array<{
      id: number;
      callback: () => void;
    }>;
    __homepageWebGlDraws?: number;
    __homepageWebGlDrawsByCanvas?: number[];
    __homepageAmbientTicks?: number;
    __homepageAmbientInterval?: number;
  }
}

async function instrumentWebGlDraws(page: import("playwright/test").Page) {
  await page.addInitScript(() => {
    window.__homepageWebGlDraws = 0;
    window.__homepageWebGlDrawsByCanvas = [];
    window.__homepageAmbientTicks = 0;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (handler, delay = 0, ...args) => {
      if (
        Math.abs(delay - 1_000 / 30) < 0.01 &&
        typeof handler === "function"
      ) {
        window.__homepageAmbientInterval = delay;
        return nativeSetInterval(() => {
          window.__homepageAmbientTicks =
            (window.__homepageAmbientTicks ?? 0) + 1;
          handler(...args);
        }, delay);
      }
      return nativeSetInterval(handler, delay, ...args);
    };
    const wrap = (
      prototype: WebGLRenderingContext | WebGL2RenderingContext,
      method: "drawArrays" | "drawElements",
    ) => {
      const original = prototype[method] as (...args: unknown[]) => unknown;
      Object.defineProperty(prototype, method, {
        configurable: true,
        value(...args: unknown[]) {
          window.__homepageWebGlDraws = (window.__homepageWebGlDraws ?? 0) + 1;
          const context = this as WebGLRenderingContext;
          const canvasIndex = Array.from(
            document.querySelectorAll("canvas"),
          ).indexOf(context.canvas);
          if (canvasIndex >= 0) {
            const counts = window.__homepageWebGlDrawsByCanvas ?? [];
            counts[canvasIndex] = (counts[canvasIndex] ?? 0) + 1;
            window.__homepageWebGlDrawsByCanvas = counts;
          }
          return original.apply(this, args);
        },
      });
    };

    for (const webGlConstructor of [
      window.WebGLRenderingContext,
      window.WebGL2RenderingContext,
    ]) {
      if (!webGlConstructor) continue;
      wrap(webGlConstructor.prototype, "drawArrays");
      wrap(webGlConstructor.prototype, "drawElements");
    }
  });
}

test("phone module and GLB wait for the visible-idle gate", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let nextId = 1;
    window.__homepageIdleCallbacks = [];
    window.requestIdleCallback = (callback) => {
      const id = nextId++;
      window.__homepageIdleCallbacks?.push({
        id,
        callback: () =>
          callback({
            didTimeout: false,
            timeRemaining: () => 16,
          }),
      });
      return id;
    };
    window.cancelIdleCallback = (id) => {
      window.__homepageIdleCallbacks =
        window.__homepageIdleCallbacks?.filter((entry) => entry.id !== id) ??
        [];
    };
  });

  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    "deferred",
  );
  await page.waitForTimeout(300);

  expect(requested.some((url) => url.includes("ModelB"))).toBe(false);
  expect(requested.some((url) => url.includes("iphone-meshopt.glb"))).toBe(
    false,
  );

  await page.waitForFunction(
    () => (window.__homepageIdleCallbacks?.length ?? 0) > 0,
  );
  await page.evaluate(() => {
    const callbacks = window.__homepageIdleCallbacks ?? [];
    window.__homepageIdleCallbacks = [];
    for (const entry of callbacks) entry.callback();
  });

  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    /loading|settled/,
  );
  await expect
    .poll(() => requested.some((url) => url.includes("ModelB")))
    .toBe(true);
  await expect
    .poll(() => requested.some((url) => url.includes("iphone-meshopt.glb")))
    .toBe(true);
});

test("ambient WebGL stays near 30 fps without display-rate RAF churn", async ({
  page,
}) => {
  await instrumentWebGlDraws(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    "settled",
  );
  await page.waitForTimeout(1_500);

  await expect
    .poll(() => page.evaluate(() => window.__homepageAmbientInterval))
    .toBeCloseTo(1_000 / 30, 5);
  const before = await page.evaluate(() => window.__homepageAmbientTicks ?? 0);
  await page.waitForTimeout(1_000);
  const after = await page.evaluate(() => window.__homepageAmbientTicks ?? 0);
  const ticks = after - before;

  expect(ticks).toBeGreaterThan(0);
  expect(ticks).toBeLessThanOrEqual(35);
});

test("reduced motion settles every WebGL surface and phone transition", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await instrumentWebGlDraws(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    "settled",
  );
  await expect(page.locator("canvas")).toHaveCount(2);
  await page.waitForTimeout(1_500);

  const canvases = page.locator("canvas");
  const beforePixels = await canvases.nth(0).screenshot();
  const beforeDraws = await page.evaluate(
    () => window.__homepageWebGlDraws ?? 0,
  );
  await page.waitForTimeout(600);
  const afterPixels = await canvases.nth(0).screenshot();
  const afterDraws = await page.evaluate(
    () => window.__homepageWebGlDraws ?? 0,
  );

  expect(afterPixels.equals(beforePixels)).toBe(true);
  expect(afterDraws - beforeDraws).toBe(0);
});

test("country flags use localized labels and same-origin SVGs", async ({
  page,
}) => {
  await page.goto("/?lang=es", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    "settled",
  );

  const backButton = page.getByRole("button", { name: "Atrás" });
  await expect(backButton).toBeVisible();
  await backButton.click();

  const flag = page.getByRole("img", { name: "Estados Unidos" });
  await expect(flag).toBeVisible();
  const image = flag.locator("img");
  await expect(image).toHaveAttribute("src", "/country-flags/US.svg");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch("/country-flags/US.svg");
        return {
          ok: response.ok,
          type: response.headers.get("content-type"),
          body: await response.text(),
        };
      }),
    )
    .toMatchObject({
      ok: true,
      type: /image\/svg\+xml/,
      body: /<svg/,
    });
  await expect(flag).not.toContainText(/[\u{1F1E6}-\u{1F1FF}]/u);
});
