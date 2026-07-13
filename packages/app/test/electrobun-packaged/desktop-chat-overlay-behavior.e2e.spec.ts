/**
 * Packaged Electrobun e2e for the floating chat-overlay window's interaction
 * contract (fix/14051): the overlay is a proper native component overlay, not a
 * draggable window. It (1) is pinned immovable so the maximized sheet can never
 * be dragged off its frame, (2) becomes the key window when summoned so its
 * composer can take keystrokes (the dockless accessory app is activated), (3)
 * grows the OS window from the pill footprint to the full work area on engage,
 * and (4) closes ALL THE WAY back to the pill on a single click outside the
 * chat — shrinking the window so the rest of the screen (other apps) is
 * clickable again.
 *
 * Drives the real packaged app through the desktop test bridge (`getState`,
 * `showMainWindow`, `eval`) — the same harness the bottom-bar spec uses. Runs
 * only where a packaged launcher exists (CI / local packaged build); self-skips
 * otherwise.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockApiServer } from "./mock-api";
import {
  type DesktopTestBridgeState,
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

test.describe.configure({ mode: "serial" });

const PILL_WIDTH_CEILING = 720;

let harness: PackagedDesktopHarness | null = null;
let api: Awaited<ReturnType<typeof startMockApiServer>> | null = null;
let tempRoot = "";
let launcherResolved = false;

test.beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-chat-overlay-"));
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  ).catch(() => null);
  if (!launcherPath) return;
  launcherResolved = true;

  api = await startMockApiServer({ firstRunComplete: true, port: 0 });
  harness = new PackagedDesktopHarness({
    tempRoot,
    launcherPath,
    apiBase: api.baseUrl,
    extraEnv: { ELIZA_DESKTOP_BOTTOM_BAR: "1" },
  });
  await harness.start({
    bridgeHealthTimeoutMs: 300_000,
    shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
  });
});

test.afterAll(async () => {
  await harness?.stop().catch(() => undefined);
  await api?.close().catch(() => undefined);
  if (tempRoot) {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
});

/** Poll the overlay shell in until its singular ChatOverlay is mounted. */
async function waitForOverlayMounted(h: PackagedDesktopHarness): Promise<void> {
  await expect
    .poll(
      async () =>
        h
          .eval<{ ready: boolean }>(
            `(() => ({ ready: Boolean(document.querySelector('[data-testid="chat-overlay-shell"]')) }))()`,
          )
          .then((r: { ready: boolean }) => r.ready)
          .catch(() => false),
      {
        timeout: 60_000,
        message: "Expected the singular chat overlay to mount.",
      },
    )
    .toBe(true);
}

test("the overlay window is pinned immovable (never draggable)", async () => {
  test.skip(!launcherResolved, "Packaged launcher not built.");
  const h = harness as PackagedDesktopHarness;
  const state: DesktopTestBridgeState = await h.getState();
  expect(state.mainWindow.present).toBe(true);
  // Ground truth read back from the NSWindow: [window setMovable:NO] took, so a
  // user drag on any part of the overlay (incl. the maximized sheet) is inert.
  expect(state.mainWindow.movable).toBe(false);
});

test("summoning the overlay makes it the key window (so the composer can type)", async () => {
  test.skip(!launcherResolved, "Packaged launcher not built.");
  const h = harness as PackagedDesktopHarness;
  await h.showMainWindow();
  await h.focusMainWindow();
  // The dockless accessory app is activated in makeKeyAndOrderFront, so the
  // overlay window becomes key — without this the composer receives no keystrokes.
  await expect
    .poll(async () => (await h.getState()).shell.windowFocused, {
      timeout: 30_000,
      message: "Expected the summoned overlay window to become the key window.",
    })
    .toBe(true);
});

test("engaging the pill grows the OS window from the pill to the full work area", async () => {
  test.skip(!launcherResolved, "Packaged launcher not built.");
  const h = harness as PackagedDesktopHarness;
  await h.showMainWindow();
  await h.focusMainWindow();
  await waitForOverlayMounted(h);

  // Rest at the pill footprint: narrow, so the rest of the screen is click-through.
  await expect
    .poll(async () => (await h.getState()).mainWindow.bounds?.width ?? 0, {
      timeout: 20_000,
      message: "Expected the overlay to rest at the narrow pill footprint.",
    })
    .toBeLessThanOrEqual(PILL_WIDTH_CEILING);

  await h.eval(`(() => {
    window.dispatchEvent(new CustomEvent("eliza:chat:open"));
    return { ok: true };
  })()`);

  await expect
    .poll(async () => (await h.getState()).mainWindow.bounds?.width ?? 0, {
      timeout: 20_000,
      message: "Expected the window to grow past the pill footprint on engage.",
    })
    .toBeGreaterThan(PILL_WIDTH_CEILING);
});

test("a single click outside the chat closes it back to the pill (frees the screen)", async () => {
  test.skip(!launcherResolved, "Packaged launcher not built.");
  const h = harness as PackagedDesktopHarness;
  await h.showMainWindow();
  await h.focusMainWindow();
  await waitForOverlayMounted(h);

  // Open (grow) first.
  await h.eval(`(() => {
    window.dispatchEvent(new CustomEvent("eliza:chat:open"));
    return { ok: true };
  })()`);
  await expect
    .poll(async () => (await h.getState()).mainWindow.bounds?.width ?? 0, {
      timeout: 20_000,
    })
    .toBeGreaterThan(PILL_WIDTH_CEILING);

  // A single click in the empty top-left corner — outside the chat panel — must
  // collapse the desktop overlay ALL the way to the pill (not the mobile
  // two-step, not just the input bar), so the OS window shrinks back to the pill
  // footprint and clicks fall through to other apps again. Drive it with the
  // same synthetic PointerEvents a real click delivers (top-left is over the
  // pointer-transparent backdrop, so the target is the background, not a panel).
  await h.eval(`(() => {
    const opts = {
      clientX: 24, clientY: 24, pointerId: 77, pointerType: "mouse",
      button: 0, buttons: 1, bubbles: true, cancelable: true, isPrimary: true,
    };
    const el = document.elementFromPoint(24, 24) || document.body;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    return { ok: true };
  })()`);

  await expect
    .poll(async () => (await h.getState()).mainWindow.bounds?.width ?? 0, {
      timeout: 20_000,
      message:
        "Expected an outside click to shrink the overlay window back to the pill.",
    })
    .toBeLessThanOrEqual(PILL_WIDTH_CEILING);
});
