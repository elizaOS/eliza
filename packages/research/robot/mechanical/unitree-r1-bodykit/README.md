# Unitree R1 Orange Android Bodykit

Parametric EVT bodykit for the Unitree R1 MuJoCo profile. The bodykit is hard
plastic only: orange armor panels, black mechanical underbody panels, and a
hard stylized face shell. Hair and glasses are intentionally excluded.

## Generate

```bash
cd packages/robot
uv run python scripts/generate_unitree_profile.py --robot r1
./.tools/blender/blender --background --python scripts/generate_eliza_human_donor_blender.py
uv run python scripts/analyze_unitree_r1_oem_envelopes.py
uv run python scripts/generate_unitree_r1_bodykit.py
.tools/blender/blender --background --python scripts/render_unitree_r1_bodykit_blender.py
```

Outputs:

- `out/meshes/*.stl` and `*.obj` prototype mesh parts.
- `out/step/*.step` preliminary parametric STEP solids from CadQuery/OCP.
- `cad/source-assets/human-donor/eliza_face_donor.stl` open human-generator
  donor face source.
- `out/mjcf/R1_C++_bodykit.xml` loadable MuJoCo model.
- `review/bodykit-contact-sheet.png` manual visual review sheet.
- `review/unitree-r1-bodykit-orbit.mp4` orbit video.
- `review/fit-validation.json` simulator fit and contact report.
- `review/oem-envelope-audit.json` measured Unitree R1 STL source envelope
  groups for the next shell rework.
- `review/design-source-audit.json` bodykit part provenance check against OEM
  baseline meshes.
- `review/step-export-report.json` STEP export audit.
- `review/manufacturing-manifest.json` print and molding handoff manifest.
- `review/sourcing-and-cost-plan.md` supplier and unit-cost research.
- `review/eliza-face-donor.png`, `review/blender-bodykit-parts.png`, and
  `review/unitree-r1-bodykit.blend`
  from the portable Blender review path.

## Blender

This checkout uses a portable Blender build under `packages/robot/.tools/blender`
when available. It is intentionally ignored by git because the install is large.
The render script imports the generated assembled bodykit GLB and writes a
headless Blender review render plus `.blend` scene to `review/`.

## Current Status

This is an EVT parametric bodykit suitable for MuJoCo validation, visual
review, first service-print quoting, and early CAD handoff. The primitive face
has been replaced by an open human-generator donor mesh. CadQuery/OCP exports
primitive/mechanical detail parts to STEP, while imported sculpted donor meshes
remain explicitly blocked from tooling release until rebuilt as production CAD.
Production injection molding still requires final R1 CAD or a scan, offset shell
interiors, real mounts, bosses, ribs, inserts, parting lines, and production
surface review.

The R1 base assets are sourced from Unitree's `unitree_mujoco` repository and
vendored under `packages/robot/vendor/unitree_mujoco`.
