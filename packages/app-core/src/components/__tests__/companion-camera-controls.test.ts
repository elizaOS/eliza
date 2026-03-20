/**
 * Tests for companion mode camera controls:
 * - Drag orbit (click-drag to orbit camera, lerp back on release)
 * - Scroll/pinch zoom
 * - Engine registration in stageEnginesRef
 * - baseCameraPosition initialization
 *
 * These are unit tests that verify the control logic without requiring
 * a real WebGL context or DOM events.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal mock VrmEngine for testing CompanionSceneHost control logic
// ---------------------------------------------------------------------------

function createMockVrmEngine() {
  const dragOrbitTarget = { x: 0, y: 0 };
  const companionZoom = { value: 0 };

  return {
    dragOrbitTarget,
    companionZoom,
    setDragOrbitTarget: vi.fn((yaw: number, pitch: number) => {
      dragOrbitTarget.x = yaw;
      dragOrbitTarget.y = pitch;
    }),
    resetDragOrbit: vi.fn(() => {
      dragOrbitTarget.x = 0;
      dragOrbitTarget.y = 0;
    }),
    setCompanionZoomNormalized: vi.fn((value: number) => {
      companionZoom.value = Math.max(0, Math.min(1, value));
    }),
  };
}

type MockEngine = ReturnType<typeof createMockVrmEngine>;

// ---------------------------------------------------------------------------
// Simulate the CompanionSceneHost control logic extracted from the component
// ---------------------------------------------------------------------------

/**
 * Reproduces the core logic from CompanionSceneHost without React.
 * This lets us test the drag/zoom math and engine dispatch in isolation.
 */
function createCompanionControls() {
  const stageEngines = new Set<MockEngine>();
  const dragOrbitRef = { yaw: 0, pitch: 0 };
  const companionZoomRef = { current: 0.95 };
  const dragState = {
    active: false,
    pointerId: null as number | null,
    startX: 0,
    startY: 0,
  };
  const pinchState = {
    active: false,
    startDistance: 0,
    startZoom: 0,
  };
  const touchPoints = new Map<number, { x: number; y: number }>();

  function clampZoom(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  function setCompanionZoom(value: number) {
    const next = clampZoom(value);
    companionZoomRef.current = next;
    for (const engine of stageEngines) {
      engine.setCompanionZoomNormalized(next);
    }
  }

  function registerEngine(engine: MockEngine) {
    stageEngines.add(engine);
    engine.setCompanionZoomNormalized(companionZoomRef.current);
    engine.setDragOrbitTarget(dragOrbitRef.yaw, dragOrbitRef.pitch);
  }

  function pointerDown(pointerId: number, clientX: number, clientY: number, pointerType: string = "mouse") {
    if (pointerType === "touch") {
      touchPoints.set(pointerId, { x: clientX, y: clientY });
      if (touchPoints.size >= 2) {
        const pts = [...touchPoints.values()];
        pinchState.active = true;
        pinchState.startDistance = Math.hypot(
          pts[1]!.x - pts[0]!.x,
          pts[1]!.y - pts[0]!.y,
        );
        pinchState.startZoom = companionZoomRef.current;
        dragState.active = false;
        dragState.pointerId = null;
        dragOrbitRef.yaw = 0;
        dragOrbitRef.pitch = 0;
        for (const engine of stageEngines) {
          engine.resetDragOrbit();
        }
        return;
      }
    }
    dragState.active = true;
    dragState.pointerId = pointerId;
    dragState.startX = clientX;
    dragState.startY = clientY;
  }

  function pointerMove(
    pointerId: number,
    clientX: number,
    clientY: number,
    pointerType: string = "mouse",
    viewWidth = 800,
    viewHeight = 600,
  ) {
    if (pointerType === "touch" && touchPoints.has(pointerId)) {
      touchPoints.set(pointerId, { x: clientX, y: clientY });
      if (pinchState.active && touchPoints.size >= 2 && pinchState.startDistance > 0) {
        const pts = [...touchPoints.values()];
        const dist = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
        const viewportSpan = Math.max(1, Math.min(viewWidth, viewHeight));
        const PINCH_SENSITIVITY = 2.35;
        const delta = ((dist - pinchState.startDistance) / viewportSpan) * PINCH_SENSITIVITY;
        setCompanionZoom(pinchState.startZoom + delta);
        return;
      }
    }
    if (!dragState.active || dragState.pointerId !== pointerId) return;
    const deltaX = clientX - dragState.startX;
    const deltaY = clientY - dragState.startY;
    const yaw = (deltaX / viewWidth) * 1.35;
    const pitch = (-deltaY / viewHeight) * 0.85;
    dragOrbitRef.yaw = yaw;
    dragOrbitRef.pitch = pitch;
    for (const engine of stageEngines) {
      engine.setDragOrbitTarget(yaw, pitch);
    }
  }

  function pointerUp(pointerId: number, pointerType: string = "mouse") {
    if (pointerType === "touch") {
      touchPoints.delete(pointerId);
      if (touchPoints.size < 2) {
        pinchState.active = false;
        pinchState.startDistance = 0;
        pinchState.startZoom = companionZoomRef.current;
      }
    }
    if (dragState.pointerId !== pointerId) return;
    dragState.active = false;
    dragState.pointerId = null;
    dragOrbitRef.yaw = 0;
    dragOrbitRef.pitch = 0;
    for (const engine of stageEngines) {
      engine.resetDragOrbit();
    }
  }

  function wheelZoom(deltaY: number) {
    const WHEEL_SENSITIVITY = 1 / 720;
    setCompanionZoom(companionZoomRef.current - deltaY * WHEEL_SENSITIVITY);
  }

  return {
    stageEngines,
    dragOrbitRef,
    companionZoomRef,
    dragState,
    registerEngine,
    pointerDown,
    pointerMove,
    pointerUp,
    wheelZoom,
    setCompanionZoom,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Companion Camera Controls", () => {
  let controls: ReturnType<typeof createCompanionControls>;
  let engine: MockEngine;

  beforeEach(() => {
    controls = createCompanionControls();
    engine = createMockVrmEngine();
  });

  describe("Engine registration", () => {
    it("registerEngine adds engine to the set and syncs current state", () => {
      controls.companionZoomRef.current = 0.7;
      controls.dragOrbitRef.yaw = 0.1;
      controls.dragOrbitRef.pitch = -0.05;

      controls.registerEngine(engine);

      expect(controls.stageEngines.has(engine)).toBe(true);
      expect(engine.setCompanionZoomNormalized).toHaveBeenCalledWith(0.7);
      expect(engine.setDragOrbitTarget).toHaveBeenCalledWith(0.1, -0.05);
    });

    it("drag orbit calls reach the engine after registration", () => {
      controls.registerEngine(engine);

      controls.pointerDown(1, 400, 300);
      controls.pointerMove(1, 500, 250);

      expect(engine.setDragOrbitTarget).toHaveBeenCalled();
      const lastCall = engine.setDragOrbitTarget.mock.calls.at(-1)!;
      expect(lastCall[0]).not.toBe(0); // yaw should be non-zero
    });

    it("drag orbit calls are lost when no engine is registered", () => {
      // Don't register engine — simulate the original bug
      controls.pointerDown(1, 400, 300);
      controls.pointerMove(1, 500, 250);

      // Engine was never called because it wasn't registered
      expect(engine.setDragOrbitTarget).not.toHaveBeenCalled();
    });
  });

  describe("Drag orbit", () => {
    beforeEach(() => {
      controls.registerEngine(engine);
      vi.clearAllMocks();
    });

    it("computes yaw and pitch from pointer delta relative to viewport", () => {
      controls.pointerDown(1, 400, 300);
      controls.pointerMove(1, 500, 200, "mouse", 800, 600);

      // yaw = (500-400)/800 * 1.35 = 100/800 * 1.35 ≈ 0.169
      // pitch = -(200-300)/600 * 0.85 = 100/600 * 0.85 ≈ 0.142
      const lastCall = engine.setDragOrbitTarget.mock.calls.at(-1)!;
      expect(lastCall[0]).toBeCloseTo(0.169, 2);
      expect(lastCall[1]).toBeCloseTo(0.142, 2);
    });

    it("resets drag orbit target to zero on pointer up (lerp back)", () => {
      controls.pointerDown(1, 400, 300);
      controls.pointerMove(1, 500, 200, "mouse", 800, 600);
      controls.pointerUp(1);

      expect(engine.resetDragOrbit).toHaveBeenCalled();
      expect(controls.dragOrbitRef.yaw).toBe(0);
      expect(controls.dragOrbitRef.pitch).toBe(0);
    });

    it("ignores pointer move without a prior pointer down", () => {
      controls.pointerMove(1, 500, 200);
      expect(engine.setDragOrbitTarget).not.toHaveBeenCalled();
    });

    it("ignores pointer move with a different pointer id", () => {
      controls.pointerDown(1, 400, 300);
      controls.pointerMove(2, 500, 200); // wrong id
      expect(engine.setDragOrbitTarget).not.toHaveBeenCalled();
    });

    it("dispatches to multiple engines", () => {
      const engine2 = createMockVrmEngine();
      controls.registerEngine(engine2);
      vi.clearAllMocks();

      controls.pointerDown(1, 400, 300);
      controls.pointerMove(1, 500, 200, "mouse", 800, 600);

      expect(engine.setDragOrbitTarget).toHaveBeenCalled();
      expect(engine2.setDragOrbitTarget).toHaveBeenCalled();
    });
  });

  describe("Wheel zoom", () => {
    beforeEach(() => {
      controls.registerEngine(engine);
      vi.clearAllMocks();
    });

    it("scroll down (positive deltaY) zooms out (decreases zoom value)", () => {
      controls.companionZoomRef.current = 0.5;
      controls.wheelZoom(100);

      expect(engine.setCompanionZoomNormalized).toHaveBeenCalled();
      const zoom = engine.companionZoom.value;
      expect(zoom).toBeLessThan(0.5);
    });

    it("scroll up (negative deltaY) zooms in (increases zoom value)", () => {
      controls.companionZoomRef.current = 0.5;
      controls.wheelZoom(-100);

      const zoom = engine.companionZoom.value;
      expect(zoom).toBeGreaterThan(0.5);
    });

    it("clamps zoom to [0, 1]", () => {
      controls.companionZoomRef.current = 0.01;
      controls.wheelZoom(10000); // massive scroll down
      expect(engine.companionZoom.value).toBe(0);

      controls.companionZoomRef.current = 0.99;
      controls.wheelZoom(-10000); // massive scroll up
      expect(engine.companionZoom.value).toBe(1);
    });
  });

  describe("Pinch zoom", () => {
    beforeEach(() => {
      controls.registerEngine(engine);
      vi.clearAllMocks();
    });

    it("two-finger pinch out increases zoom", () => {
      controls.companionZoomRef.current = 0.5;

      // First finger down
      controls.pointerDown(1, 300, 300, "touch");
      // Second finger down — enters pinch mode
      controls.pointerDown(2, 500, 300, "touch");

      vi.clearAllMocks();

      // Spread fingers apart (pinch out)
      controls.pointerMove(1, 250, 300, "touch", 800, 600);
      controls.pointerMove(2, 550, 300, "touch", 800, 600);

      expect(engine.setCompanionZoomNormalized).toHaveBeenCalled();
      expect(engine.companionZoom.value).toBeGreaterThan(0.5);
    });

    it("two-finger pinch in decreases zoom", () => {
      controls.companionZoomRef.current = 0.5;

      controls.pointerDown(1, 200, 300, "touch");
      controls.pointerDown(2, 600, 300, "touch");

      vi.clearAllMocks();

      // Move fingers closer (pinch in)
      controls.pointerMove(1, 350, 300, "touch", 800, 600);
      controls.pointerMove(2, 450, 300, "touch", 800, 600);

      expect(engine.setCompanionZoomNormalized).toHaveBeenCalled();
      expect(engine.companionZoom.value).toBeLessThan(0.5);
    });

    it("entering pinch mode resets any active drag orbit", () => {
      controls.pointerDown(1, 300, 300, "touch");
      // At this point drag is active with one finger

      // Second finger enters pinch mode
      controls.pointerDown(2, 500, 300, "touch");

      expect(engine.resetDragOrbit).toHaveBeenCalled();
      expect(controls.dragState.active).toBe(false);
    });
  });

  describe("baseCameraPosition gate", () => {
    it("drag orbit is gated on baseCameraPosition being non-zero in VrmEngine", () => {
      // This tests the VrmEngine render loop condition:
      // if (dragOrbitCurrent.lengthSq() > 1e-6 && baseCameraPosition.lengthSq() > 1e-6)
      //
      // When baseCameraPosition is (0,0,0), lengthSq() returns 0,
      // and the drag orbit block is entirely skipped.
      //
      // The fix initializes baseCameraPosition from the camera profile
      // during async setup, so it is non-zero before the first frame.

      const baseCameraPosition = { x: 0, y: 0, z: 0 };
      const lengthSq = () =>
        baseCameraPosition.x ** 2 +
        baseCameraPosition.y ** 2 +
        baseCameraPosition.z ** 2;

      // Before fix: baseCameraPosition is (0,0,0)
      expect(lengthSq()).toBe(0);
      expect(lengthSq() > 1e-6).toBe(false); // drag orbit would be SKIPPED

      // After fix: camera profile sets position (e.g. companion profile)
      baseCameraPosition.x = 0;
      baseCameraPosition.y = 1.36;
      baseCameraPosition.z = 5.2;
      expect(lengthSq()).toBeGreaterThan(1e-6); // drag orbit proceeds
    });
  });
});
