// Deterministic, headless 3D spatial-scene e2e (issue #9968, renderer split-out).
//
// Drives the REAL XRSpatialScene (@elizaos/ui/spatial) — gallery views placed as
// 3D panels — entirely through the IWER emulator: start a session, place a head +
// controller pose, aim the controller's WORLD ray at a named view element,
// intersect the panel plane in 3D, assert the computed hit equals that element,
// press it (the authored view's handler fires), drag a panel and assert it
// relocates in world space, then capture a screenshot + per-frame pose/hit JSON.
// No headset, byte-stable.
import { expect, test } from "../src/playwright-fixture.ts";
import {
  bootScene,
  clearActions,
  fixtureActions,
  scenePanels,
  setPanels,
} from "./scene-helpers.ts";

test.describe("XR spatial scene — real 3D placement + hit-test", () => {
  test("every gallery view mounts as a visible 3D panel", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    const ids: string[] = await xrPage.page.evaluate(
      () => window.__xrSceneFixture.galleryIds,
    );
    expect(ids.length).toBeGreaterThanOrEqual(12);

    await setPanels(xrPage.page, ids);
    const panels = await scenePanels(xrPage.page);
    expect(panels.length).toBe(ids.length);
    // Every panel is in front of the head (positive depth) and visible.
    for (const p of panels) {
      expect(p.visible).toBe(true);
      expect(p.depth).toBeGreaterThan(0);
    }
  });

  test("controller world ray computes the 3D hit on each gallery view", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    const ids: string[] = await xrPage.page.evaluate(
      () => window.__xrSceneFixture.galleryIds,
    );

    const checked: string[] = [];
    for (const id of ids) {
      await setPanels(xrPage.page, [id]);

      // Prefer a real button (asserts the press path too); else any tagged element.
      const target = await xrPage.page.evaluate(() => {
        const panel = document.querySelector("[data-xr-panel]");
        if (!panel) return null;
        const btn = panel.querySelector(
          "[data-spatial-kind='button'][data-agent-id]",
        ) as HTMLElement | null;
        const el =
          btn ?? (panel.querySelector("[data-agent-id]") as HTMLElement | null);
        return el
          ? {
              agentId: el.dataset.agentId!,
              isButton: el.dataset.spatialKind === "button",
            }
          : null;
      });
      if (!target) continue; // a purely presentational view (no agent ids)

      const aimed = await xrPage.aimControllerAt(
        "right",
        `[data-agent-id="${target.agentId}"]`,
      );
      expect(aimed, `aim ${id}/${target.agentId}`).toBe(true);

      const telemetry = await xrPage.getElementTelemetry();
      expect(telemetry.mode).toBe("scene");
      const hit = telemetry.hits.find((h) => h.source === "right");
      expect(hit?.elementId, `hit ${id}/${target.agentId}`).toBe(
        target.agentId,
      );
      // The hit carries a real world-space intersection point + owning panel.
      expect(hit?.world).toBeDefined();
      expect(hit?.panelId).toBe(id);

      if (target.isButton) {
        await clearActions(xrPage.page);
        await xrPage.pressSelect("right");
        const actions = await fixtureActions(xrPage.page);
        expect(
          actions.some(
            (a) => a.type === "press" && a.agentId === target.agentId,
          ),
          `press ${id}/${target.agentId}`,
        ).toBe(true);
      }
      checked.push(id);
    }
    // We exercised the real hit-test against the great majority of the catalog.
    expect(checked.length).toBeGreaterThanOrEqual(10);
  });

  test("dragging a controller relocates a panel in world space (move action)", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    await setPanels(xrPage.page, ["settings", "wallet"]);

    // Aim at the settings panel, then grab-drag it +0.6 m along world +X.
    expect(
      await xrPage.aimControllerAt("right", '[data-agent-id="save"]'),
    ).toBe(true);
    const before = (await scenePanels(xrPage.page)).find(
      (p) => p.id === "settings",
    );
    expect(before).toBeDefined();

    await clearActions(xrPage.page);
    const moved = await xrPage.dragController("right", { x: 0.6, y: 0, z: 0 });
    expect(moved).not.toBeNull();
    expect(moved!.x).toBeCloseTo(before!.position.x + 0.6, 5);

    const after = (await scenePanels(xrPage.page)).find(
      (p) => p.id === "settings",
    );
    expect(after!.position.x).toBeCloseTo(before!.position.x + 0.6, 5);

    const actions = await fixtureActions(xrPage.page);
    const move = actions.find(
      (a) => a.type === "move" && a.agentId === "settings",
    );
    expect(
      move,
      "a move action was dispatched for the dragged panel",
    ).toBeTruthy();
    expect(move!.position?.x).toBeCloseTo(before!.position.x + 0.6, 5);
  });

  test("captures a 3D scene screenshot + per-frame pose/hit JSON", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    // A readable spread of panels for the evidence shot.
    const shot = ["profile", "settings", "wallet", "confirm", "progress"];
    await setPanels(xrPage.page, shot);

    // Drive the right controller across several panels' buttons to fill the log.
    for (const id of shot) {
      const agentId = await xrPage.page.evaluate((pid) => {
        const panel = document.querySelector(`[data-xr-panel="${pid}"]`);
        const el = panel?.querySelector(
          "[data-spatial-kind='button'][data-agent-id]",
        ) as HTMLElement | null;
        return el?.dataset.agentId ?? null;
      }, id);
      if (!agentId) continue;
      await xrPage.aimControllerAt("right", `[data-agent-id="${agentId}"]`);
      await xrPage.getElementTelemetry();
    }

    const png = await xrPage.captureScreenshot("xr-scene");
    const frames = await xrPage.captureFrameLog("xr-scene");
    expect(png).toMatch(/\.png$/);
    expect(frames).toMatch(/\.frames\.json$/);

    const log = await xrPage.page.evaluate(() =>
      window.__XREmulator.getFrameLog(),
    );
    // Every snapshot is 3D-scene mode with a real headset world pose.
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(log.every((s) => s.mode === "scene")).toBe(true);
  });
});
