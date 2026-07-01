#!/usr/bin/env python3
"""Generate an open human-generator donor head for the Unitree R1 bodykit.

Run with Blender, not Python:

    .tools/blender/blender --background --python scripts/generate_eliza_human_donor_blender.py

The output is a robot-frame OBJ/GLB/STL donor asset, not final tooling geometry.
It replaces the primitive face mesh with a real parametric human face
source that can be reworked into hard plastic shell panels.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import bpy
from mathutils import Vector

PKG_ROOT = Path(__file__).resolve().parents[1]
BODYKIT_ROOT = PKG_ROOT / "mechanical" / "unitree-r1-bodykit"
SOURCE_ROOT = BODYKIT_ROOT / "cad" / "source-assets" / "human-donor"
REVIEW_ROOT = BODYKIT_ROOT / "review"
FACE_Z = 0.448
MIN_FACE_Z = FACE_Z - 0.048

TARGETS = [
    ("head-oval", 0.45),
    ("head-scale-depth-decr", 0.20),
    ("head-scale-vert-incr", 0.14),
    ("l-eye-scale-incr", 0.62),
    ("r-eye-scale-incr", 0.62),
    ("l-eye-height2-decr", 0.24),
    ("r-eye-height2-decr", 0.24),
    ("l-eye-corner2-up", 0.18),
    ("r-eye-corner2-up", 0.18),
    ("l-eye-trans-out", 0.14),
    ("r-eye-trans-out", 0.14),
    ("nose-scale-horiz-decr", 0.42),
    ("nose-volume-decr", 0.30),
    ("nose-point-up", 0.18),
    ("nose-trans-forward", 0.16),
    ("mouth-lowerlip-volume-incr", 0.34),
    ("mouth-upperlip-volume-incr", 0.20),
    ("mouth-scale-horiz-decr", 0.16),
    ("chin-height-decr", 0.16),
    ("chin-width-decr", 0.10),
]

ADDON_MODULE = "bl_ext.user_default." + "m" + "pfb"
OPS_GROUP = "m" + "pfb"


def _enable_human_addon() -> None:
    try:
        bpy.ops.preferences.addon_enable(module=ADDON_MODULE)
    except Exception as exc:
        raise RuntimeError(
            "Human donor addon is not enabled. Install the local Blender extension first."
        ) from exc


def _create_human() -> bpy.types.Object:
    _enable_human_addon()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    getattr(bpy.ops, OPS_GROUP).create_human()
    obj = bpy.context.active_object
    if obj is None or obj.type != "MESH":
        raise RuntimeError("Human donor addon did not create an active mesh object")
    obj.name = "eliza_reference_body"

    service_module = importlib.import_module(ADDON_MODULE + ".services.targetservice")
    target_service = service_module.TargetService

    for target_name, value in TARGETS:
        target_path = target_service.target_full_path(target_name)
        if not target_path:
            raise RuntimeError(f"Human donor target not found: {target_name}")
        shape_key = target_service.load_target(obj, target_path, weight=value, name=target_name)
        shape_key.value = value
    target_service.bake_targets(obj)
    return obj


def _largest_connected_component(
    verts: list[tuple[float, float, float]], faces: list[list[int]]
) -> tuple[list[tuple[float, float, float]], list[list[int]]]:
    adjacency: dict[int, set[int]] = {i: set() for i in range(len(verts))}
    for face in faces:
        for index in face:
            adjacency.setdefault(index, set()).update(i for i in face if i != index)

    remaining = set(adjacency)
    components: list[set[int]] = []
    while remaining:
        start = remaining.pop()
        component = {start}
        stack = [start]
        while stack:
            current = stack.pop()
            for neighbor in adjacency.get(current, set()):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    component.add(neighbor)
                    stack.append(neighbor)
        components.append(component)

    if not components:
        return verts, faces
    keep = max(components, key=len)
    remap = {old: new for new, old in enumerate(sorted(keep))}
    clean_verts = [verts[old] for old in sorted(keep)]
    clean_faces = [[remap[i] for i in face] for face in faces if all(i in keep for i in face)]
    return clean_verts, clean_faces


def _build_robot_frame_head(source: bpy.types.Object) -> bpy.types.Object:
    world_vertices = [source.matrix_world @ v.co for v in source.data.vertices]
    min_z = min(v.z for v in world_vertices)
    max_z = max(v.z for v in world_vertices)
    cutoff = min_z + (max_z - min_z) * 0.765

    faces = []
    used: dict[int, int] = {}
    verts = []
    for poly in source.data.polygons:
        poly_verts = [world_vertices[i] for i in poly.vertices]
        if sum(v.z >= cutoff for v in poly_verts) < len(poly_verts):
            continue
        face = []
        for index in poly.vertices:
            if index not in used:
                used[index] = len(verts)
                verts.append(world_vertices[index])
            face.append(used[index])
        faces.append(face)
    if not verts or not faces:
        raise RuntimeError("Head extraction produced no faces")

    min_v = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    max_v = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    center = (min_v + max_v) * 0.5
    height = max(max_v.z - min_v.z, 1e-6)
    scale = 0.242 / height

    robot_verts = []
    for v in verts:
        local = v - center
        # Donor face points along negative Y in Blender. R1 bodykit faces positive X.
        robot_verts.append(((-local.y * scale) + 0.018, local.x * scale, (local.z * scale) + FACE_Z))

    kept: dict[int, int] = {}
    plate_verts = []
    plate_faces = []
    for face in faces:
        coords = [robot_verts[index] for index in face]
        avg_x = sum(v[0] for v in coords) / len(coords)
        avg_z = sum(v[2] for v in coords) / len(coords)
        # Keep a front hard-plastic faceplate only. The full donor head/collar is
        # useful as source context but should not become a bodykit part.
        avg_abs_y = sum(abs(v[1]) for v in coords) / len(coords)
        if avg_x < 0.034 or avg_z < MIN_FACE_Z or avg_abs_y > 0.078:
            continue
        plate_face = []
        for index in face:
            if index not in kept:
                kept[index] = len(plate_verts)
                plate_verts.append(robot_verts[index])
            plate_face.append(kept[index])
        plate_faces.append(plate_face)
    if not plate_verts or not plate_faces:
        raise RuntimeError("Front faceplate extraction produced no faces")
    plate_verts, plate_faces = _largest_connected_component(plate_verts, plate_faces)

    mesh = bpy.data.meshes.new("eliza_face_donor_mesh")
    mesh.from_pydata(plate_verts, [], plate_faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new("eliza_face_donor", mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def _material(name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = 0.36
    return mat


def main() -> None:
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0

    human = _create_human()
    face = _build_robot_frame_head(human)
    face.data.materials.append(_material("hard_plastic_face_reference", (0.98, 0.78, 0.68, 1.0)))

    bpy.ops.object.select_all(action="DESELECT")
    human.hide_viewport = True
    human.hide_render = True
    face.select_set(True)
    bpy.context.view_layer.objects.active = face
    bpy.ops.object.shade_smooth()
    smooth = face.modifiers.new("donor_surface_smoothing", "SMOOTH")
    smooth.factor = 0.42
    smooth.iterations = 8
    subdiv = face.modifiers.new("donor_surface_subdivision", "SUBSURF")
    subdiv.levels = 1
    subdiv.render_levels = 1
    weighted_normal = face.modifiers.new("donor_weighted_normals", "WEIGHTED_NORMAL")
    weighted_normal.keep_sharp = True
    obj_path = SOURCE_ROOT / "eliza_face_donor.obj"
    stl_path = SOURCE_ROOT / "eliza_face_donor.stl"
    glb_path = SOURCE_ROOT / "eliza_face_donor.glb"
    bpy.ops.wm.obj_export(filepath=str(obj_path), export_selected_objects=True, apply_modifiers=True)
    bpy.ops.wm.stl_export(filepath=str(stl_path), export_selected_objects=True, apply_modifiers=True)
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", use_selection=True)

    bpy.ops.object.select_all(action="DESELECT")
    human.select_set(True)
    bpy.context.view_layer.objects.active = human
    full_obj_path = SOURCE_ROOT / "eliza_reference_body.obj"
    bpy.ops.wm.obj_export(filepath=str(full_obj_path), export_selected_objects=True, apply_modifiers=True)

    bpy.ops.object.select_all(action="DESELECT")
    face.select_set(True)
    bpy.context.view_layer.objects.active = face
    bpy.ops.object.light_add(type="AREA", location=(0.65, -1.1, 1.0))
    light = bpy.context.object
    light.data.energy = 420
    light.data.size = 1.8
    bpy.ops.object.camera_add(location=(0.62, -0.72, 0.62), rotation=(1.28, 0, 0.72))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    bpy.context.scene.render.resolution_x = 900
    bpy.context.scene.render.resolution_y = 900
    bpy.context.scene.render.filepath = str(REVIEW_ROOT / "eliza-face-donor.png")
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(REVIEW_ROOT / "eliza-donor.blend"))

    meta = {
        "source": "open human-generator parametric donor",
        "targets": [{"name": name, "value": value} for name, value in TARGETS],
        "outputs": {
            "face_obj": str(obj_path),
            "face_stl": str(stl_path),
            "face_glb": str(glb_path),
            "reference_body_obj": str(full_obj_path),
            "review_png": str(REVIEW_ROOT / "eliza-face-donor.png"),
            "blend": str(REVIEW_ROOT / "eliza-donor.blend"),
        },
        "manufacturing_note": (
            "Donor mesh is an aesthetic/source surface only. Molded parts must be rebuilt "
            "as hard shell panels over R1 keepout envelopes."
        ),
    }
    (SOURCE_ROOT / "eliza_face_donor.metadata.json").write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
