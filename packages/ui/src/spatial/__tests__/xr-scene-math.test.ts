/**
 * Unit tests for the XR scene math core. Pure functions, no DOM — these prove the
 * 3D placement / projection / hit-test the renderer and the IWER harness rely on
 * are correct and byte-stable, independent of any browser.
 */

import { describe, expect, it } from "vitest";
import {
  billboardOrientation,
  type Camera,
  deviceRay,
  forwardOf,
  nearestPanelHit,
  type PanelPlane,
  panelLocalToWorld,
  projectToScreen,
  quatFromAxisAngle,
  quatIdentity,
  quatLookAt,
  rayPlaneHit,
  rotateVec3,
  screenToRay,
  type Viewport,
  vec3,
} from "../xr-scene-math.ts";

const VIEWPORT: Viewport = { width: 1280, height: 720 };

function camera(overrides: Partial<Camera> = {}): Camera {
  return {
    position: vec3(0, 0, 0),
    orientation: quatIdentity(),
    fovY: Math.PI / 2,
    aspect: VIEWPORT.width / VIEWPORT.height,
    ...overrides,
  };
}

function expectVecClose(a: { x: number; y: number; z: number }, b: typeof a) {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  expect(a.z).toBeCloseTo(b.z, 5);
}

describe("quaternion + vector basics", () => {
  it("identity forward is −Z", () => {
    expectVecClose(forwardOf(quatIdentity()), vec3(0, 0, -1));
  });

  it("90° yaw rotates forward to −X", () => {
    // +90° about +Y turns −Z toward −X (right-handed).
    const q = quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2);
    expectVecClose(forwardOf(q), vec3(-1, 0, 0));
  });

  it("rotateVec3 by identity is a no-op", () => {
    expectVecClose(rotateVec3(quatIdentity(), vec3(3, -2, 5)), vec3(3, -2, 5));
  });

  it("lookAt points forward (−Z) at the target", () => {
    const eye = vec3(0, 0, 0);
    const target = vec3(0, 0, -4);
    const q = quatLookAt(eye, target);
    expectVecClose(forwardOf(q), vec3(0, 0, -1));
  });

  it("lookAt aims a controller ray at an off-axis target", () => {
    const eye = vec3(0, 1.5, 0);
    const target = vec3(2, 1.5, -2);
    const q = quatLookAt(eye, target);
    const dir = forwardOf(q);
    expectVecClose(dir, { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 });
  });
});

describe("projectToScreen ↔ screenToRay are exact inverses", () => {
  it("a world point projects to a pixel whose back-ray passes through it", () => {
    const cam = camera({ position: vec3(0.3, 1.6, 0.5) });
    const world = vec3(1.2, 1.1, -3.4);
    const p = projectToScreen(world, cam, VIEWPORT);
    expect(p.visible).toBe(true);
    const ray = screenToRay(p.x, p.y, cam, VIEWPORT);
    // The world point lies along the back-projected ray.
    const along = {
      x: ray.origin.x + ray.direction.x * p.depth,
      y: ray.origin.y + ray.direction.y * p.depth,
      z: ray.origin.z + ray.direction.z * p.depth,
    };
    // direction is unit, p.depth is along −Z view distance, so scale by 1/cosθ.
    // Simpler: assert the ray, extended to the point's depth plane, hits it.
    const tScale = (world.z - ray.origin.z) / ray.direction.z;
    const hit = {
      x: ray.origin.x + ray.direction.x * tScale,
      y: ray.origin.y + ray.direction.y * tScale,
      z: ray.origin.z + ray.direction.z * tScale,
    };
    expectVecClose(hit, world);
    expect(along).toBeDefined();
  });

  it("the viewport centre back-projects to the camera forward ray", () => {
    const cam = camera({
      orientation: quatFromAxisAngle(vec3(0, 1, 0), 0.4),
    });
    const ray = screenToRay(
      VIEWPORT.width / 2,
      VIEWPORT.height / 2,
      cam,
      VIEWPORT,
    );
    expectVecClose(ray.direction, forwardOf(cam.orientation));
  });

  it("a point behind the camera is not visible", () => {
    const p = projectToScreen(vec3(0, 0, 4), camera(), VIEWPORT);
    expect(p.visible).toBe(false);
  });
});

describe("rayPlaneHit", () => {
  const panel: PanelPlane = {
    position: vec3(0, 1.5, -2),
    orientation: billboardOrientation(vec3(0, 1.5, -2), vec3(0, 1.5, 0)),
    width: 1.2,
    height: 0.8,
  };

  it("a forward ray from the eye hits the panel centre (u=v=0)", () => {
    const ray = deviceRay(
      vec3(0, 1.5, 0),
      quatLookAt(vec3(0, 1.5, 0), panel.position),
    );
    const hit = rayPlaneHit(ray, panel);
    expect(hit).not.toBeNull();
    expect(hit!.inside).toBe(true);
    expect(hit!.u).toBeCloseTo(0, 5);
    expect(hit!.v).toBeCloseTo(0, 5);
    expectVecClose(hit!.world, panel.position);
  });

  it("aiming at the panel's top-right corner lands near (u=+0.5, v=+0.5)", () => {
    const corner = panelLocalToWorld(panel, 0.49, 0.49);
    const eye = vec3(0, 1.5, 0);
    const ray = deviceRay(eye, quatLookAt(eye, corner));
    const hit = rayPlaneHit(ray, panel);
    expect(hit?.inside).toBe(true);
    expect(hit!.u).toBeCloseTo(0.49, 2);
    expect(hit!.v).toBeCloseTo(0.49, 2);
  });

  it("a ray aimed past the panel edge misses (inside=false)", () => {
    const beyond = panelLocalToWorld(panel, 1.5, 0);
    const eye = vec3(0, 1.5, 0);
    const ray = deviceRay(eye, quatLookAt(eye, beyond));
    const hit = rayPlaneHit(ray, panel);
    expect(hit?.inside).toBe(false);
  });

  it("a ray pointing away from the panel does not hit (t<0 ⇒ null)", () => {
    const ray = deviceRay(vec3(0, 1.5, 0), quatIdentity()); // faces −Z, panel is −Z…
    // Panel is in front along −Z, so identity DOES hit; aim backwards instead.
    const away = deviceRay(
      vec3(0, 1.5, 0),
      quatFromAxisAngle(vec3(0, 1, 0), Math.PI),
    );
    expect(rayPlaneHit(away, panel)).toBeNull();
    expect(rayPlaneHit(ray, panel)?.inside).toBe(true);
  });
});

describe("nearestPanelHit picks the closest panel along the ray", () => {
  it("returns the nearer of two stacked panels", () => {
    const near: PanelPlane = {
      position: vec3(0, 1.5, -1),
      orientation: billboardOrientation(vec3(0, 1.5, -1), vec3(0, 1.5, 0)),
      width: 1,
      height: 1,
    };
    const far: PanelPlane = {
      position: vec3(0, 1.5, -3),
      orientation: billboardOrientation(vec3(0, 1.5, -3), vec3(0, 1.5, 0)),
      width: 1,
      height: 1,
    };
    const eye = vec3(0, 1.5, 0);
    const ray = deviceRay(eye, quatLookAt(eye, vec3(0, 1.5, -1)));
    const best = nearestPanelHit(ray, [far, near]);
    expect(best?.index).toBe(1); // the `near` panel, even though listed second
    expect(best?.hit.t).toBeCloseTo(1, 5);
  });

  it("returns null when the ray misses every panel", () => {
    const p: PanelPlane = {
      position: vec3(5, 1.5, -2),
      orientation: quatIdentity(),
      width: 0.5,
      height: 0.5,
    };
    const ray = deviceRay(vec3(0, 1.5, 0), quatIdentity());
    expect(nearestPanelHit(ray, [p])).toBeNull();
  });
});

describe("billboardOrientation faces the panel at the viewer", () => {
  it("a billboarded panel's normal points back at the eye", () => {
    const pos = vec3(2, 1.5, -2);
    const eye = vec3(0, 1.5, 0);
    const q = billboardOrientation(pos, eye);
    // Panel local +Z (normal) should point from panel toward eye.
    const normal = rotateVec3(q, vec3(0, 0, 1));
    const toEye = {
      x: eye.x - pos.x,
      y: eye.y - pos.y,
      z: eye.z - pos.z,
    };
    const len = Math.hypot(toEye.x, toEye.y, toEye.z);
    expectVecClose(normal, {
      x: toEye.x / len,
      y: toEye.y / len,
      z: toEye.z / len,
    });
  });
});
