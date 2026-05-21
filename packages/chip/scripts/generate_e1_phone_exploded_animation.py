#!/usr/bin/env python3
"""Generate an animated exploded view of the e1-phone.

Produces:
  - out/e1-phone-exploded.glb (two animation clips: explode, reassemble; per-part translation)
  - out/e1-phone-exploded.mp4 (1080p 12s turntable, orbits Y while explode-hold-reassemble-hold)
  - out/e1-phone-exploded-frames/*.png (key frames every 0.5s)
  - review/exploded-animation.{json,md}

Re-runnable. Reads assembly-manifest.json + the existing assembly GLB.
"""
from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import trimesh

os.environ.setdefault("PYOPENGL_PLATFORM", "egl")

ROOT = Path("/home/shaw/milady/eliza/packages/chip/mechanical/e1-phone")
OUT = ROOT / "out"
REVIEW = ROOT / "review"
SCRIPTS = Path("/home/shaw/milady/eliza/packages/chip/scripts")
ASM_GLB = OUT / "e1-phone-assembly.glb"
MANIFEST = OUT / "assembly-manifest.json"
EXPL_GLB = OUT / "e1-phone-exploded.glb"
EXPL_MP4 = OUT / "e1-phone-exploded.mp4"
FRAMES_DIR = OUT / "e1-phone-exploded-frames"

# ------------------------------------------------------------------- classify
RING_MM = 25.0  # explode offset per ring
EXPLODE_S = 3.0
HOLD_S = 1.5
REASM_S = 3.0
TOTAL_S = EXPLODE_S + HOLD_S + REASM_S + HOLD_S  # 9s loop body
TURNTABLE_S = 12.0  # full mp4 length
FPS = 30


def classify(name: str) -> tuple[np.ndarray, int]:
    """Return (unit-direction, ring) for explode offset. ring>=1 multiplied by RING_MM."""
    n = name.lower()
    # USB-C bottom group → -Y
    if n.startswith("usb_c") or n.startswith("bottom_mic") or n.startswith("bottom_microphone") or "bottom_speaker" in n:
        return np.array([0.0, -1.0, 0.0]), 2 if "module" in n or "receptacle" in n else 3
    # Top earpiece / top mic / front camera → +Y
    if n.startswith("earpiece") or n.startswith("top_mic") or n.startswith("top_microphone") or n.startswith("handset_acoustic") or n.startswith("front_camera"):
        return np.array([0.0, 1.0, 0.0]), 2 if "module" in n or "receiver" in n else 3
    # side buttons: power on +X, volume on -X
    if n.startswith("power_button") or "power_actuator" in n or "power_flex" in n:
        return np.array([1.0, 0.0, 0.0]), 2 if "cap" in n else 3 if "labyrinth" in n else 1
    if n.startswith("volume_button") or "volume_actuator" in n or "volume_flex" in n:
        return np.array([-1.0, 0.0, 0.0]), 2 if "cap" in n else 3 if "labyrinth" in n else 1
    if "side_key" in n or "split_interconnect_side" in n or "wifi_bt_side" in n:
        return np.array([1.0, 0.0, 0.0]), 1
    # Front of screen (+Z toward viewer): cover glass, adhesives, display, fpc
    if n.startswith("screen_cover") or n.startswith("screen_adhesive"):
        return np.array([0.0, 0.0, 1.0]), 3
    if n.startswith("display") or n.startswith("rear_camera_cover") or n.startswith("rear_camera_lens"):
        # display is front-stack; rear_camera_cover is actually on back but glass faces back; keep on +Z group for the cover stack? Use -Z for rear cam.
        if "rear_camera_cover" in n or "rear_camera_lens" in n:
            return np.array([0.0, 0.0, -1.0]), 4
        return np.array([0.0, 0.0, 1.0]), 2
    if "fpc" in n or n.startswith("display_fpc"):
        return np.array([0.0, 0.0, 1.0]), 1
    # everything else on the back side of the stack → -Z, ring by depth
    if n.startswith("orange_back_shell"):
        return np.array([0.0, 0.0, -1.0]), 3
    if n.startswith("orange_side_frame"):
        return np.array([0.0, 0.0, 1.0]), 1  # frame slightly forward
    if n.startswith("main_pcb") or "shield_can" in n or n.startswith("pmic") or n.startswith("soc") or n.startswith("radio"):
        return np.array([0.0, 0.0, -1.0]), 1
    if n.startswith("battery") or "battery" in n:
        return np.array([0.0, 0.0, -1.0]), 2
    if n.startswith("haptic"):
        return np.array([0.0, 0.0, -1.0]), 2
    if "rear_camera" in n:
        return np.array([0.0, 0.0, -1.0]), 4
    if "antenna" in n or "interconnect" in n:
        return np.array([0.0, 0.0, -1.0]), 1
    if "snap_hook" in n or "screw_boss" in n or "rib" in n or "reinforcement" in n:
        return np.array([0.0, 0.0, -1.0]), 2
    if "service_label" in n or "sim_tray" in n:
        return np.array([0.0, 0.0, -1.0]), 3
    # default: back, ring 1
    return np.array([0.0, 0.0, -1.0]), 1


# part colors (vertex paint baked into the GLB)
def color_for(name: str) -> tuple[int, int, int, int]:
    n = name.lower()
    if "orange" in n:
        return (242, 110, 34, 255)  # safety orange
    if "screen_cover" in n or "cover_glass" in n:
        return (40, 50, 70, 220)
    if "display" in n:
        return (20, 20, 25, 255)
    if "battery" in n:
        return (60, 200, 110, 255)
    if "pcb" in n:
        return (20, 110, 60, 255)
    if "shield_can" in n or "pmic" in n or "soc" in n or "radio" in n:
        return (180, 180, 190, 255)
    if "speaker" in n:
        return (60, 60, 70, 255)
    if "mic" in n or "microphone" in n:
        return (100, 100, 110, 255)
    if "button_cap" in n:
        return (40, 40, 45, 255)
    if "elastomer" in n or "gasket" in n:
        return (50, 50, 60, 255)
    if "fpc" in n or "flex" in n or "interconnect" in n:
        return (210, 170, 60, 255)  # kapton
    if "usb_c" in n:
        return (150, 150, 160, 255)
    if "camera" in n:
        return (15, 15, 20, 255)
    if "antenna" in n or "keepout" in n:
        return (180, 60, 60, 180)
    if "screw" in n or "snap" in n or "rib" in n or "reinforcement" in n:
        return (200, 130, 70, 255)
    return (170, 170, 180, 255)


# --------------------------------------------------------------- build GLB
def build_animated_glb(scene: trimesh.Scene, parts: list[dict]) -> None:
    """Author an animated GLB with translation keyframes per part node."""
    import pygltflib as pg
    from pygltflib import (
        GLTF2, Scene as GScene, Node, Mesh, Primitive, Attributes,
        Buffer, BufferView, Accessor, Material, PbrMetallicRoughness,
        Animation, AnimationChannel, AnimationChannelTarget, AnimationSampler,
    )

    bin_chunks: list[bytes] = []
    buffer_views: list[BufferView] = []
    accessors: list[Accessor] = []
    materials: list[Material] = []
    meshes: list[Mesh] = []
    nodes: list[Node] = []
    mat_cache: dict[tuple, int] = {}

    def add_bv(data: bytes, target: int | None = None) -> int:
        # pad to 4 bytes
        pad = (4 - (sum(len(c) for c in bin_chunks) % 4)) % 4
        if pad:
            bin_chunks.append(b"\x00" * pad)
        offset = sum(len(c) for c in bin_chunks)
        bin_chunks.append(data)
        bv = BufferView(buffer=0, byteOffset=offset, byteLength=len(data))
        if target is not None:
            bv.target = target
        buffer_views.append(bv)
        return len(buffer_views) - 1

    def add_accessor(bv: int, ctype: int, count: int, atype: str,
                     mn=None, mx=None) -> int:
        a = Accessor(bufferView=bv, componentType=ctype, count=count, type=atype)
        if mn is not None:
            a.min = list(map(float, mn))
            a.max = list(map(float, mx))
        accessors.append(a)
        return len(accessors) - 1

    def get_material(color: tuple[int, int, int, int]) -> int:
        if color in mat_cache:
            return mat_cache[color]
        r, g, b, a = color
        pbr = PbrMetallicRoughness(
            baseColorFactor=[r / 255, g / 255, b / 255, a / 255],
            metallicFactor=0.15,
            roughnessFactor=0.55,
        )
        m = Material(pbrMetallicRoughness=pbr, doubleSided=True)
        if a < 255:
            m.alphaMode = "BLEND"
        materials.append(m)
        idx = len(materials) - 1
        mat_cache[color] = idx
        return idx

    # one node per part
    part_node_indices: list[int] = []
    for p in parts:
        name = p["name"]
        g = scene.geometry[name]
        verts = np.asarray(g.vertices, dtype=np.float32)
        faces = np.asarray(g.faces, dtype=np.uint32).reshape(-1)
        # accessors
        vb = add_bv(verts.tobytes(), target=34962)
        va = add_accessor(vb, 5126, len(verts), "VEC3",
                          mn=verts.min(0), mx=verts.max(0))
        ib = add_bv(faces.tobytes(), target=34963)
        ia = add_accessor(ib, 5125, len(faces), "SCALAR")
        prim = Primitive(attributes=Attributes(POSITION=va), indices=ia,
                         material=get_material(color_for(name)))
        meshes.append(Mesh(primitives=[prim], name=name))
        mesh_idx = len(meshes) - 1
        nd = Node(mesh=mesh_idx, name=name, translation=[0.0, 0.0, 0.0])
        nodes.append(nd)
        part_node_indices.append(len(nodes) - 1)

    # root node
    root = Node(name="e1_phone_root", children=part_node_indices, rotation=[0, 0, 0, 1])
    nodes.append(root)
    root_idx = len(nodes) - 1

    # ----- animation clips: explode (0..3s outward), reassemble (0..3s inward)
    def make_clip(name: str, outward: bool) -> Animation:
        # time accessor (shared count = 2 keyframes per channel, but pygltflib needs per-sampler accessor)
        times = np.array([0.0, EXPLODE_S], dtype=np.float32)
        tb = add_bv(times.tobytes())
        ta = add_accessor(tb, 5126, 2, "SCALAR", mn=[float(times.min())], mx=[float(times.max())])
        samplers: list[AnimationSampler] = []
        channels: list[AnimationChannel] = []
        for p, node_idx in zip(parts, part_node_indices):
            dir_v = p["dir"]
            ring = p["ring"]
            offset = dir_v * (ring * RING_MM)
            start = np.array([0.0, 0.0, 0.0], dtype=np.float32) if outward else offset.astype(np.float32)
            end = offset.astype(np.float32) if outward else np.array([0.0, 0.0, 0.0], dtype=np.float32)
            arr = np.stack([start, end]).astype(np.float32)
            vb = add_bv(arr.tobytes())
            va = add_accessor(vb, 5126, 2, "VEC3",
                              mn=arr.min(0), mx=arr.max(0))
            samp = AnimationSampler(input=ta, output=va, interpolation="LINEAR")
            samplers.append(samp)
            ch = AnimationChannel(
                sampler=len(samplers) - 1,
                target=AnimationChannelTarget(node=node_idx, path="translation"),
            )
            channels.append(ch)
        return Animation(name=name, samplers=samplers, channels=channels)

    anim_explode = make_clip("explode", outward=True)
    anim_reasm = make_clip("reassemble", outward=False)

    # continuous Y-rotation on root for the full 12s
    rot_times = np.linspace(0, TURNTABLE_S, 5, dtype=np.float32)
    rtb = add_bv(rot_times.tobytes())
    rta = add_accessor(rtb, 5126, len(rot_times),
                       "SCALAR", mn=[float(rot_times.min())], mx=[float(rot_times.max())])
    quats = []
    for t in rot_times:
        ang = (t / TURNTABLE_S) * 2 * math.pi
        # quaternion around Y
        quats.append([0.0, math.sin(ang / 2), 0.0, math.cos(ang / 2)])
    quats_arr = np.array(quats, dtype=np.float32)
    qb = add_bv(quats_arr.tobytes())
    qa = add_accessor(qb, 5126, len(quats), "VEC4",
                      mn=quats_arr.min(0), mx=quats_arr.max(0))
    rot_samp = AnimationSampler(input=rta, output=qa, interpolation="LINEAR")
    rot_ch = AnimationChannel(sampler=0, target=AnimationChannelTarget(node=root_idx, path="rotation"))
    anim_spin = Animation(name="turntable", samplers=[rot_samp], channels=[rot_ch])

    # combine bin chunks
    bin_blob = b"".join(bin_chunks)
    # pad to 4
    pad = (4 - (len(bin_blob) % 4)) % 4
    if pad:
        bin_blob += b"\x00" * pad
    buf = Buffer(byteLength=len(bin_blob))

    gltf = GLTF2(
        asset=pg.Asset(version="2.0", generator="generate_e1_phone_exploded_animation.py"),
        scenes=[GScene(nodes=[root_idx])],
        scene=0,
        nodes=nodes,
        meshes=meshes,
        materials=materials,
        buffers=[buf],
        bufferViews=buffer_views,
        accessors=accessors,
        animations=[anim_explode, anim_reasm, anim_spin],
    )
    gltf.set_binary_blob(bin_blob)
    gltf.save_binary(str(EXPL_GLB))


# ----------------------------------------------------------- render mp4
def render_mp4(scene: trimesh.Scene, parts: list[dict]) -> tuple[str, float]:
    """Render 12s turntable with explode-hold-reassemble-hold timing.

    Returns (renderer_label, seconds_elapsed).
    """
    import pyrender
    from PIL import Image

    W, H = 1920, 1080
    n_frames = int(TURNTABLE_S * FPS)
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    # clean prior frames
    for p in FRAMES_DIR.glob("*.png"):
        p.unlink()

    # phase timing within the 12s loop
    # 0..3 explode, 3..4.5 hold-exploded, 4.5..7.5 reassemble, 7.5..12 hold-assembled (4.5s)
    def part_offset(t: float, dir_v: np.ndarray, ring: int) -> np.ndarray:
        full = dir_v * (ring * RING_MM)
        if t <= EXPLODE_S:
            f = t / EXPLODE_S
        elif t <= EXPLODE_S + HOLD_S:
            f = 1.0
        elif t <= EXPLODE_S + HOLD_S + REASM_S:
            f = 1.0 - (t - EXPLODE_S - HOLD_S) / REASM_S
        else:
            f = 0.0
        # ease in-out
        f = 0.5 - 0.5 * math.cos(math.pi * f)
        return full * f

    # build base meshes once with colors
    base_meshes: dict[str, trimesh.Trimesh] = {}
    for p in parts:
        g = scene.geometry[p["name"]].copy()
        c = color_for(p["name"])
        g.visual = trimesh.visual.ColorVisuals(g, vertex_colors=np.tile(c, (len(g.vertices), 1)))
        base_meshes[p["name"]] = g

    # camera target = centroid
    target = np.array([0.0, 0.0, 0.0])
    # Phone is ~155mm tall; per-part offsets reach ~150mm at peak explode, so the
    # outermost part envelope sits ~230mm from center. Place camera at 500mm so
    # the exploded view fits comfortably and the assembled view doesn't crowd.
    max_extent = 500.0
    cam_r = max_extent
    cam_h = max_extent * math.tan(math.radians(15.0))

    t0 = time.time()
    # Recreate the OffscreenRenderer every RENDERER_CHUNK frames; pyrender on
    # EGL leaks GPU memory across frames and dies around ~150 frames otherwise.
    RENDERER_CHUNK = 30
    renderer = pyrender.OffscreenRenderer(viewport_width=W, viewport_height=H)
    # lights: 3-point
    key = pyrender.DirectionalLight(color=np.ones(3), intensity=5.0)
    fill = pyrender.DirectionalLight(color=np.ones(3) * 0.85, intensity=2.5)
    rim = pyrender.DirectionalLight(color=np.ones(3), intensity=3.0)

    key_frame_times = {round(x * 0.5, 2) for x in range(int(TURNTABLE_S / 0.5) + 1)}

    for fi in range(n_frames):
        if fi > 0 and fi % RENDERER_CHUNK == 0:
            renderer.delete()
            renderer = pyrender.OffscreenRenderer(viewport_width=W, viewport_height=H)
        t = fi / FPS
        pyscene = pyrender.Scene(bg_color=np.array([0.22, 0.22, 0.24, 1.0]),
                                 ambient_light=np.array([0.35, 0.35, 0.38]))
        # add parts with displaced positions
        for p in parts:
            offset = part_offset(t, p["dir"], p["ring"])
            T = np.eye(4)
            T[:3, 3] = offset
            mesh = pyrender.Mesh.from_trimesh(base_meshes[p["name"]], smooth=False)
            pyscene.add(mesh, pose=T)

        # camera orbit
        ang = (t / TURNTABLE_S) * 2 * math.pi
        eye = np.array([cam_r * math.sin(ang), cam_h, cam_r * math.cos(ang)])
        # look-at matrix
        f = (target - eye); f = f / np.linalg.norm(f)
        up = np.array([0.0, 1.0, 0.0])
        s = np.cross(f, up); s = s / np.linalg.norm(s)
        u = np.cross(s, f)
        cam_pose = np.eye(4)
        cam_pose[:3, 0] = s
        cam_pose[:3, 1] = u
        cam_pose[:3, 2] = -f
        cam_pose[:3, 3] = eye
        cam = pyrender.PerspectiveCamera(yfov=math.radians(28.0), aspectRatio=W / H, znear=1.0, zfar=4000.0)
        pyscene.add(cam, pose=cam_pose)
        # World-anchored 3-point so the orange shell stays consistently lit
        # across the orbit (camera-anchored lights muddied the back face).
        lp1 = np.eye(4); lp1[:3, 3] = np.array([350.0, 350.0, 350.0])
        lp2 = np.eye(4); lp2[:3, 3] = np.array([-350.0, 250.0, 350.0])
        lp3 = np.eye(4); lp3[:3, 3] = np.array([0.0, -200.0, -350.0])
        pyscene.add(key, pose=lp1)
        pyscene.add(fill, pose=lp2)
        pyscene.add(rim, pose=lp3)

        color, _ = renderer.render(pyscene)
        img = Image.fromarray(color)
        img.save(FRAMES_DIR / f"frame_{fi:04d}.png")
        # also save keyframe copy
        tr = round(t, 2)
        if any(abs(tr - kt) < (1.0 / FPS) / 2 for kt in key_frame_times):
            kt = round(min(key_frame_times, key=lambda x: abs(x - tr)), 1)
            img.save(FRAMES_DIR / f"keyframe_t{kt:04.1f}s.png")
    renderer.delete()
    elapsed = time.time() - t0

    # ffmpeg → mp4
    cmd = [
        "ffmpeg", "-y", "-framerate", str(FPS), "-i",
        str(FRAMES_DIR / "frame_%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
        "-movflags", "+faststart", str(EXPL_MP4),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return ("pyrender-egl + ffmpeg/libx264", elapsed)


# ------------------------------------------------------------ verify
def verify_glb(path: Path) -> dict:
    import pygltflib as pg
    g = pg.GLTF2.load_binary(str(path))
    return {
        "size_bytes": path.stat().st_size,
        "nodes": len(g.nodes),
        "meshes": len(g.meshes),
        "animations": [a.name for a in g.animations],
        "buffers": [b.byteLength for b in g.buffers],
    }


# --------------------------------------------------------------- main
def main() -> int:
    print(f"[load] {ASM_GLB}")
    scene = trimesh.load(str(ASM_GLB), force="scene")
    manifest = json.loads(MANIFEST.read_text())
    parts = []
    for entry in manifest:
        name = entry["name"]
        if name not in scene.geometry:
            print(f"[skip] {name} not in GLB", file=sys.stderr)
            continue
        d, r = classify(name)
        parts.append({"name": name, "dir": d, "ring": r})
    print(f"[classified] {len(parts)} parts")

    print(f"[glb] writing {EXPL_GLB}")
    build_animated_glb(scene, parts)
    glb_info = verify_glb(EXPL_GLB)
    print(f"[glb] {glb_info}")

    renderer_label = "n/a"
    render_secs = 0.0
    try:
        print(f"[render] mp4 → {EXPL_MP4}")
        renderer_label, render_secs = render_mp4(scene, parts)
        print(f"[render] {renderer_label} in {render_secs:.1f}s")
    except Exception as e:
        print(f"[render] FAILED: {e}", file=sys.stderr)
        renderer_label = f"failed: {e}"

    # review files
    REVIEW.mkdir(parents=True, exist_ok=True)
    summary = {
        "glb": str(EXPL_GLB),
        "glb_size_bytes": glb_info["size_bytes"],
        "mp4": str(EXPL_MP4),
        "mp4_size_bytes": EXPL_MP4.stat().st_size if EXPL_MP4.exists() else 0,
        "frames_dir": str(FRAMES_DIR),
        "frame_count": len(list(FRAMES_DIR.glob("frame_*.png"))),
        "keyframe_count": len(list(FRAMES_DIR.glob("keyframe_*.png"))),
        "clips": glb_info["animations"],
        "clip_durations_s": {"explode": EXPLODE_S, "hold_exploded": HOLD_S,
                              "reassemble": REASM_S, "hold_assembled": HOLD_S,
                              "turntable_total": TURNTABLE_S},
        "fps": FPS,
        "part_count": len(parts),
        "ring_offset_mm": RING_MM,
        "renderer": renderer_label,
        "render_seconds": round(render_secs, 2),
        "render_command": " ".join([
            "ffmpeg", "-framerate", str(FPS),
            "-i", "frame_%04d.png", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-crf", "20", str(EXPL_MP4.name)]),
        "axis_decisions": {
            "screen_front_stack": "+Z",
            "back_shell_pcb_battery_haptic": "-Z",
            "power_button_group": "+X",
            "volume_button_group": "-X",
            "usb_c_and_bottom_speaker_mic": "-Y",
            "earpiece_top_mic_front_camera": "+Y",
        },
    }
    (REVIEW / "exploded-animation.json").write_text(json.dumps(summary, indent=2))
    md = f"""# e1-phone exploded animation

- GLB: `{EXPL_GLB}` ({glb_info['size_bytes']:,} bytes)
- MP4: `{EXPL_MP4}` ({summary['mp4_size_bytes']:,} bytes)
- Frames: `{FRAMES_DIR}` ({summary['frame_count']} frames, {summary['keyframe_count']} keyframes)
- Clips: {', '.join(glb_info['animations'])}
- Durations: explode {EXPLODE_S}s, hold {HOLD_S}s, reassemble {REASM_S}s, hold {HOLD_S}s — total {TURNTABLE_S}s @ {FPS}fps
- Parts animated: {len(parts)}
- Ring spacing: {RING_MM} mm
- Renderer: **{renderer_label}**
- Render time: {render_secs:.1f}s

## Axis decisions
| Group | Axis |
|---|---|
| screen front stack (cover glass / display / adhesives / fpc) | +Z |
| back shell / PCB / battery / haptic / shields / antennas | -Z |
| power button + labyrinth | +X |
| volume button + labyrinth | -X |
| USB-C parts + bottom speaker/mics | -Y |
| earpiece + top mic + front camera | +Y |

## Re-run

```bash
python3 packages/chip/scripts/generate_e1_phone_exploded_animation.py
```

## Notes

- GLB is fully self-contained (vertex-colored, embedded buffer). Two translation clips named `explode` and `reassemble`, plus a 12s `turntable` rotation on the root.
- MP4 timeline within the 12s loop: 0–3s explode, 3–4.5s hold-exploded, 4.5–7.5s reassemble, 7.5–12s hold-assembled, all while the camera orbits Y at 30°/s with 12° tilt.
- Vertex colors are baked per part (orange shell stays safety orange; kapton flex is amber; PCB green; shields silver).
"""
    (REVIEW / "exploded-animation.md").write_text(md)
    print(f"[done] review/exploded-animation.{{json,md}}")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
