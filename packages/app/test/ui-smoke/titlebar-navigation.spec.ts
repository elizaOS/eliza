import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const MAC_CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const WINDOWS_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const LINUX_CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

test.use({
  viewport: { width: 1440, height: 900 },
});

async function seedElectrobunRuntime(page: Page) {
  await page.addInitScript(() => {
    const w = window as Window & {
      __electrobunWindowId?: number;
      __ELIZA_ELECTROBUN_RPC__?: unknown;
    };
    w.__electrobunWindowId = 1;
    w.__ELIZA_ELECTROBUN_RPC__ = {
      offMessage: () => undefined,
      onMessage: () => undefined,
      request: {},
    };
  });
}

async function getAppRegion(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const webkitStyle = style as CSSStyleDeclaration & {
      webkitAppRegion?: string;
    };
    return (
      webkitStyle.webkitAppRegion ||
      style.getPropertyValue("-webkit-app-region")
    ).trim();
  });
}

async function getPaddingInlineStart(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const raw = getComputedStyle(element).paddingInlineStart;
    return Number.parseFloat(raw);
  });
}

async function attachVisibleScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { validateQuality?: boolean } = {},
): Promise<void> {
  const screenshotDir =
    process.env.ELIZA_UI_SMOKE_TITLEBAR_SCREENSHOT_DIR?.trim();
  const screenshotPath = screenshotDir
    ? path.join(screenshotDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
  }
  if (options.validateQuality === false) {
    await page.screenshot({
      fullPage: false,
      path: screenshotPath,
    });
  } else {
    await captureScreenshotWithQualityRetry(page, name, {
      fullPage: false,
      path: screenshotPath,
      attempts: 4,
    });
  }
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
}

async function installClosingWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class ClosingWebSocket extends EventTarget implements WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly CONNECTING = ClosingWebSocket.CONNECTING;
      readonly OPEN = ClosingWebSocket.OPEN;
      readonly CLOSING = ClosingWebSocket.CLOSING;
      readonly CLOSED = ClosingWebSocket.CLOSED;
      readonly extensions = "";
      readonly protocol = "";
      readonly url: string;
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      readyState = ClosingWebSocket.CONNECTING;

      constructor(url: string | URL, _protocols?: string | string[]) {
        super();
        this.url = String(url);
        window.setTimeout(() => this.closeFromBackend(), 0);
      }

      close(code = 1001, reason = "ui-smoke"): void {
        this.closeFromBackend(code, reason, true);
      }

      send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

      private closeFromBackend(
        code = 1001,
        reason = "ui-smoke",
        wasClean = false,
      ): void {
        if (this.readyState === ClosingWebSocket.CLOSED) return;
        this.readyState = ClosingWebSocket.CLOSED;
        const event = new CloseEvent("close", { code, reason, wasClean });
        this.onclose?.call(this, event);
        this.dispatchEvent(event);
      }
    }

    const WebSocketCtor: typeof WebSocket = ClosingWebSocket;

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: WebSocketCtor,
      writable: true,
    });
  });
}

async function prepareApp(
  page: Page,
  options: { electrobunRuntime?: boolean } = {},
): Promise<void> {
  if (options.electrobunRuntime ?? true) {
    await seedElectrobunRuntime(page);
  }
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
}

async function getReconnectBanner(page: Page): Promise<Locator> {
  const banner = page.getByRole("status").filter({ hasText: "Reconnecting" });
  await expect(banner).toHaveCount(1);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Reconnecting");
  return banner;
}

async function expectMacTitlebarClasses(page: Page): Promise<void> {
  const html = page.locator("html");
  // The header-less shell sets only these two (from main.tsx). The removed
  // Header used to add `eliza-electrobun-custom-titlebar`; its absence is what
  // activates the whole-body drag fallback.
  await expect(html).toHaveClass(/eliza-electrobun-frameless/);
  await expect(html).toHaveClass(/eliza-electrobun-macos-titlebar/);
}

async function expectNoMacTitlebarClasses(page: Page): Promise<void> {
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/eliza-electrobun-frameless/);
  await expect(html).not.toHaveClass(/eliza-electrobun-custom-titlebar/);
  await expect(html).not.toHaveClass(/eliza-electrobun-macos-titlebar/);
}

async function expectNormalBannerPadding(banner: Locator): Promise<void> {
  const padding = await getPaddingInlineStart(banner);
  expect(
    padding,
    "The reconnect pill should keep its normal px-4 left padding",
  ).toBeGreaterThanOrEqual(15);
  expect(
    padding,
    "The reconnect pill must not reserve macOS traffic-light space",
  ).toBeLessThanOrEqual(20);
}

test.describe("macOS desktop titlebar", () => {
  test.use({ userAgent: MAC_CHROME_USER_AGENT });

  test("header-less macOS shell keeps the window body draggable", async ({
    page,
  }, testInfo) => {
    await prepareApp(page);
    await openAppPath(page, "/chat");

    await expectMacTitlebarClasses(page);

    // With no Header (so no `eliza-electrobun-custom-titlebar`), the frameless
    // macOS shell falls back to making the whole window body the drag region,
    // so the window stays movable without a custom titlebar. (Interactive
    // elements are still carved back out as `no-drag` by the same stylesheet;
    // on the shipped WKWebView build, dragging is handled by native AppKit.)
    await expect.poll(() => getAppRegion(page.locator("body"))).toBe("drag");

    await attachVisibleScreenshot(page, testInfo, "mac-titlebar-headerless", {
      validateQuality: false,
    });
  });

  test("desktop reconnecting pill floats out of flow and keeps the window draggable", async ({
    page,
  }, testInfo) => {
    await prepareApp(page);
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectMacTitlebarClasses(page);

    // The reconnecting state renders as a floating overlay pill (see
    // ConnectionFailedBanner.tsx): absolutely positioned and click-through, so
    // it consumes no layout height and carries no
    // `data-window-titlebar-banner` — it clears the macOS traffic lights by
    // being centered, not by reserving a padding gutter.
    const banner = await getReconnectBanner(page);
    await expectNormalBannerPadding(banner);

    const wrapper = banner.locator("..");
    await expect
      .poll(() => wrapper.evaluate((el) => getComputedStyle(el).position))
      .toBe("absolute");
    await expect
      .poll(() => wrapper.evaluate((el) => getComputedStyle(el).pointerEvents))
      .toBe("none");

    // With no titlebar-banner attribute in play, the headerless whole-body
    // drag fallback stays active while the pill is visible.
    await expect.poll(() => getAppRegion(page.locator("body"))).toBe("drag");

    // The centered pill starts well right of the traffic-light zone (~78px).
    const box = await banner.boundingBox();
    if (!box) throw new Error("reconnect pill has no bounding box");
    expect(box.x).toBeGreaterThan(90);

    await attachVisibleScreenshot(page, testInfo, "mac-titlebar-with-banner");
  });
});

test.describe("Windows desktop titlebar", () => {
  test.use({ userAgent: WINDOWS_CHROME_USER_AGENT });

  test("reconnecting banner keeps normal padding on Windows", async ({
    page,
  }) => {
    await prepareApp(page);
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectNoMacTitlebarClasses(page);
    await expectNormalBannerPadding(await getReconnectBanner(page));
  });
});

test.describe("Linux desktop titlebar", () => {
  test.use({ userAgent: LINUX_CHROME_USER_AGENT });

  test("reconnecting banner keeps normal padding on Linux", async ({
    page,
  }) => {
    await prepareApp(page);
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectNoMacTitlebarClasses(page);
    await expectNormalBannerPadding(await getReconnectBanner(page));
  });
});

test.describe("web titlebar", () => {
  test("reconnecting banner keeps normal padding without Electrobun runtime", async ({
    page,
  }) => {
    await prepareApp(page, { electrobunRuntime: false });
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectNoMacTitlebarClasses(page);
    await expectNormalBannerPadding(await getReconnectBanner(page));
  });
});
