// Gaze input e2e (issue #10722).
//
// ── Why there is no `targetRayMode: "gaze"` input source here ──────────────
// IWER 2.2.1 CANNOT emulate a live gaze (or Apple-Vision-Pro-style
// "transient-pointer") XRInputSource. Concretely, in the packaged library:
//   • `XRTargetRayMode.Gaze` / `XRTargetRayMode.TransientPointer` exist only
//     as enum values (iwer/lib/input/XRInputSource.js:16,19) — nothing in the
//     library ever constructs an input source with either mode.
//   • The only live input sources an XRDevice can surface are XRController
//     (iwer/lib/device/XRController.js:25) and XRHandInput
//     (iwer/lib/device/XRHandInput.js:84), BOTH hard-coded to
//     `XRTargetRayMode.TrackedPointer`; `XRDevice.primaryInputMode` only
//     switches between "controller" and "hand" (iwer/lib/device/XRDevice.js,
//     `get activeInputs`). There is no API to register a custom XRInputSource
//     on a live device/session.
//   • ActionPlayer (iwer/lib/action/ActionPlayer.js:72) can REPLAY a recording
//     whose schema says `targetRayMode: "gaze"`, but playback bypasses the
//     live input pipeline (no gamepad transitions → no select events), so it
//     cannot stand in for interactive gaze input.
// Faking it by dispatching synthetic XRInputSourceEvents would test nothing,
// so it is deliberately not done. The "no gaze source" fact is pinned by an
// executable assertion below — if an IWER upgrade ever surfaces a gaze or
// transient-pointer source, that pin fails and this spec must be upgraded to
// drive it for real.
//
// What IS emulable — and covered here — is head-gaze AIMING: the emulated
// headset's forward ray is a real gaze ray. The harness aims the head at a
// named element and asserts the computed hit resolves to it, in both the flat
// DOM harness and the real 3D XRSpatialScene (world-space plane intersection).
import { expect, test } from "../src/playwright-fixture.ts";
import { bootScene, SCENE_HEAD_POSE, setPanels } from "./scene-helpers.ts";

test.describe("XR gaze — head-gaze ray → hit + input-source mode pin", () => {
  test("flat: head-gaze aims at each named element and the headset hit resolves", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    for (const id of ["cancel", "title", "submit"]) {
      expect(await xrPage.aimHeadAt(`[data-agent-id="${id}"]`)).toBe(true);
      const telemetry = await xrPage.getElementTelemetry();

      // The headset ray is a real unit world vector…
      const gaze = telemetry.rays.find((r) => r.source === "headset");
      expect(gaze).toBeDefined();
      expect(
        Math.hypot(gaze!.direction.x, gaze!.direction.y, gaze!.direction.z),
      ).toBeCloseTo(1, 5);

      // …and the COMPUTED headset hit resolves to the gazed-at element.
      expect(
        telemetry.hits.find((h) => h.source === "headset")?.elementId,
        `gaze hit ${id}`,
      ).toBe(id);
    }
  });

  test("3D scene: head-gaze hit resolves to authored view elements in world space", async ({
    xrPage,
  }) => {
    await bootScene(xrPage);

    const checked: string[] = [];
    for (const id of ["settings", "wallet", "confirm"]) {
      // Neutral forward gaze between targets, then mount one centred panel.
      await xrPage.setPose(SCENE_HEAD_POSE);
      await setPanels(xrPage.page, [id]);

      const agentId = await xrPage.page.evaluate(() => {
        const panel = document.querySelector("[data-xr-panel]");
        const el = panel?.querySelector(
          "[data-agent-id]",
        ) as HTMLElement | null;
        return el?.dataset.agentId ?? null;
      });
      if (!agentId) continue; // a purely presentational view (no agent ids)

      expect(
        await xrPage.aimHeadAt(`[data-agent-id="${agentId}"]`),
        `aim ${id}/${agentId}`,
      ).toBe(true);
      const telemetry = await xrPage.getElementTelemetry();
      expect(telemetry.mode).toBe("scene");
      const hit = telemetry.hits.find((h) => h.source === "headset");
      expect(hit?.elementId, `gaze hit ${id}/${agentId}`).toBe(agentId);
      expect(hit?.panelId).toBe(id);
      // The gaze hit carries a real world-space intersection point.
      expect(hit?.world).toBeDefined();
      checked.push(id);
    }
    expect(checked.length).toBeGreaterThanOrEqual(2);

    const shot = await xrPage.captureScreenshot("xr-gaze");
    const frames = await xrPage.captureFrameLog("xr-gaze");
    expect(shot).toMatch(/\.png$/);
    expect(frames).toMatch(/\.frames\.json$/);
  });

  test("IWER 2.2.1 surfaces no gaze/transient-pointer input source (executable blocker pin)", async ({
    xrPage,
  }) => {
    await xrPage.goto("/");
    await xrPage.startSession();

    // Controller modality: every live session input source is tracked-pointer.
    await xrPage.page.waitForFunction(
      () => window.__XREmulator.getInputSources().length > 0,
    );
    const controllerSources = await xrPage.getInputSources();
    expect(controllerSources.length).toBeGreaterThan(0);
    for (const source of controllerSources) {
      expect(source.targetRayMode).toBe("tracked-pointer");
      expect(source.hasHand).toBe(false);
    }

    // Hand modality: still tracked-pointer only (hands, not gaze).
    await xrPage.setHandPose("right", "pinch");
    await xrPage.page.waitForFunction(() =>
      window.__XREmulator.getInputSources().some((s) => s.hasHand),
    );
    const handSources = await xrPage.getInputSources();
    for (const source of handSources) {
      expect(source.targetRayMode).toBe("tracked-pointer");
    }

    // The pin: no gaze / transient-pointer source exists in either modality.
    // If this ever fails, IWER gained gaze emulation — upgrade this spec to
    // drive a real gaze select instead of documenting the blocker.
    const modes = new Set(
      [...controllerSources, ...handSources].map((s) => s.targetRayMode),
    );
    expect(modes.has("gaze")).toBe(false);
    expect(modes.has("transient-pointer")).toBe(false);
  });
});
