/**
 * Real integration tests for browser automation via Puppeteer Core.
 *
 * These tests launch a real browser, navigate, and verify CDP operations.
 * Requires Chrome/Edge/Brave installed on the system.
 *
 * Skipped when no browser is available or in headless CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browser_get_context,
  browser_info,
  browser_wait,
  closeBrowser,
  getBrowserClickables,
  getBrowserContext,
  getBrowserInfo,
  getBrowserDom,
  getBrowserState,
  isBrowserAvailable,
  listBrowserTabs,
  navigateBrowser,
  openBrowser,
  openBrowserTab,
  screenshotBrowser,
  scrollBrowser,
} from "../platform/browser.js";

process.env.COMPUTER_USE_BROWSER_HEADLESS ??= "1";

let browserLaunchable = false;
if (isBrowserAvailable() && !process.env.CI) {
  try {
    await openBrowser(
      "data:text/html,<html><head><title>Test Page</title></head><body><h1>Hello</h1></body></html>",
    );
    browserLaunchable = true;
  } catch {
    browserLaunchable = false;
  } finally {
    if (browserLaunchable) {
      await closeBrowser();
    }
  }
}

const describeIfBrowser = browserLaunchable ? describe : describe.skip;

describeIfBrowser("browser automation (real)", () => {
  beforeAll(async () => {
    // Open browser with a simple data URI page
    await openBrowser(
      "data:text/html,<html><head><title>Test Page</title></head><body><h1>Hello</h1><a href='#'>Link</a><button>Click Me</button><input type='text' placeholder='Type here'/></body></html>",
    );
  }, 30000);

  afterAll(async () => {
    await closeBrowser();
  }, 30000);

  it("opens browser and returns state", async () => {
    const state = await getBrowserState();
    expect(state).toHaveProperty("url");
    expect(state).toHaveProperty("title");
    expect(state.title).toBe("Test Page");
  });

  it("exposes browser info and context aliases", async () => {
    const info = await browser_info();
    expect(info.success).toBe(true);
    expect(info.is_open).toBe(true);
    expect(info.title).toBe("Test Page");

    const directInfo = await getBrowserInfo();
    expect(directInfo.success).toBe(true);
    expect(directInfo.title).toBe("Test Page");

    const context = await browser_get_context();
    expect(context.title).toBe("Test Page");

    const directContext = await getBrowserContext();
    expect(directContext.title).toBe("Test Page");
  });

  it("navigates to a new page", async () => {
    const state = await navigateBrowser(
      "data:text/html,<html><head><title>Page 2</title></head><body><p>Content</p></body></html>",
    );
    expect(state.title).toBe("Page 2");

    // Navigate back to test page for subsequent tests
    await navigateBrowser(
      "data:text/html,<html><head><title>Test Page</title></head><body><h1>Hello</h1><a href='#'>Link</a><button>Click Me</button><input type='text' placeholder='Type here'/></body></html>",
    );
  });

  it("captures a browser screenshot as base64 PNG", async () => {
    const b64 = await screenshotBrowser();
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(100);

    // Verify it's valid base64 that decodes to a PNG
    const buf = Buffer.from(b64, "base64");
    // PNG magic: 89 50 4e 47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it("reads DOM content", async () => {
    const html = await getBrowserDom();
    expect(typeof html).toBe("string");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello");
  });

  it("waits for selector and text via browser_wait", async () => {
    const selectorResult = await browser_wait("body", undefined, 2000);
    expect(selectorResult.success).toBe(true);

    const textResult = await browser_wait(undefined, "Hello", 2000);
    expect(textResult.success).toBe(true);
  });

  it("finds clickable elements", async () => {
    // Navigate to a page with interactive elements first
    await navigateBrowser(
      "data:text/html,<html><body><a href='#'>Link</a><button>Btn</button><input type='text'/></body></html>",
    );
    // Wait for DOM
    await new Promise((r) => setTimeout(r, 500));

    const clickables = await getBrowserClickables();
    expect(Array.isArray(clickables)).toBe(true);

    // data: URIs may or may not populate depending on browser security.
    // The key requirement is that it returns an array with correct structure.
    for (const el of clickables) {
      expect(el).toHaveProperty("tag");
      expect(el).toHaveProperty("text");
      expect(el).toHaveProperty("selector");
    }
  });

  it("scrolls without error", async () => {
    await expect(scrollBrowser("down", 100)).resolves.not.toThrow();
    await expect(scrollBrowser("up", 100)).resolves.not.toThrow();
  });

  it("lists tabs", async () => {
    const tabs = await listBrowserTabs();
    expect(Array.isArray(tabs)).toBe(true);
    expect(tabs.length).toBeGreaterThanOrEqual(1);

    const activeTab = tabs.find((t) => t.active);
    expect(activeTab).toBeDefined();
    expect(activeTab).toHaveProperty("id");
    expect(activeTab).toHaveProperty("url");
    expect(activeTab).toHaveProperty("title");
  });

  it("opens a new tab", async () => {
    const tab = await openBrowserTab(
      "data:text/html,<html><head><title>Tab 2</title></head><body>Tab 2</body></html>",
    );
    expect(tab).toHaveProperty("id");
    expect(tab.title).toBe("Tab 2");
    expect(tab.active).toBe(true);

    const tabs = await listBrowserTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    // Navigate back to first tab
    const firstTab = tabs.find((t) => !t.active);
    if (firstTab) {
      const { switchBrowserTab } = await import("../platform/browser.js");
      await switchBrowserTab(firstTab.id);
    }
  });
});

describe("browser availability detection", () => {
  it("isBrowserAvailable returns a boolean", () => {
    const result = isBrowserAvailable();
    expect(typeof result).toBe("boolean");
  });
});
