/**
 * Playwright UI-smoke spec for the Plugin Views Interaction app flow using the
 * real renderer fixture.
 */
import { expect, type Locator, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { VIEW_CASES } from "./plugin-view-cases";

/**
 * Generic per-view interaction coverage for PLUGIN views (#8796).
 *
 * The sibling all-views-interaction.spec covers built-in views; this applies
 * the same "exercise every control, assert no uncaught crash" pass to the
 * dynamically-loaded plugin view bundles (GUI variants), so plugin views get
 * control-level coverage too — not just boot/render. Run with E2E_RECORD=1 for
 * per-view video.
 */

const GUI_CASES = VIEW_CASES.filter((c) => c.viewType === "gui");

const MAX_CLICKS = 20;
const MAX_INPUTS = 6;
const CLICK_SELECTOR =
  "button:visible, [role='button']:visible, [role='tab']:visible, [role='menuitem']:visible, a[href^='#']:visible";
const INPUT_SELECTOR =
  "input:visible:not([type='file']):not([disabled]), textarea:visible:not([disabled])";

/**
 * True when a real pointer landing on the control's center actually hits it (or
 * its own subtree). Mirrors the sibling all-views-interaction guard: a control
 * that is scrolled outside the layout viewport, or that the agent-surface
 * spatial system paints a `data-spatial-kind` box over (the box is the pointer
 * target and re-dispatches to the registered element), is not something a raw
 * Playwright click can drive — so the loop skips it instead of recording a
 * timeout. This is not reduced coverage: an unreachable control cannot be
 * clicked by a user pointer either.
 */
async function isPointerReachable(control: Locator): Promise<boolean> {
  return control.evaluate((el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return top === el || (top ? el.contains(top) : false);
  });
}

async function fillOrToggleInput(input: Locator, index: number): Promise<void> {
  const tagName = ((await input.evaluate((el: Element) => el.tagName)) ?? "")
    .toString()
    .toLowerCase();
  const type = ((await input.getAttribute("type")) ?? "text").toLowerCase();
  const label = (
    [
      await input.getAttribute("aria-label"),
      await input.getAttribute("name"),
      await input.getAttribute("placeholder"),
      await input.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .join(" ") || ""
  ).toLowerCase();
  if (tagName === "textarea") {
    await input.fill(`plugin smoke textarea ${index}`);
    return;
  }
  if (type === "checkbox" || type === "radio") {
    await input.click();
    return;
  }
  if (type === "number" || type === "range") {
    await input.fill("42");
    return;
  }
  if (type === "email" || label.includes("email")) {
    await input.fill("plugin-smoke@example.com");
    return;
  }
  if (type === "url" || label.includes("url")) {
    await input.fill("https://example.com");
    return;
  }
  if (type === "date") {
    await input.fill("2026-06-29");
    return;
  }
  if (type === "datetime-local") {
    await input.fill("2026-06-29T12:00");
    return;
  }
  if (type === "time") {
    await input.fill("12:00");
    return;
  }
  if (type === "month") {
    await input.fill("2026-06");
    return;
  }
  if (type === "week") {
    await input.fill("2026-W27");
    return;
  }
  if (type === "tel" || label.includes("phone")) {
    await input.fill("5550100");
    return;
  }
  if (type === "password") {
    await input.fill("plugin-smoke-password");
    return;
  }
  if (type === "search" || label.includes("search")) {
    await input.fill("plugin smoke");
    return;
  }
  await input.fill(`plugin smoke input ${index}`);
}

test.describe("plugin view interaction coverage", () => {
  for (const view of GUI_CASES) {
    test(`${view.id} — exercise every control, no crash`, async ({ page }) => {
      const pageErrors: string[] = [];
      const actionFailures: string[] = [];
      const networkFailures: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("response", (response) => {
        const status = response.status();
        if (status < 500) return;
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith("/api/")) {
          networkFailures.push(`http ${status}: ${pathname}`);
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return;
        const failureText = request.failure()?.errorText ?? "";
        if (failureText === "net::ERR_ABORTED") return;
        networkFailures.push(`requestfailed: ${url} ${failureText}`);
      });

      await page.setViewportSize({ width: 1440, height: 1000 });
      // Copy-to-clipboard controls (e.g. the wallet address buttons) call
      // navigator.clipboard.writeText; without the grant Chromium throws
      // "Write permission denied" as an uncaught pageerror. Granting it lets the
      // control's real path run instead of failing on a harness permission gap.
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"])
        .catch(() => {
          // Clipboard permission names are Chromium-only; this lane is
          // Chromium-only, so a rejection elsewhere is a harmless no-op.
        });
      await seedAppStorage(page);
      // Scope the pass to the plugin view's own controls: suppress the always-on
      // continuous chat overlay (shell chrome, covered by its own specs). Its
      // aria-hidden drag-handle pill sits over the composer textarea and has no
      // click affordance, so the generic click-loop would otherwise fight it —
      // exactly as the sibling all-views-interaction spec already does.
      await hideChatOverlay(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
      // Let the dynamic bundle mount before exercising controls.
      await expect(page.getByText("Failed to load view")).toHaveCount(0, {
        timeout: 30_000,
      });

      const inputs = page.locator(INPUT_SELECTOR);
      const inputCount = Math.min(await inputs.count(), MAX_INPUTS);
      for (let i = 0; i < inputCount; i += 1) {
        const input = inputs.nth(i);
        try {
          await fillOrToggleInput(input, i);
        } catch (error) {
          actionFailures.push(
            `input ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const clickables = page.locator(CLICK_SELECTOR);
      const clickCount = Math.min(await clickables.count(), MAX_CLICKS);
      for (let i = 0; i < clickCount; i += 1) {
        const liveControls = page.locator(CLICK_SELECTOR);
        if (i >= (await liveControls.count())) {
          break;
        }
        const control = liveControls.nth(i);
        if (!(await control.isVisible().catch(() => false))) {
          continue;
        }
        // A disabled control is intentionally inert; clicking it just waits out
        // the actionability timeout. Skip it rather than record a false failure.
        if (!(await control.isEnabled().catch(() => false))) {
          continue;
        }
        // Skip controls a raw pointer can't land on (off-viewport list rows,
        // agent-surface spatial boxes) — see isPointerReachable.
        if (!(await isPointerReachable(control).catch(() => false))) {
          continue;
        }
        try {
          await control.click({ noWaitAfter: true, timeout: 2_000 });
        } catch (error) {
          actionFailures.push(
            `click ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (!page.url().includes(view.path)) {
          try {
            await openAppPath(page, view.path);
          } catch (error) {
            actionFailures.push(
              `recover ${i}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        try {
          await page.keyboard.press("Escape");
        } catch (error) {
          actionFailures.push(
            `escape ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      expect(
        [...pageErrors, ...actionFailures, ...networkFailures],
        `${view.id}: a control interaction threw an uncaught error`,
      ).toEqual([]);
    });
  }
});
