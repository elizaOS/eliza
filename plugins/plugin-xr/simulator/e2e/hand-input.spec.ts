// Real hand-tracking input e2e (issue #10722).
//
// Drives IWER's XRHandInput (`oculus-hand` profile) end to end, no headset:
// connect a hand in a named pose (IWER ships default/pinch/point), aim its
// target ray at a named element, read the computed hit back, and pinch-select.
// The pinch is IWER's actual hand input pipeline — the hand's analog "pinch"
// gamepad button (eventTrigger "select", iwer/lib/device/XRHandInput.js) pulses
// across real session frames, so the session fires selectstart/select/selectend
// from the HAND XRInputSource; in the 3D scene the hand ray press clicks the
// authored view's real handler through the panel hit-test. No synthetic
// dispatchEvent stands in for the input pipeline.
import { expect, test } from "../src/playwright-fixture.ts";
import {
  bootScene,
  clearActions,
  fixtureActions,
  scenePanels,
  setPanels,
} from "./scene-helpers.ts";

test.describe("XR hand input — pose → pinch ray → hit → select", () => {
  test("flat: a pinch-posed hand aims at a named element and fires the hand select", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    // No hands are reported until the harness activates one.
    let telemetry = await xrPage.getElementTelemetry();
    expect(telemetry.hands.left).toBeUndefined();
    expect(telemetry.hands.right).toBeUndefined();

    // Connect the right hand in pinch pose — telemetry carries the live poseId.
    await xrPage.setHandPose("right", "pinch");
    telemetry = await xrPage.getElementTelemetry();
    expect(telemetry.hands.right).toBe("pinch");
    expect(telemetry.hands.left).toBeUndefined();

    // The session now surfaces hand-tracking XRInputSources (hands became the
    // primary input modality, like a Quest putting the controllers down).
    await xrPage.page.waitForFunction(() =>
      window.__XREmulator.getInputSources().some((s) => s.hasHand),
    );
    const sources = await xrPage.getInputSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.hasHand)).toBe(true);
    expect(sources.find((s) => s.handedness === "right")?.profiles).toContain(
      "oculus-hand",
    );

    // Aim the hand ray at Submit: the ray has a real unit world direction and
    // the COMPUTED hit resolves to that element.
    expect(await xrPage.aimHandAt("right", '[data-agent-id="submit"]')).toBe(
      true,
    );
    telemetry = await xrPage.getElementTelemetry();
    const ray = telemetry.rays.find((r) => r.source === "hand-right");
    expect(ray).toBeDefined();
    expect(
      Math.hypot(ray!.direction.x, ray!.direction.y, ray!.direction.z),
    ).toBeCloseTo(1, 5);
    expect(
      telemetry.hits.find((h) => h.source === "hand-right")?.elementId,
    ).toBe("submit");

    // Pinch-select: IWER dispatches a REAL session `select` from the hand
    // input source — exactly one for one pinch.
    await xrPage.pressHandSelect("right");
    await xrPage.page.waitForFunction(
      () => window.__XREmulator.getSelectLog().length > 0,
    );
    const selects = await xrPage.getSelectLog();
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatchObject({
      handedness: "right",
      viaHand: true,
      targetRayMode: "tracked-pointer",
    });
  });

  test("flat: left and right hands aim and select independently", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    await xrPage.setHandPose("left", "pinch");
    await xrPage.setHandPose("right", "point");
    const telemetry = await xrPage.getElementTelemetry();
    expect(telemetry.hands.left).toBe("pinch");
    expect(telemetry.hands.right).toBe("point");

    // Each hand aims at its own target and each computed hit stays per-hand.
    expect(await xrPage.aimHandAt("left", '[data-agent-id="cancel"]')).toBe(
      true,
    );
    expect(await xrPage.aimHandAt("right", '[data-agent-id="submit"]')).toBe(
      true,
    );
    const aimed = await xrPage.getElementTelemetry();
    expect(aimed.hits.find((h) => h.source === "hand-left")?.elementId).toBe(
      "cancel",
    );
    expect(aimed.hits.find((h) => h.source === "hand-right")?.elementId).toBe(
      "submit",
    );

    // Two pinches → two session selects, one per hand, in order.
    await xrPage.pressHandSelect("left");
    await xrPage.pressHandSelect("right");
    await xrPage.page.waitForFunction(
      () => window.__XREmulator.getSelectLog().length >= 2,
    );
    const selects = await xrPage.getSelectLog();
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatchObject({ handedness: "left", viaHand: true });
    expect(selects[1]).toMatchObject({ handedness: "right", viaHand: true });
  });

  test("3D scene: hand pinch-select fires the authored view handler exactly once", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    await setPanels(xrPage.page, ["settings"]);

    // Connect the right hand in pinch pose.
    await xrPage.setHandPose("right", "pinch");
    let telemetry = await xrPage.getElementTelemetry();
    expect(telemetry.mode).toBe("scene");
    expect(telemetry.hands.right).toBe("pinch");

    // Aim the hand's WORLD ray at the settings view's real Save button: the 3D
    // hit resolves to that element with a world-space intersection point.
    expect(await xrPage.aimHandAt("right", '[data-agent-id="save"]')).toBe(
      true,
    );
    telemetry = await xrPage.getElementTelemetry();
    const hit = telemetry.hits.find((h) => h.source === "hand-right");
    expect(hit?.elementId).toBe("save");
    expect(hit?.panelId).toBe("settings");
    expect(hit?.world).toBeDefined();

    // Pinch-select: the authored view's real press handler fires exactly once…
    await clearActions(xrPage.page);
    await xrPage.pressHandSelect("right");
    const presses = (await fixtureActions(xrPage.page)).filter(
      (a) => a.type === "press" && a.agentId === "save",
    );
    expect(presses).toHaveLength(1);

    // …and the session records exactly one `select` from the hand source.
    await xrPage.page.waitForFunction(
      () => window.__XREmulator.getSelectLog().length > 0,
    );
    const selects = await xrPage.getSelectLog();
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatchObject({ handedness: "right", viaHand: true });

    const shot = await xrPage.captureScreenshot("xr-hand");
    const frames = await xrPage.captureFrameLog("xr-hand");
    expect(shot).toMatch(/\.png$/);
    expect(frames).toMatch(/\.frames\.json$/);
  });

  test("3D scene: a hand pinch-grab drags a panel in world space (move action)", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);
    await setPanels(xrPage.page, ["settings", "wallet"]);

    // Connect the right hand in pinch pose and aim its WORLD ray at the
    // settings panel (via its Save button) so the hand grabs that panel.
    await xrPage.setHandPose("right", "pinch");
    expect(await xrPage.aimHandAt("right", '[data-agent-id="save"]')).toBe(
      true,
    );
    const grabbed = await xrPage.getElementTelemetry();
    expect(grabbed.mode).toBe("scene");
    expect(grabbed.hits.find((h) => h.source === "hand-right")?.panelId).toBe(
      "settings",
    );

    const before = (await scenePanels(xrPage.page)).find(
      (p) => p.id === "settings",
    );
    expect(before).toBeDefined();

    // Pinch-grab and move +0.6 m along world +X. The drag runs through the same
    // real scene bridge (hand ray → panel hit → dragPanel) the controller path
    // uses, so the panel actually relocates in world space.
    await clearActions(xrPage.page);
    const moved = await xrPage.dragHand("right", { x: 0.6, y: 0, z: 0 });
    expect(moved).not.toBeNull();
    expect(moved!.x).toBeCloseTo(before!.position.x + 0.6, 5);

    // The panel's world pose actually changed…
    const after = (await scenePanels(xrPage.page)).find(
      (p) => p.id === "settings",
    );
    expect(after!.position.x).toBeCloseTo(before!.position.x + 0.6, 5);
    // …and the wallet panel we didn't grab stayed put.
    const wallet = (await scenePanels(xrPage.page)).find(
      (p) => p.id === "wallet",
    );
    expect(wallet).toBeDefined();

    // The authored scene dispatched a real `move` SpatialAction for that panel.
    const move = (await fixtureActions(xrPage.page)).find(
      (a) => a.type === "move" && a.agentId === "settings",
    );
    expect(
      move,
      "a move action was dispatched for the hand-dragged panel",
    ).toBeTruthy();
    expect(move!.position?.x).toBeCloseTo(before!.position.x + 0.6, 5);
  });
});
