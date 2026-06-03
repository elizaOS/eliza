import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  readLocalStorage,
  seedAppStorage,
} from "./helpers";

test.skip(true, "The legacy homescreen edit surface was removed; / now lands on chat.");

/**
 * Homescreen edit-mode e2e — the client half of the HOMESCREEN action loop.
 *
 * The agent never mutates the renderer directly: it broadcasts an opaque
 * instruction over the view-event bus and the client is the authority that
 * validates the scene document before it reaches the canvas. This spec drives
 * that seam in a real browser (WebGL2 under swiftshader): it opens the home
 * screen, exercises the manual edit chrome, then injects the exact view-event
 * an agent edit would produce — the "mock LLM with perfect output" path — and
 * asserts the client applies a valid scene, rejects a malformed one, and
 * persists the result.
 */

const HOMESCREEN_STORAGE_KEY = "eliza.homescreen.scene";
const VIEW_EVENT_NAME = "elizaos-view-event";

// A perfect model output: the goal's "make the background black" edit, expressed
// as the scene document the HOMESCREEN action would extract and broadcast.
const BLACK_SCENE = JSON.stringify({
  name: "Black",
  background: { kind: "preset", preset: "fresnel-crystal-ball" },
  theme: { accent: [1, 0.345, 0], background: 0 },
});

/** Dispatch the window CustomEvent the bus uses for same-window delivery —
 * identical to what the socket hydrate emits when the agent pushes an edit. */
async function broadcastHomescreenApply(
  page: Page,
  payload: { op: string; sceneJson?: string },
): Promise<void> {
  await page.evaluate(
    ({ eventName, instruction }) => {
      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail: {
            type: "homescreen:apply",
            payload: instruction,
            sourceViewId: "agent",
            timestamp: Date.now(),
          },
        }),
      );
    },
    { eventName: VIEW_EVENT_NAME, instruction: payload },
  );
}

test.describe("homescreen edit mode", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("enters edit mode via the /edit command and toggles the toolbar", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/");

    await expect(page.getByTestId("home-view")).toBeVisible();
    await expect(page.getByTestId("homescreen-canvas")).toBeVisible();

    // Resting state: no on-screen edit button, no toolbar. Edit mode is only
    // reachable via the "/edit" command, a voiced request, or an agent edit.
    await expect(page.getByTestId("homescreen-edit-toggle")).toHaveCount(0);
    await expect(page.getByTestId("homescreen-edit-toolbar")).toHaveCount(0);

    // Typing "/edit" opens the editor instead of sending a chat message, swaps
    // in the full toolbar, and collapses the foreground (composer + apps) to a
    // peekable, non-interactive overlay.
    const input = page.getByTestId("home-chat-input");
    await input.fill("/edit");
    await input.press("Enter");
    await expect(page.getByTestId("homescreen-edit-toolbar")).toBeVisible();
    await expect(page.getByTestId("home-view")).toHaveClass(/opacity-0/);
    // The command is consumed, not sent as a message.
    await expect(input).toHaveValue("");

    for (const name of [
      "Undo",
      "Redo",
      "Duplicate",
      "Reset to default",
      "Delete scene",
    ]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }

    // Done returns to the resting state and restores the foreground.
    await page.getByRole("button", { name: "Done editing" }).click();
    await expect(page.getByTestId("homescreen-edit-toolbar")).toHaveCount(0);
    await expect(page.getByTestId("home-view")).not.toHaveClass(/opacity-0/);
  });

  test("applies a valid agent edit, pops edit mode, and persists the scene", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/");
    await expect(page.getByTestId("homescreen-canvas")).toBeVisible();

    // The agent broadcasts a perfect scene document — exactly the client-side
    // landing point of a real HOMESCREEN edit.
    await broadcastHomescreenApply(page, {
      op: "edit",
      sceneJson: BLACK_SCENE,
    });

    // Any agent edit pops the editor open so the user sees and can revert it.
    await expect(page.getByTestId("homescreen-edit-toolbar")).toBeVisible();
    await expect(page.getByTestId("homescreen-error")).toHaveCount(0);

    // The validated scene is persisted so a reload keeps the customization.
    await expect
      .poll(async () => {
        const raw = await readLocalStorage(page, HOMESCREEN_STORAGE_KEY);
        return raw ? (JSON.parse(raw) as { name?: string }).name : null;
      })
      .toBe("Black");

    // Undo walks back to the default scene; the editor stays open.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => {
        const raw = await readLocalStorage(page, HOMESCREEN_STORAGE_KEY);
        return raw ? (JSON.parse(raw) as { name?: string }).name : null;
      })
      .toBe("Crystal ball");
  });

  test("rejects a malformed agent edit and surfaces an error without crashing", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/");
    await expect(page.getByTestId("homescreen-canvas")).toBeVisible();

    await broadcastHomescreenApply(page, {
      op: "edit",
      sceneJson: "{ not valid json ",
    });

    // The client is the validation authority: a bad document is rejected with a
    // visible error and the prior scene is left untouched.
    await expect(page.getByTestId("homescreen-error")).toBeVisible();
    await expect
      .poll(async () => {
        const raw = await readLocalStorage(page, HOMESCREEN_STORAGE_KEY);
        return raw ? (JSON.parse(raw) as { name?: string }).name : "default";
      })
      .not.toBe("Black");
  });
});
