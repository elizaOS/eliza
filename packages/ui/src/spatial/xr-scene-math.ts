/**
 * 3D math for the XR spatial scene — the deterministic core the renderer and the
 * IWER test harness both reason about.
 *
 * Conventions (WebXR): right-handed world space, +X right, +Y up, −Z forward
 * (the direction a device with identity orientation faces). A panel is a finite
 * rectangle in that space: a centre `position`, an `orientation`, and a `width`
 * /`height` in metres. The renderer places real DOM at the projected rect; the
 * harness casts a controller ray, intersects it with the panel plane, and maps
 * the local hit back to a DOM element — so "the right controller hit Submit" is a
 * computed 3D fact, not a pixel guess.
 *
 * Everything here is pure (no DOM, no React, no `three`) so it unit-tests in
 * isolation and is byte-stable. `projectToScreen` and `screenToRay` are exact
 * inverses; `rayPlaneHit` is the workhorse for the controller→panel hit-test.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A world-space ray: a point of origin and a (not necessarily unit) direction. */
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/** A perspective camera = a device pose plus a vertical FOV and aspect ratio. */
export interface Camera {
  position: Vec3;
  orientation: Quat;
  /** Vertical field of view in radians. */
  fovY: number;
  /** width / height of the viewport. */
  aspect: number;
}

/** A flat rectangular surface in world space (a UI panel). */
export interface PanelPlane {
  position: Vec3;
  orientation: Quat;
  /** Full extent along the panel's local X, in metres. */
  width: number;
  /** Full extent along the panel's local Y, in metres. */
  height: number;
}

/** Where a ray meets a panel: the world point and the panel-local coordinates. */
export interface PlaneHit {
  /** Ray parameter (distance along the unit direction); ≥ 0 means in front. */
  t: number;
  /** The intersection point in world space. */
  world: Vec3;
  /** Local horizontal coordinate, −0.5 (left) … +0.5 (right). */
  u: number;
  /** Local vertical coordinate, −0.5 (bottom) … +0.5 (top). */
  v: number;
  /** True when (u, v) fall within the panel rect. */
  inside: boolean;
}

const EPS = 1e-9;

// ── Vec3 ────────────────────────────────────────────────────────────────────

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len < EPS ? { x: 0, y: 0, z: 0 } : scale(a, 1 / len);
}

// ── Quat ──────────────────────────────────────────────────────────────────

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/** Hamilton product a⊗b (apply b, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < EPS) return quatIdentity();
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** Rotate a vector by a quaternion: v' = q · v · q⁻¹. */
export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  // t = 2 · (q.xyz × v); v' = v + q.w · t + q.xyz × t  (Rodrigues, quaternion form)
  const qv = { x: q.x, y: q.y, z: q.z };
  const t = scale(cross(qv, v), 2);
  return add(add(v, scale(t, q.w)), cross(qv, t));
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
}

/**
 * Orientation that points the local −Z (forward) axis from `eye` toward
 * `target`, with local +Y biased to `up`. Used to billboard panels at the
 * viewer and to aim a controller ray at an element's world position.
 */
export function quatLookAt(eye: Vec3, target: Vec3, up: Vec3 = UP): Quat {
  const forward = normalize(sub(target, eye)); // desired −Z
  const f = scale(forward, -1); // local +Z
  let r = cross(up, f);
  if (length(r) < EPS) {
    // up ∥ forward: pick any orthogonal right vector.
    r = cross(vec3(0, 0, 1), f);
    if (length(r) < EPS) r = cross(vec3(1, 0, 0), f);
  }
  r = normalize(r);
  const u = cross(f, r);
  // Build a quaternion from the orthonormal basis (r, u, f) as columns.
  return quatFromBasis(r, u, f);
}

/** Quaternion from an orthonormal right/up/forward(+Z) basis. */
export function quatFromBasis(r: Vec3, u: Vec3, f: Vec3): Quat {
  const m00 = r.x;
  const m01 = u.x;
  const m02 = f.x;
  const m10 = r.y;
  const m11 = u.y;
  const m12 = f.y;
  const m20 = r.z;
  const m21 = u.z;
  const m22 = f.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize({
      w: s / 4,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize({
      w: (m21 - m12) / s,
      x: s / 4,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: s / 4,
      z: (m12 + m21) / s,
    });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: s / 4,
  });
}

// ── Device axes ─────────────────────────────────────────────────────────────

export const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
export const UP: Vec3 = { x: 0, y: 1, z: 0 };
export const RIGHT: Vec3 = { x: 1, y: 0, z: 0 };

/** A device's forward (−Z) ray after its orientation is applied. */
export function forwardOf(q: Quat): Vec3 {
  return rotateVec3(q, FORWARD);
}

/** The world-space ray a controller/headset casts from its pose. */
export function deviceRay(position: Vec3, orientation: Quat): Ray {
  return { origin: position, direction: forwardOf(orientation) };
}

// ── Panel geometry ──────────────────────────────────────────────────────────

/** The panel's local right (+X), up (+Y), and normal (+Z) in world space. */
export function panelBasis(panel: PanelPlane): {
  right: Vec3;
  up: Vec3;
  normal: Vec3;
} {
  return {
    right: rotateVec3(panel.orientation, RIGHT),
    up: rotateVec3(panel.orientation, UP),
    normal: rotateVec3(panel.orientation, { x: 0, y: 0, z: 1 }),
  };
}

/** The world position of a panel-local (u, v) ∈ [−0.5, 0.5]² coordinate. */
export function panelLocalToWorld(
  panel: PanelPlane,
  u: number,
  v: number,
): Vec3 {
  const { right, up } = panelBasis(panel);
  return add(
    panel.position,
    add(scale(right, u * panel.width), scale(up, v * panel.height)),
  );
}

/**
 * Intersect a ray with a panel's (infinite) plane, returning the panel-local
 * (u, v) of the hit and whether it lands inside the rect. Returns null when the
 * ray is parallel to the plane or the hit is behind the ray origin.
 */
export function rayPlaneHit(ray: Ray, panel: PanelPlane): PlaneHit | null {
  const dir = normalize(ray.direction);
  const { right, up, normal } = panelBasis(panel);
  const denom = dot(dir, normal);
  if (Math.abs(denom) < EPS) return null; // parallel
  const t = dot(sub(panel.position, ray.origin), normal) / denom;
  if (t < 0) return null; // behind the origin
  const world = add(ray.origin, scale(dir, t));
  const local = sub(world, panel.position);
  const u = dot(local, right) / panel.width;
  const v = dot(local, up) / panel.height;
  const inside = Math.abs(u) <= 0.5 + EPS && Math.abs(v) <= 0.5 + EPS;
  return { t, world, u, v, inside };
}

/**
 * The nearest panel a ray hits inside its rect. Returns the panel index and the
 * hit, or null when the ray misses every panel — the depth-ordered hit-test.
 */
export function nearestPanelHit(
  ray: Ray,
  panels: PanelPlane[],
): { index: number; hit: PlaneHit } | null {
  let best: { index: number; hit: PlaneHit } | null = null;
  for (let i = 0; i < panels.length; i++) {
    const hit = rayPlaneHit(ray, panels[i]);
    if (!hit?.inside) continue;
    if (!best || hit.t < best.hit.t) best = { index: i, hit };
  }
  return best;
}

// ── Projection (world ↔ screen) ──────────────────────────────────────────────

export interface Viewport {
  width: number;
  height: number;
}

export interface Projected {
  /** Screen-space position in CSS px (origin top-left). */
  x: number;
  y: number;
  /** Distance in front of the camera (metres); ≤ 0 means behind. */
  depth: number;
  /** False when the point is behind the camera. */
  visible: boolean;
}

/** Transform a world point into the camera's view space (camera at origin, −Z fwd). */
export function worldToView(point: Vec3, camera: Camera): Vec3 {
  return rotateVec3(
    quatConjugate(camera.orientation),
    sub(point, camera.position),
  );
}

/** Perspective-project a world point to screen-space CSS px. */
export function projectToScreen(
  point: Vec3,
  camera: Camera,
  viewport: Viewport,
): Projected {
  const view = worldToView(point, camera);
  const depth = -view.z; // in front ⇒ view.z < 0 ⇒ depth > 0
  if (depth <= EPS) {
    return { x: 0, y: 0, depth, visible: false };
  }
  const tanHalf = Math.tan(camera.fovY / 2);
  const ndcX = view.x / (depth * tanHalf * camera.aspect);
  const ndcY = view.y / (depth * tanHalf);
  return {
    x: (ndcX * 0.5 + 0.5) * viewport.width,
    y: (1 - (ndcY * 0.5 + 0.5)) * viewport.height,
    depth,
    visible: true,
  };
}

/**
 * The world-space ray through a screen-space pixel — the exact inverse of
 * {@link projectToScreen}. Origin is the camera; direction is unit length.
 */
export function screenToRay(
  sx: number,
  sy: number,
  camera: Camera,
  viewport: Viewport,
): Ray {
  const ndcX = (sx / viewport.width) * 2 - 1;
  const ndcY = (1 - sy / viewport.height) * 2 - 1;
  const tanHalf = Math.tan(camera.fovY / 2);
  const viewDir = normalize({
    x: ndcX * tanHalf * camera.aspect,
    y: ndcY * tanHalf,
    z: -1,
  });
  return {
    origin: camera.position,
    direction: rotateVec3(camera.orientation, viewDir),
  };
}

/**
 * The on-screen size (CSS px) of a panel at its projected depth, assuming the
 * panel faces the camera (billboarded). focal = (viewportHeight/2) / tan(fovY/2).
 */
export function panelScreenSize(
  panel: PanelPlane,
  camera: Camera,
  viewport: Viewport,
): { width: number; height: number; depth: number } {
  const view = worldToView(panel.position, camera);
  const depth = Math.max(-view.z, EPS);
  const focal = viewport.height / 2 / Math.tan(camera.fovY / 2);
  return {
    width: (panel.width * focal) / depth,
    height: (panel.height * focal) / depth,
    depth,
  };
}

/**
 * Orientation that makes a panel at `position` face a camera at `eye` (billboard).
 * The panel's +Z normal points back toward the viewer.
 */
export function billboardOrientation(
  position: Vec3,
  eye: Vec3,
  up: Vec3 = UP,
): Quat {
  // The panel's +Z normal should point toward the eye.
  const normal = normalize(sub(eye, position));
  let right = cross(up, normal);
  if (length(right) < EPS) right = cross(vec3(0, 0, 1), normal);
  right = normalize(right);
  const u = cross(normal, right);
  return quatFromBasis(right, u, normal);
}
