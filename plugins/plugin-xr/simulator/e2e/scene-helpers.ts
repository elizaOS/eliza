/**
 * Shared helpers for the 3D XRSpatialScene e2e specs (scene / hand-input /
 * gaze-input). The /scene page publishes two globals: `window.__elizaXRScene`
 * (the scene bridge the emulator drives for real 3D hit-tests) and
 * `window.__xrSceneFixture` (panel control + the SpatialActions the authored
 * views dispatched).
 */
import type { Page } from "@playwright/test";
import { expect, type XREmulatorPage } from "../src/playwright-fixture.ts";

/** A SpatialAction dispatched by an authored view (structural mirror of
 * `@elizaos/ui/spatial` context.ts — the fixture owns the canonical type). */
export interface SceneAction {
  type: string;
  agentId?: string;
  position?: { x: number; y: number; z: number };
}

interface SceneFixture {
  /** All gallery view ids available to mount. */
  galleryIds: string[];
  /** Re-mount the scene with exactly these gallery view ids as panels. */
  setPanels(ids: string[]): void;
  /** SpatialActions the scene has dispatched (press/change/submit/move). */
  actions: SceneAction[];
  clearActions(): void;
}

declare global {
  interface Window {
    __xrSceneFixture: SceneFixture;
  }
}

/** Read the scene's per-panel placement directly from the published bridge. */
export async function scenePanels(page: Page) {
  return page.evaluate(() => window.__elizaXRScene!.getPanels());
}

/** The SpatialActions the authored views have dispatched so far. */
export async function fixtureActions(page: Page): Promise<SceneAction[]> {
  return page.evaluate(() => window.__xrSceneFixture.actions);
}

export async function clearActions(page: Page): Promise<void> {
  await page.evaluate(() => window.__xrSceneFixture.clearActions());
}

/** Re-mount exactly these panels and wait for React commit + non-zero layout. */
export async function setPanels(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => window.__xrSceneFixture.setPanels(list), ids);
  // Wait for React to commit exactly these panels.
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-xr-panel]").length === n,
    ids.length,
  );
  // Wait for the scene to lay them out (non-zero rects).
  await page.waitForFunction(() => {
    const wraps = Array.from(document.querySelectorAll("[data-xr-panel]"));
    return (
      wraps.length > 0 &&
      wraps.every((w) => (w as HTMLElement).getBoundingClientRect().width > 1)
    );
  });
}

/** Head pose used by every scene spec: eye height, looking down −Z, matching
 * the panels' auto-arrange height so the scene is centred and deterministic. */
export const SCENE_HEAD_POSE = {
  position: { x: 0, y: 1.6, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
};

/** Boot /scene: bridges up, immersive session started, head at eye height. */
export async function bootScene(xrPage: XREmulatorPage): Promise<void> {
  await xrPage.goto("/scene");
  await xrPage.page.waitForFunction(
    () => !!window.__elizaXRScene && !!window.__xrSceneFixture,
    { timeout: 8000 },
  );
  expect(await xrPage.startSession()).toBe(true);
  expect(await xrPage.page.evaluate(() => window.__XREmulator.hasScene())).toBe(
    true,
  );
  await xrPage.setPose(SCENE_HEAD_POSE);
}
