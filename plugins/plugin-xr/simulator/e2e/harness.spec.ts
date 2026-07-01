// Deterministic, headless XR harness e2e (issue #9968).
//
// Proves the IWER-backed emulator can, in CI with no headset: install
// navigator.xr, start an immersive session, set head + controller poses, aim a
// controller ray at a named element, read back that element's screen rect + the
// ray vector + the computed hit, assert the hit equals the expected element,
// fire select, and capture a screenshot + per-frame pose/hit JSON.
import { expect, test } from "../src/playwright-fixture.ts";

test.describe("XR harness — pose → ray → hit → press", () => {
  test("installs navigator.xr and starts an immersive session", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    expect(
      await xrPage.page.evaluate(() => typeof navigator.xr !== "undefined"),
    ).toBe(true);

    expect(await xrPage.startSession("immersive-vr")).toBe(true);
    expect((await xrPage.getStats()).sessionActive).toBe(true);
  });

  test("aims a controller ray at a named element and computes the hit", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    // Aim the right controller at the Submit panel, then read telemetry back.
    expect(
      await xrPage.aimControllerAt("right", '[data-agent-id="submit"]'),
    ).toBe(true);
    const telemetry = await xrPage.getElementTelemetry();

    // Element telemetry carries real screen rects for every tagged element.
    const ids = telemetry.elements.map((e) => e.elementId).sort();
    expect(ids).toEqual(["cancel", "submit", "title"]);

    // The right controller's aiming ray exists with a real world-space vector…
    const rightRay = telemetry.rays.find((r) => r.source === "right");
    expect(rightRay).toBeDefined();
    expect(
      Math.hypot(
        rightRay!.direction.x,
        rightRay!.direction.y,
        rightRay!.direction.z,
      ),
    ).toBeCloseTo(1, 5);

    // …and the COMPUTED hit resolves to the Submit element, not pixels.
    const rightHit = telemetry.hits.find((h) => h.source === "right");
    expect(rightHit?.elementId).toBe("submit");
  });

  test("connects an aimed controller and fires select/squeeze without error", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();
    expect(
      await xrPage.aimControllerAt("right", '[data-agent-id="submit"]'),
    ).toBe(true);

    // The aimed controller is a connected device whose ray resolves to the target.
    const telemetry = await xrPage.getElementTelemetry();
    expect(telemetry.controllers.right).toBeDefined();
    expect(telemetry.hits.find((h) => h.source === "right")?.elementId).toBe(
      "submit",
    );

    // Firing select/squeeze drives IWER input and resolves cleanly. The
    // session-level select EVENT dispatch needs the immersive render loop
    // (deferred spatial-renderer scope — see WEBXR_STATUS / #9968); getSelectLog()
    // is wired for when that lands.
    await expect(xrPage.pressSelect("right")).resolves.toBeUndefined();
    await expect(xrPage.pressSqueeze("right")).resolves.toBeUndefined();
  });

  test("captures a screenshot + per-frame pose/hit JSON for every element", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    // Drive the controller across each element and assert each becomes the hit.
    for (const id of ["cancel", "title", "submit"]) {
      await xrPage.aimControllerAt("right", `[data-agent-id="${id}"]`);
      const telemetry = await xrPage.getElementTelemetry();
      const hit = telemetry.hits.find((h) => h.source === "right");
      expect(hit?.elementId).toBe(id);
      await xrPage.pressSelect("right");
    }

    const shot = await xrPage.captureScreenshot("xr-harness");
    const frames = await xrPage.captureFrameLog("xr-harness");
    expect(shot).toMatch(/\.png$/);
    expect(frames).toMatch(/\.frames\.json$/);

    // The frame log has one snapshot per getElementTelemetry call.
    const log = await xrPage.page.evaluate(() =>
      window.__XREmulator.getFrameLog(),
    );
    expect(log.length).toBeGreaterThanOrEqual(3);
  });
});
