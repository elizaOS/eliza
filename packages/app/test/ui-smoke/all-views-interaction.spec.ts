import { expect, type Locator, test } from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

/**
 * Generic per-view interaction coverage (#8796).
 *
 * builtin-views-visual.spec only asserts each view *boots*; this spec drives
 * every interactive control in every built-in view — clicking each button /
 * menu item / tab / link and filling each text input — then asserts the view
 * never threw an uncaught page error. It's the automatable form of "every
 * button, input, menu, dropdown works for every view": instead of hand-writing
 * assertions per control, it enumerates the real controls at runtime and
 * exercises them, failing on any crash. Run with E2E_RECORD=1 for video.
 *
 * Clicks that navigate away are recovered by re-opening the route, so one
 * navigation doesn't end coverage of the rest of the page.
 */
const VIEW_ROUTES: Array<{ id: string; path: string }> = [
  { id: "chat", path: "/chat" },
  { id: "phone", path: "/phone" },
  { id: "messages", path: "/messages" },
  { id: "contacts", path: "/contacts" },
  { id: "camera", path: "/camera" },
  { id: "tasks", path: "/apps/tasks" },
  { id: "browser", path: "/browser" },
  { id: "stream", path: "/stream" },
  { id: "apps", path: "/apps" },
  { id: "views", path: "/views" },
  { id: "character", path: "/character" },
  { id: "character-select", path: "/character/select" },
  { id: "automations", path: "/automations" },
  { id: "inventory", path: "/wallet" },
  { id: "documents", path: "/character/documents" },
  { id: "files", path: "/apps/files" },
  { id: "plugins", path: "/apps/plugins" },
  { id: "skills", path: "/apps/skills" },
  { id: "fine-tuning", path: "/apps/fine-tuning" },
  { id: "trajectories", path: "/apps/trajectories" },
  { id: "transcripts", path: "/apps/transcripts" },
  { id: "relationships", path: "/apps/relationships" },
  { id: "memories", path: "/apps/memories" },
  { id: "rolodex", path: "/rolodex" },
  { id: "voice", path: "/settings/voice" },
  { id: "runtime", path: "/apps/runtime" },
  { id: "database", path: "/apps/database" },
  { id: "desktop", path: "/desktop" },
  { id: "settings", path: "/settings" },
  { id: "tutorial", path: "/tutorial" },
  { id: "help", path: "/help" },
  { id: "logs", path: "/apps/logs" },
  { id: "background", path: "/background" },
];

// Bound per-view work so the suite stays under the playwright timeout while
// still exercising a representative breadth of controls.
const MAX_CLICKS = 24;
const MAX_INPUTS = 8;

const CLICK_SELECTOR =
  "button:visible, [role='button']:visible, [role='tab']:visible, [role='menuitem']:visible, a[href^='#']:visible";
const INPUT_SELECTOR =
  "input:visible:not([type='file']):not([disabled]), textarea:visible:not([disabled])";

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
    await input.fill(`smoke textarea ${index}`);
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
    await input.fill("smoke@example.com");
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
    await input.fill("smoke-password");
    return;
  }
  if (type === "search" || label.includes("search")) {
    await input.fill("smoke");
    return;
  }
  await input.fill(`smoke input ${index}`);
}

test.describe("every-view interaction coverage", () => {
  for (const view of VIEW_ROUTES) {
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
      await seedAppStorage(page);
      await hideContinuousChatOverlay(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });

      // Fill text inputs first (some controls become enabled once filled).
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

      // Snapshot clickable controls by accessible name, then click each by name
      // so re-renders/navigation don't invalidate positional handles.
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
        try {
          await control.click({ noWaitAfter: true, timeout: 2_000 });
        } catch (error) {
          actionFailures.push(
            `click ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        // If a click navigated away from the view, return to keep exercising it.
        if (!page.url().includes(view.path) && view.path !== "/") {
          try {
            await openAppPath(page, view.path);
          } catch (error) {
            actionFailures.push(
              `recover ${i}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // Dismiss any opened overlay/menu so the next control is reachable.
        try {
          await page.keyboard.press("Escape");
        } catch (error) {
          actionFailures.push(
            `escape ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // The contract: no interaction in this view caused an uncaught crash.
      expect(
        [...pageErrors, ...actionFailures, ...networkFailures],
        `${view.id}: a control interaction threw an uncaught error`,
      ).toEqual([]);
    });
  }
});
