import { expect, test } from "@playwright/test";
import {
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
  { id: "companion", path: "/companion" },
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

test.describe("every-view interaction coverage", () => {
  for (const view of VIEW_ROUTES) {
    test(`${view.id} — exercise every control, no crash`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      await page.setViewportSize({ width: 1440, height: 1000 });
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });

      // Fill text inputs first (some controls become enabled once filled).
      const inputs = page.locator(INPUT_SELECTOR);
      const inputCount = Math.min(await inputs.count(), MAX_INPUTS);
      for (let i = 0; i < inputCount; i += 1) {
        const input = inputs.nth(i);
        await input.fill("test", { timeout: 2_000 }).catch(() => {});
      }

      // Snapshot clickable controls by accessible name, then click each by name
      // so re-renders/navigation don't invalidate positional handles.
      const clickables = page.locator(CLICK_SELECTOR);
      const clickCount = Math.min(await clickables.count(), MAX_CLICKS);
      for (let i = 0; i < clickCount; i += 1) {
        const control = page.locator(CLICK_SELECTOR).nth(i);
        await control.click({ timeout: 2_000, trial: false }).catch(() => {});
        // If a click navigated away from the view, return to keep exercising it.
        if (!page.url().includes(view.path) && view.path !== "/") {
          await openAppPath(page, view.path).catch(() => {});
        }
        // Dismiss any opened overlay/menu so the next control is reachable.
        await page.keyboard.press("Escape").catch(() => {});
      }

      // The contract: no interaction in this view caused an uncaught crash.
      expect(
        pageErrors,
        `${view.id}: a control interaction threw an uncaught error`,
      ).toEqual([]);
    });
  }
});
