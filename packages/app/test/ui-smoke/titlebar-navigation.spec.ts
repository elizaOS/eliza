/**
 * Playwright UI-smoke spec for the Titlebar Navigation app flow using the real
 * renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.use({
  viewport: { width: 1440, height: 900 },
});

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

async function prepareApp(page: Page): Promise<void> {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
}

/**
 * Connection trouble speaks in the transcript (boot-recovery conductor), never
 * as a floating overlay: the old ConnectionFailedBanner "Reconnecting…" pill
 * was deleted (#13377). Watch the window where that pill used to appear
 * (attempt 1 fired within ~1s of the first close) and assert nothing floats
 * and nothing reserves titlebar space.
 */
async function expectNoFloatingReconnectSurface(page: Page): Promise<void> {
  const pill = page.getByRole("status").filter({ hasText: /Reconnecting/i });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await expect(pill).toHaveCount(0);
    await expect(page.locator("[data-window-titlebar-banner]")).toHaveCount(0);
    await page.waitForTimeout(250);
  }
}

test.describe("web titlebar", () => {
  test("reconnect trouble floats no banner", async ({ page }) => {
    await prepareApp(page);
    await installClosingWebSocket(page);
    await openAppPath(page, "/chat");

    await expectNoFloatingReconnectSurface(page);
  });
});
