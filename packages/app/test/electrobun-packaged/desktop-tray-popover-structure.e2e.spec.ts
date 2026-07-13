/**
 * Packaged Electrobun e2e for the menu-bar tray-popover structure (fix/14051):
 * the popover is the dockless app's "task bar" — Focus Chat at the top, the view
 * rows grouped under a VIEWS section, and Quit at the bottom. The popover is a
 * SEPARATE window from the main pill, so this drives it through the dedicated
 * tray-popover eval channel (`toggleTrayPopover` + `evalTrayPopover`), not the
 * main-window eval seam.
 *
 * Self-skips without a packaged launcher or when the tray popover is not
 * configured (non-macOS).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

test.describe.configure({ mode: "serial" });

interface PopoverStructure {
  shell: boolean;
  focusChat: string | null;
  quit: string | null;
  viewsHeading: boolean;
  viewRows: number;
}

const READ_STRUCTURE = `(() => {
  const q = (s) => document.querySelector(s);
  const text = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, " ").trim() : null);
  return {
    shell: Boolean(q('[data-testid="tray-popover-shell"]')),
    focusChat: text(q('[data-testid="tray-focus-chat"]')),
    quit: text(q('[data-testid="tray-quit"]')),
    viewsHeading: Array.from(document.querySelectorAll("*")).some(
      (el) => el.children.length === 0 && text(el) === "Views",
    ),
    viewRows: document.querySelectorAll('[data-testid^="tray-launcher-row-"]').length,
  };
})()`;

let harness: PackagedDesktopHarness | null = null;
let api: Awaited<ReturnType<typeof startMockApiServer>> | null = null;
let tempRoot = "";
let ready = false;

test.beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-tray-popover-"));
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  ).catch(() => null);
  if (!launcherPath) return;

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

  // The popover surface is macOS-only; skip cleanly where it is not configured.
  const state = await harness.getState();
  ready = Boolean(state.shell.trayPopover?.configured);
  if (ready) {
    await harness.toggleTrayPopover();
  }
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

test("the tray popover shows Focus Chat, a VIEWS section with view rows, and Quit", async () => {
  test.skip(
    !ready,
    "Tray popover not configured (packaged launcher / macOS only).",
  );
  const h = harness as PackagedDesktopHarness;

  await expect
    .poll(
      async () =>
        h.evalTrayPopover<PopoverStructure>(READ_STRUCTURE).catch(() => null),
      {
        timeout: 30_000,
        message: "Expected the tray popover to render its structured surface.",
      },
    )
    .toEqual(
      expect.objectContaining({
        shell: true,
        focusChat: expect.stringContaining("Focus Chat"),
        quit: expect.stringContaining("Quit Eliza"),
        viewsHeading: true,
      }),
    );

  // The view rows sit under the VIEWS section (the "Open Eliza" tray-show-window
  // row is filtered out because Focus Chat owns "open the chat").
  const structure = await h.evalTrayPopover<PopoverStructure>(READ_STRUCTURE);
  expect(structure.viewRows).toBeGreaterThan(0);
});

test("Focus Chat in the popover summons the main chat window", async () => {
  test.skip(
    !ready,
    "Tray popover not configured (packaged launcher / macOS only).",
  );
  const h = harness as PackagedDesktopHarness;

  // Hide the pill first so the summon is an observable change.
  await h.minimizeMainWindow();
  await expect
    .poll(async () => (await h.getState()).shell.windowVisible, {
      timeout: 15_000,
      message: "Expected the main window to hide before the summon.",
    })
    .toBe(false);

  // Click Focus Chat inside the popover — it invokes desktopShowWindow.
  await h.evalTrayPopover(`(() => {
    const btn = document.querySelector('[data-testid="tray-focus-chat"]');
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  })()`);

  await expect
    .poll(async () => (await h.getState()).shell.windowVisible, {
      timeout: 15_000,
      message: "Expected Focus Chat to summon (show) the main chat window.",
    })
    .toBe(true);
});
