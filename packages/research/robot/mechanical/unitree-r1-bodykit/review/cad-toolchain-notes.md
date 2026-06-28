# Unitree R1 Bodykit CAD Toolchain Notes

Date: 2026-05-23

## Installed In This Workspace

- `cadquery==2.7.0`
- `cadquery-ocp==7.8.1.1.post1`
- Portable Blender 4.5.10 LTS under `packages/robot/.tools/blender`

## STEP Export

`scripts/generate_unitree_r1_bodykit.py` exports preliminary STEP solids to
`out/step/*.step` when CadQuery/OCP is importable. The current workspace exports
28 of 28 bodykit parts; see `step-export-report.json`.

## Dependency Gate

CadQuery is not committed as a normal package dependency yet. `uv add
'cadquery>=2.7'` failed because the robot package pins `numpy<2` for the
MuJoCo/Brax/JAX wheel matrix, while CadQuery 2.7.0 pulls `nlopt>=2.9`, whose
metadata requires `numpy>=2` across uv's resolved environments.

Until that upstream dependency conflict is solved, CadQuery should be installed
for mechanical CAD work with:

```bash
cd packages/robot
uv pip install cadquery
```

The generator degrades to a blocked `step-export-report.json` if CadQuery is not
available.
