# ASIMOV-1 Feminization — Parametric Part Spec

Each robot link mesh is feminized by a **parametric spine + cross-section loft**,
NOT by editing triangles and NOT by gluing primitives (spheres) on top.

## Pipeline (shared library `paramlib.py`)

1. `slice_to_rings(mesh, axis, step=0.01, n_angular=72|96)` — slice the mesh
   perpendicular to the spine axis every 1 cm. Each slice → centroid + N angular
   radii. Returns a `PartParam`.
2. Warp the `PartParam` with the helpers below.
3. `rings_to_mesh(param)` — loft rings into a **watertight** mesh, caps both ends.

## Connection points (`connections.py`)

`LINKS[name]` gives `spine`, `children` (child-joint positions in this link's
local frame = the interfaces that MUST be preserved), and `intent`.
`reserved_levels(name)` returns the spine-axis levels to protect (self joint at 0
plus each child joint). Always compute `w = connection_weight(param, reserved, ramp=0.03..0.05)`
and pass `weight=w` to every warp so joint interfaces stay exact and blends are smooth.

## Warp helpers

- `radial_scale(param, fn, weight)` — uniform thinning/thickening; `fn(z)->mult`.
- `axis_scale(param, dim, fn, weight)` — scale one in-plane world axis (squash depth / widen).
- `sector_scale(param, ang_center, ang_width, fn, weight)` — scale only an angular
  sector. Angle 0 = +first-in-plane-dim. For a Z-spine part the in-plane dims are
  (x,y): angle 0 → +X, angle π/2 → +Y. Use for bust (front +X), glutes (back −X).
- `spine_shift(param, fn, weight)` — shift ring centroid by `fn(z)->(d0,d1)` in the
  two in-plane dims; use for back arch / posture.

## Frame conventions

- Robot forward = **+X**, robot left = **+Y**, up = **+Z** (MJCF link-local).
- Most parts: spine = **z**. Short connectors may use x or y (see `connections.py`).

## Your deliverable per part

1. A script `param/parts/<PART>.py` that: loads the original STL, builds the param,
   applies the warp per `intent`, rebuilds, validates, writes the femme STL.
2. The femme STL written to `cad/asimov-feminine/output/stl/<PART>.STL` (overwrite).
3. A matplotlib check PNG to `/tmp/<part>_check.png` (orig vs femme silhouettes).

## Hard requirements

- Output mesh **must be watertight** (`rebuilt.is_watertight == True`).
- **Connection interfaces preserved**: at every reserved level the radii/centroid
  are unchanged (the `weight` ramp guarantees this — verify the femme bbox at the
  joint planes matches the original within ~1 mm).
- **Stay inside the original bounding box** on any axis you are SLIMMING. Axes you
  are intentionally flaring (hip Y, bust +X) may exceed by the intended amount only —
  state the intended delta in a comment.
- Mirror parts (LEFT_/RIGHT_) get the SAME treatment mirrored across Y.

## Paths

- Originals: `assets/profiles/asimov-1/meshes/<PART>.STL`
- Output:    `cad/asimov-feminine/output/stl/<PART>.STL`
- Python:    `.venv/bin/python` (run from `packages/robot/`)
- Lib path:  add `cad/asimov-feminine/param` to `sys.path`

## Reference example

`/tmp/demo_warp_knee.py` (calf slim) and `/tmp/test_torso_warp.py` (bust + cinch +
arch) are working end-to-end examples — read them.
