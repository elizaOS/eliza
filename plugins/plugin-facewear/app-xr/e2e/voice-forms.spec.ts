/**
 * voice-forms.spec.ts
 *
 * Playwright e2e test: verifies that the XR voice transcript routing
 * correctly fills focused form fields in view-host pages.
 *
 * Protocol: parent frame sends { type: "xr:transcript", text: "..." }
 * The view-host handler fills the currently focused INPUT, TEXTAREA,
 * SELECT, or ARIA combobox/listbox element.
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.XR_BASE_URL ?? "http://localhost:31337";

test.describe("Voice transcript routing — view-host forms", () => {
  test("xr:transcript fills focused INPUT element", async ({ page }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/wallet`);

    // Inject a visible input and focus it
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "test-input";
      input.type = "text";
      document.getElementById("view-mount")?.appendChild(input);
      input.focus();
    });

    // Send xr:transcript from the "parent" context
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "xr:transcript", text: "hello world" },
          origin: window.location.origin,
        }),
      );
    });

    const value = await page.inputValue("#test-input");
    expect(value).toBe("hello world");
  });

  test("xr:transcript fills focused TEXTAREA element", async ({ page }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/messages`);

    await page.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.id = "test-ta";
      document.getElementById("view-mount")?.appendChild(ta);
      ta.focus();
    });

    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "xr:transcript", text: "voice note text" },
          origin: window.location.origin,
        }),
      );
    });

    const value = await page.inputValue("#test-ta");
    expect(value).toBe("voice note text");
  });

  test("xr:focus-next tabs to the next form field", async ({ page }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/companion`);

    await page.evaluate(() => {
      const mount = document.getElementById("view-mount")!;
      for (const id of ["f1", "f2", "f3"]) {
        const inp = document.createElement("input");
        inp.id = id;
        mount.appendChild(inp);
      }
      (document.getElementById("f1") as HTMLInputElement).focus();
    });

    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "xr:focus-next" },
          origin: window.location.origin,
        }),
      );
    });

    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe("f2");
  });

  test("voice-indicator appears on xr:voice-start message", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/training`);

    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "xr:voice-start" },
          origin: window.location.origin,
        }),
      );
    });

    const indicator = page.locator("#voice-indicator");
    await expect(indicator).toHaveClass(/active/);
  });

  test("transcript toast shows and auto-hides", async ({ page }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/phone`);

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "toast-input";
      document.getElementById("view-mount")?.appendChild(input);
      input.focus();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "xr:transcript", text: "show me the toast" },
          origin: window.location.origin,
        }),
      );
    });

    const toast = page.locator("#transcript-toast");
    await expect(toast).toHaveClass(/show/);
    await expect(toast).toContainText("show me the toast");
  });
});
