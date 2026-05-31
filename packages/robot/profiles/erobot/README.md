# erobot profile

Full-size (~1.66 m, ~26 kg) 25-DoF humanoid designed from scratch: hollow
injection-molded shells (PA6-GF30 load paths, PC-ABS cosmetic, TPU soles) over
off-the-shelf quasi-direct-drive actuators. 12 legs + 1 waist + 10 arms + 2 neck.

This profile and all its assets (MJCF, scene, URDF) are **generated** from the
parametric spec in `eliza_robot/erobot/spec.py` — do not hand-edit. The model
loads, steps, and stands in MuJoCo; the BOM, mating catalog, and engineering
proofs live under `mechanical/erobot/` and `cad/erobot/`.

DoF: 25. Regenerate everything with:

    JAX_PLATFORMS=cpu uv run python -m eliza_robot.erobot.build

Design notes + proof results: [docs/erobot.md](../../docs/erobot.md).
