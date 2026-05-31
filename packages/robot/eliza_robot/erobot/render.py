"""Visual proofs for erobot.

Writes, under ``cad/erobot/visual/``:
  * ``parts_grid.png``      — every structural shell rendered individually
    (visual proof each part exists and is well-formed).
  * ``exploded.png``        — the whole shell set exploded radially.
  * ``internals.png``       — a leg + torso with their internal components shown
    inside the shells (cutaway).
  * ``rom_filmstrip.png``   — MuJoCo frames: home, deep squat, arms raised, and
    the cable-driven toe flexed.

matplotlib (Agg) renders the meshes headlessly; MuJoCo renders the poses.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from eliza_robot.erobot.components import build_components  # noqa: E402
from eliza_robot.erobot.meshlib import component_mesh, primitive_mesh  # noqa: E402
from eliza_robot.erobot.mjcf import _MATERIAL_RGBA, write_models  # noqa: E402
from eliza_robot.erobot.spec import RobotSpec, build_spec  # noqa: E402

VISUAL_ROOT = Path(__file__).resolve().parents[2] / "cad" / "erobot" / "visual"
_KIND_COLOR = {"motor": "#2a6fb0", "bearing": "#b0902a", "battery": "#2ab06f",
               "compute": "#6f2ab0", "pdb": "#b02a6f", "imu": "#b0512a",
               "camera": "#2ab0a0", "harness": "#888888", "pulley": "#d0d000"}


def _mesh_polys(ax, mesh, color, alpha=1.0, edge="none"):
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    polys = mesh.vertices[mesh.faces]
    pc = Poly3DCollection(polys, facecolor=color, edgecolor=edge, linewidths=0.1, alpha=alpha)
    ax.add_collection3d(pc)


def _equal_box(ax, bounds):
    lo, hi = bounds
    c = (lo + hi) / 2.0
    r = (hi - lo).max() / 2.0
    ax.set_xlim(c[0] - r, c[0] + r)
    ax.set_ylim(c[1] - r, c[1] + r)
    ax.set_zlim(c[2] - r, c[2] + r)
    ax.set_box_aspect((1, 1, 1))
    ax.set_axis_off()


def _rgba(material_key: str) -> str:
    r, g, b, _ = (float(x) for x in _MATERIAL_RGBA[material_key].split())
    return (r, g, b)


def render_parts_grid(spec: RobotSpec, out: Path) -> Path:
    shells = [(b, g) for b in spec.bodies for g in b.geoms]
    n = len(shells)
    cols = 7
    rows = (n + cols - 1) // cols
    fig = plt.figure(figsize=(cols * 2.0, rows * 2.0))
    for i, (body, g) in enumerate(shells):
        ax = fig.add_subplot(rows, cols, i + 1, projection="3d")
        mesh = primitive_mesh(g)
        _mesh_polys(ax, mesh, _rgba(g.material_key), alpha=1.0, edge="#222222")
        _equal_box(ax, mesh.bounds)
        ax.set_title(g.name.replace("_shell", "").replace("_", " "), fontsize=5)
        ax.view_init(elev=18, azim=35)
    fig.suptitle(f"erobot — {n} structural shells (all watertight manifolds)", fontsize=11)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)
    return out


def _placed(spec: RobotSpec, g, body, explode: float = 0.0):
    """Mesh placed at the body's world origin, optionally exploded radially."""
    mesh = primitive_mesh(g).copy()
    wp = np.array(body.world_pos)
    if explode:
        direction = wp - np.array([0.0, 0.0, wp[2]])  # radial in xy
        norm = np.linalg.norm(direction)
        offset = (direction / norm * explode) if norm > 1e-6 else np.array([0.0, 0.0, 0.0])
    else:
        offset = np.zeros(3)
    mesh.apply_translation(wp + offset)
    return mesh


def render_exploded(spec: RobotSpec, out: Path) -> Path:
    fig = plt.figure(figsize=(7, 11))
    for col, (explode, title) in enumerate([(0.0, "assembled"), (0.10, "exploded")]):
        ax = fig.add_subplot(1, 2, col + 1, projection="3d")
        allpts = []
        for body in spec.bodies:
            for g in body.geoms:
                mesh = _placed(spec, g, body, explode)
                _mesh_polys(ax, mesh, _rgba(g.material_key), alpha=0.95, edge="#333333")
                allpts.append(mesh.bounds)
        allpts = np.array(allpts).reshape(-1, 3)
        _equal_box(ax, (allpts.min(0), allpts.max(0)))
        ax.view_init(elev=8, azim=35)
        ax.set_title(title, fontsize=10)
    fig.suptitle("erobot shell assembly", fontsize=12)
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    plt.close(fig)
    return out


def render_internals(spec: RobotSpec, out: Path) -> Path:
    comps_by_body: dict[str, list] = {}
    for c in build_components(spec):
        comps_by_body.setdefault(c.body, []).append(c)

    show = ["torso", "left_hip_pitch", "left_knee", "left_ankle_roll", "left_toe", "head"]
    fig = plt.figure(figsize=(len(show) * 2.4, 3.0))
    for i, body_name in enumerate(show):
        body = spec.body(body_name)
        ax = fig.add_subplot(1, len(show), i + 1, projection="3d")
        pts = []
        for g in body.geoms:
            mesh = primitive_mesh(g)
            _mesh_polys(ax, mesh, _rgba(g.material_key), alpha=0.18, edge="#888888")
            pts.append(mesh.bounds)
        for c in comps_by_body.get(body_name, []):
            mesh = component_mesh(c.gtype, c.size, c.pose)
            _mesh_polys(ax, mesh, _KIND_COLOR.get(c.kind, "#cc3333"), alpha=0.95)
            pts.append(mesh.bounds)
        if pts:
            pts = np.array(pts).reshape(-1, 3)
            _equal_box(ax, (pts.min(0), pts.max(0)))
        ax.view_init(elev=15, azim=40)
        ax.set_title(body_name.replace("_", " "), fontsize=7)
    fig.suptitle("erobot internals — components housed inside shells (cutaway)", fontsize=10)
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    plt.close(fig)
    return out


def render_rom_filmstrip(spec: RobotSpec, out: Path) -> Path:
    import mujoco

    paths = write_models(spec)
    model = mujoco.MjModel.from_xml_path(str(paths["scene"]))
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=640, width=360)

    def shot(setup) -> np.ndarray:
        mujoco.mj_resetDataKeyframe(model, data, 0)
        setup(data)
        mujoco.mj_forward(model, data)
        cam = mujoco.MjvCamera()
        cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        cam.lookat[:] = [0.0, 0.0, 0.85]
        cam.distance = 3.4
        cam.azimuth = 130
        cam.elevation = -8
        renderer.update_scene(data, camera=cam)
        return renderer.render()

    def qset(name, val):
        def f(d):
            d.qpos[model.joint(name).qposadr[0]] = val
        return f

    def squat(d):
        for s in ("left", "right"):
            d.qpos[model.joint(f"{s}_knee_joint").qposadr[0]] = 1.2
            d.qpos[model.joint(f"{s}_hip_pitch_joint").qposadr[0]] = -0.8
            d.qpos[model.joint(f"{s}_ankle_pitch_joint").qposadr[0]] = -0.6

    def arms_up(d):
        d.qpos[model.joint("left_shoulder_pitch_joint").qposadr[0]] = -1.6
        d.qpos[model.joint("right_shoulder_pitch_joint").qposadr[0]] = -1.6

    def toe(d):
        d.qpos[model.joint("left_toe_joint").qposadr[0]] = -0.5
        d.qpos[model.joint("right_toe_joint").qposadr[0]] = -0.5

    frames = [("home", lambda d: None), ("squat", squat),
              ("arms raised", arms_up), ("toe flex (tendon)", toe)]
    imgs = [(label, shot(fn)) for label, fn in frames]
    fig, axes = plt.subplots(1, len(imgs), figsize=(len(imgs) * 2.6, 5))
    for ax, (label, img) in zip(axes, imgs, strict=True):
        ax.imshow(img)
        ax.set_title(label, fontsize=9)
        ax.axis("off")
    fig.suptitle("erobot range of motion (MuJoCo)", fontsize=11)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)
    return out


def render_all(spec: RobotSpec | None = None) -> dict[str, Path]:
    spec = spec or build_spec()
    VISUAL_ROOT.mkdir(parents=True, exist_ok=True)
    out = {
        "parts_grid": render_parts_grid(spec, VISUAL_ROOT / "parts_grid.png"),
        "exploded": render_exploded(spec, VISUAL_ROOT / "exploded.png"),
        "internals": render_internals(spec, VISUAL_ROOT / "internals.png"),
        "rom_filmstrip": render_rom_filmstrip(spec, VISUAL_ROOT / "rom_filmstrip.png"),
    }
    return out


if __name__ == "__main__":
    for k, p in render_all().items():
        print(f"{k}: {p}")
