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
): Promise<void> {
  const screenshotDir =
    process.env.ELIZA_UI_SMOKE_TITLEBAR_SCREENSHOT_DIR?.trim();
  const screenshotPath = screenshotDir
    ? path.join(screenshotDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
  }
  await page.screenshot({ fullPage: false, path: screenshotPath });
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

async function clickLocatorAtVerticalFraction(
  page: Page,
  locator: Locator,
  fraction: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "Expected clickable titlebar control bounds").not.toBeNull();
  if (!box) return;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height * fraction);
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
  await expect(html).toHaveClass(/eliza-electrobun-frameless/);
  await expect(html).toHaveClass(/eliza-electrobun-custom-titlebar/);
  await expect(html).toHaveClass(/eliza-electrobun-macos-titlebar/);
}

async function expectNoMacTitlebarClasses(page: Page): Promise<void> {
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/eliza-electrobun-frameless/);
  await expect(html).not.toHaveClass(/eliza-electrobun-custom-titlebar/);
  await expect(html).not.toHaveClass(/eliza-electrobun-macos-titlebar/);
  await expect(page.getByTestId("desktop-window-titlebar")).toHaveCount(0);
}

async function expectNormalBannerPadding(banner: Locator): Promise<void> {
  const padding = await getPaddingInlineStart(banner);
  expect(
    padding,
    "Non-mac banners should keep their normal px-4 left padding",
  ).toBeGreaterThanOrEqual(15);
  expect(
    padding,
    "Non-mac banners must not reserve macOS traffic-light space",
  ).toBeLessThanOrEqual(20);
}

test.describe("macOS desktop titlebar", () => {
  test.use({ userAgent: MAC_CHROME_USER_AGENT });

  test("desktop titlebar keeps navigation clickable and title area draggable", async ({
    page,
  }, testInfo) => {
    await prepareApp(page);
    await openAppPath(page, "/chat");

    await expectMacTitlebarClasses(page);

    const titlebar = page.getByTestId("desktop-window-titlebar");
    await expect(titlebar).toBeVisible();
    await expect.poll(() => getAppRegion(titlebar)).toBe("drag");

    const appsButton = page.getByTestId("header-nav-button-apps");
    await expect(appsButton).toBeVisible();
    const titlebarBox = await titlebar.boundingBox();
    const chatBox = await page
      .getByTestId("header-nav-button-chat")
      .boundingBox();
    const appsBox = await appsButton.boundingBox();
    expect(titlebarBox, "Expected titlebar bounds").not.toBeNull();
    expect(chatBox, "Expected chat nav button bounds").not.toBeNull();
    expect(appsBox, "Expected app nav button bounds").not.toBeNull();
    if (!titlebarBox || !chatBox || !appsBox) return;
    expect(
      chatBox.x - titlebarBox.x,
      "Desktop nav should reserve left space for macOS traffic lights",
    ).toBeGreaterThanOrEqual(78);
    await expect
      .poll(() =>
        getPaddingInlineStart(
          titlebar.locator("[data-window-titlebar-padding]"),
        ),
      )
      .toBeGreaterThanOrEqual(78);
    expect(
      appsBox.y - titlebarBox.y,
      "Desktop nav should share the traffic-light titlebar row",
    ).toBeLessThanOrEqual(4);
    await attachVisibleScreenshot(page, testInfo, "mac-titlebar-no-banner");
    await expect.poll(() => getAppRegion(appsButton)).toBe("no-drag");
    await clickLocatorAtVerticalFraction(page, appsButton, 0.18);
    await expect(page).toHaveURL(/\/apps$/);

    await openAppPath(page, "/chat");

    const settingsButton = page.getByTestId("header-settings-button");
    await expect(settingsButton).toBeVisible();
    await expect.poll(() => getAppRegion(settingsButton)).toBe("no-drag");
    await clickLocatorAtVerticalFraction(page, settingsButton, 0.5);
    await expect(page).toHaveURL(/\/settings$/);

    await openAppPath(page, "/chat");

    const titleDragZone = page.getByTestId("desktop-window-titlebar-drag-zone");
    await expect(titleDragZone).toBeVisible();
    await expect.poll(() => getAppRegion(titlebar)).toBe("drag");

    const box = await titleDragZone.boundingBox();
    expect(box, "Expected draggable title bounds").not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    await expect(page).toHaveURL(/\/chat$/);
  });

  test("desktop reconnecting banner reserves macOS traffic-light inset", async ({
    page,
  }, testInfo) => {
    await prepareApp(page);
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectMacTitlebarClasses(page);

    const banner = await getReconnectBanner(page);
    await expect
      .poll(() => getPaddingInlineStart(banner))
      .toBeGreaterThanOrEqual(78);

    const titlebar = page.getByTestId("desktop-window-titlebar");
    await expect(titlebar).toBeVisible();
    await expect
      .poll(() =>
        getPaddingInlineStart(
          titlebar.locator("[data-window-titlebar-padding]"),
        ),
      )
      .toBeGreaterThanOrEqual(78);

    const chatButton = page.getByTestId("header-nav-button-chat");
    const bannerBox = await banner.boundingBox();
    const chatBox = await chatButton.boundingBox();
    expect(bannerBox, "Expected reconnecting banner bounds").not.toBeNull();
    expect(chatBox, "Expected chat nav button bounds").not.toBeNull();
    if (!bannerBox || !chatBox) return;
    expect(
      chatBox.x - bannerBox.x,
      "Header nav should remain aligned with the macOS titlebar inset below a banner",
    ).toBeGreaterThanOrEqual(78);

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
