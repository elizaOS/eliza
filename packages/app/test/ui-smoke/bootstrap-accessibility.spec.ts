/**
 * Exercises the real Bootstrap screen with isolated HTTP collaborators in
 * desktop and coarse-pointer Chromium contexts. Computed contrast and keyboard
 * focus are checked on rendered controls, not source classes or fixture UI.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";

async function openBootstrap(page: Page, baseURL: string | undefined) {
  if (!baseURL)
    throw new Error("Bootstrap browser test requires the app baseURL");
  const origin = new URL(baseURL).origin;
  const writes: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push(url.pathname);
    if (url.origin !== origin) return route.abort();
    const json = (body: object, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() === "GET") {
      if (url.pathname === "/api/auth/status")
        return json({
          required: true,
          authenticated: false,
          bootstrapRequired: true,
          pairingEnabled: false,
          expiresAt: null,
        });
      if (url.pathname === "/api/first-run/status")
        return json({ complete: false, cloudProvisioned: true });
      if (url.pathname === "/api/config") return json({});
      if (url.pathname === "/api/status")
        return json({ state: "running", agentName: "Eliza", canRespond: true });
      if (url.pathname === "/api/auth/me")
        return json({ error: "authentication_required" }, 401);
      if (!url.pathname.startsWith("/api/")) return route.continue();
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/auth/bootstrap/exchange"
    )
      return json({ error: "invalid_token" }, 401);
    return route.abort();
  });
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.addInitScript((apiBase) => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "remote:bootstrap-accessibility",
        kind: "remote",
        label: "Bootstrap accessibility fixture",
        apiBase,
      }),
    );
  }, origin);
  await page.goto("/chat");
  await expect(
    page.getByRole("form", { name: "Bootstrap token entry" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return writes;
}

async function contrastRatio(locator: Locator) {
  return locator.evaluate((element) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas color conversion unavailable");
    const parse = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r / 255, g / 255, b / 255, a / 255];
    };
    const blend = (fg: Color, bg: Color): Color => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]),
      1,
    ];
    const luminance = (c: Color) => {
      const linear = (n: number) =>
        n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      return (
        0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
      );
    };
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      ancestors.unshift(node);
    let background: Color = [1, 1, 1, 1];
    for (const node of ancestors) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none" || Number(style.opacity) !== 1)
        throw new Error(
          "Contrast test needs image/opacity-aware sampling for this surface",
        );
      background = blend(parse(style.backgroundColor), background);
    }
    const foreground = blend(
      parse(getComputedStyle(element).color),
      background,
    );
    const values = [luminance(background), luminance(foreground)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
}

for (const surface of [
  { name: "desktop", viewport: { width: 1280, height: 900 }, hasTouch: false },
  {
    name: "coarse-pointer",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
]) {
  test.describe(surface.name, () => {
    test.use({
      viewport: surface.viewport,
      hasTouch: surface.hasTouch,
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });

    test("Bootstrap help remains readable before and after an error", async ({
      page,
      baseURL,
    }, testInfo) => {
      const writes = await openBootstrap(page, baseURL);
      const helpLink = page.getByRole("link", { name: "Learn more" });
      const helpText = helpLink.locator("..");
      expect(await contrastRatio(helpText)).toBeGreaterThanOrEqual(4.5);
      expect(await contrastRatio(helpLink)).toBeGreaterThanOrEqual(4.5);
      await page
        .getByLabel("Bootstrap token", { exact: true })
        .fill("invalid-accessibility-fixture");
      await page.getByRole("button", { name: "Activate", exact: true }).click();
      await expect(
        page.getByLabel("Bootstrap token", { exact: true }),
      ).toHaveAttribute("aria-invalid", "true");
      expect(await contrastRatio(helpText)).toBeGreaterThanOrEqual(4.5);
      expect(await contrastRatio(helpLink)).toBeGreaterThanOrEqual(4.5);
      expect(writes).toEqual(["/api/auth/bootstrap/exchange"]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath("bootstrap-error.png"),
        fullPage: true,
      });
    });

    test("Bootstrap token has visible keyboard focus and usable touch geometry", async ({
      page,
      baseURL,
    }, testInfo) => {
      await openBootstrap(page, baseURL);
      const input = page.getByLabel("Bootstrap token", { exact: true });
      const paint = () =>
        input.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            border: style.borderColor,
          };
        });
      const rest = await paint();
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      await expect.poll(paint).not.toEqual(rest);
      expect(
        await input.evaluate((element) => element.matches(":focus-visible")),
      ).toBe(true);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(surface.hasTouch);
      if (surface.hasTouch) {
        for (const control of [
          input,
          page.getByRole("button", { name: "Start over" }),
        ]) {
          const box = await control.boundingBox();
          if (!box) throw new Error("Bootstrap control has no layout box");
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
      }
      await page.screenshot({
        path: testInfo.outputPath("bootstrap-focus.png"),
        fullPage: true,
      });
    });
  });
}
