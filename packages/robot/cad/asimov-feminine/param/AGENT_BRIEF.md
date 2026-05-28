# ASIMOV-1 Feminization — Agent Briefing (READ FULLY)

We are reshaping the ASIMOV-1 humanoid's STL parts into a feminine form for a
VISUAL model (a three.js viewer + offscreen renders). Work in:
`/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot`
Python: `.venv/bin/python` (run from that dir). Add `cad/asimov-feminine/param` to sys.path.

## HARD-WON CONSTRAINTS (violating these = failure)

1. **Flat plates MUST stay flat.** The parts are 60–94% flat plate-metal. The
   ONLY transform that keeps a flat plate flat is one that doesn't vary across
   the plate: a CONSTANT affine (e.g. `warp2.warp_affine`, uniform cross-section
   scale, length preserved) keeps planes→planes to 0.0000 mm. Any *spatially
   varying* radial/spine warp BENDS plates — do not use it on mechanical parts.
2. **Round bores MUST stay round.** Equal scaling on the two cross-section axes
   keeps length-axis circles circular. Non-uniform/sector scaling makes eggs.
3. **Connection interfaces.** Each link's joint origin is local (0,0,0); child
   joints are in `connections.py` (`reserved_levels`). Parts must still stack.
4. **No collisions through joint rotation.** Slimming reduces risk; verify if asked.
5. **VERIFY VISUALLY before claiming success.** "watertight==True" and good bbox
   ratios mean NOTHING about shape quality — a prior pass produced watertight
   fragmented garbage and passed those checks. ALWAYS render and LOOK.

## What broke before (do not repeat)
- Loft (slice→largest-polygon→re-mesh) FRAGMENTS multi-component parts into
  floating chunks. Never re-mesh; warp original vertices in place.
- Radial/spine vertex warp BENDS flat plates and shears circles into eggs.
- Gluing primitive spheres on as "breasts" — rejected.

## Tooling (cad/asimov-feminine/param/)
- `warp2.py`:
  - `warp_affine(mesh, spine='z', factor, center=(0,0))` — CONSTANT cross-section
    scale; flat+round safe; preserves length. USE THIS for limb slimming.
  - `warp_profile(mesh, axis, scale_fn, bulges, shift_fn, reserved, ramp)` —
    directional profile warp (cinch/bust/hips/arch). This DOES curve flat plates,
    so ONLY use it on the cosmetic torso/pelvis where curved surfaces are accepted.
  - `outer_centerline`, `connection_weight` helpers.
- `connections.py`: `LINKS[name]` (spine, children, intent); `reserved_levels(name)`.
- `regen_all.py`: current pipeline (constant-affine slim per part, SLIM dict).
- Originals: `assets/profiles/asimov-1/meshes/<PART>.STL`
- Output (gitignored): `cad/asimov-feminine/output/stl/<PART>.STL`
- MJCF (joint axes/limits/positions): `assets/profiles/asimov-1/mjcf/asimov_eliza.xml`

## Reliable offscreen render (DO NOT fight window focus — use this)
```python
import pyvista as pv, trimesh, numpy as np
pv.OFF_SCREEN = True
def render(meshes_with_offsets, out, az=0, size=(700,1000)):
    # meshes_with_offsets: list of (trimesh, (dx,dy,dz))
    pl = pv.Plotter(off_screen=True, window_size=size); pl.set_background('white')
    for m, off in meshes_with_offsets:
        v = m.vertices + np.array(off)
        f = np.hstack([np.full((len(m.faces),1),3), m.faces]).ravel()
        pl.add_mesh(pv.PolyData(v, f), color='#d9a05b', smooth_shading=False, specular=0.3)
    pl.view_vector((np.sin(np.radians(az)), -np.cos(np.radians(az)), 0.0), (0,0,1))
    pl.screenshot(out); pl.close()
```
az=0 → front (looking down -Y at the +X-facing front... robot front is +X, so
az=90 shows the side profile, az=0 shows front silhouette). Always render front
AND side AND 3/4 (az=40) and LOOK at all three before reporting.

## Assembled world positions (metres) — for whole-body renders
```python
P={'IMU_ORIGIN':(0,0,0.630),'WAIST_YAW':(-0.052,0,0.704755),'NECK_YAW':(-0.068599,0,1.082922),'NECK_PITCH':(-0.068599,0,1.120272),
'LEFT_HIP_PITCH':(-0.052,0.0675,0.585955),'LEFT_HIP_ROLL':(-0.00975,0.1075,0.585955),'LEFT_HIP_YAW':(-0.052,0.1075,0.533955),
'LEFT_KNEE':(-0.052,0.1075,0.338315),'LEFT_ANKLE_A':(-0.052,0.1075,0.043653),'LEFT_ANKLE_B':(-0.0535,0.1075,0.033653),'LEFT_TOE':(0.04903,0.103134,0.02692),
'RIGHT_HIP_PITCH':(-0.052,-0.0675,0.585955),'RIGHT_HIP_ROLL':(-0.00975,-0.1075,0.585955),'RIGHT_HIP_YAW':(-0.052,-0.1075,0.533955),
'RIGHT_KNEE':(-0.052,-0.1075,0.338315),'RIGHT_ANKLE_A':(-0.052,-0.1074,0.043653),'RIGHT_ANKLE_B':(-0.0535,-0.1074,0.033653),'RIGHT_TOE':(0.04897,-0.10312,0.02692),
'LEFT_SHOULDER_PITCH':(-0.078213,0.0965,0.965895),'LEFT_SHOULDER_ROLL':(-0.078113,0.161853,0.965895),'LEFT_SHOULDER_YAW':(-0.078113,0.161853,0.836897),'LEFT_ELBOW':(-0.078113,0.161853,0.740595),'LEFT_WRIST_YAW':(0.00845,0.161853,0.66796),
'RIGHT_SHOULDER_PITCH':(-0.078213,-0.0965,0.965895),'RIGHT_SHOULDER_ROLL':(-0.078213,-0.161853,0.965832),'RIGHT_SHOULDER_YAW':(-0.078213,-0.161853,0.836833),'RIGHT_ELBOW':(-0.078213,-0.161853,0.740232),'RIGHT_WRIST_YAW':(0.00835,-0.161853,0.667597)}
```

## FILE OWNERSHIP (do not write outside your lane — agents run in parallel)
- Collision agent: writes only `param/collision_report.md` + render PNGs in /tmp. READ-ONLY on STLs.
- Limb-slim agent: owns arm/leg/neck/foot STLs + `param/parts_limbs.py`.
- Body-curves agent: owns `WAIST_YAW.STL`, `IMU_ORIGIN.STL` + `param/parts_body_curves.py`.
- Cosmetic-shell agent: owns NEW `*_SHELL.STL` files + `param/cosmetic_shell.py`. Never overwrite frame parts.
