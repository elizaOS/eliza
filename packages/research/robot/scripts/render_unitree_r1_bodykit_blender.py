#!/usr/bin/env python3
"""Blender-side review render for the generated Unitree R1 bodykit meshes.

Run with the portable Blender install:

    .tools/blender/blender --background --python scripts/render_unitree_r1_bodykit_blender.py
"""

from __future__ import annotations

from pathlib import Path

import bpy
from mathutils import Vector

PKG_ROOT = Path(__file__).resolve().parents[1]
BODYKIT_ROOT = PKG_ROOT / "mechanical" / "unitree-r1-bodykit"
MESH_ROOT = BODYKIT_ROOT / "out" / "meshes"
REVIEW_ROOT = BODYKIT_ROOT / "review"
ASSEMBLED_OBJ = BODYKIT_ROOT / "out" / "unitree-r1-bodykit-assembled-home.obj"
ASSEMBLED_GLB = BODYKIT_ROOT / "out" / "unitree-r1-bodykit-assembled-home.glb"


MATERIALS = {
    "orange": (1.0, 0.28, 0.03, 1.0),
    "black": (0.01, 0.012, 0.014, 1.0),
    "face": (0.98, 0.78, 0.68, 1.0),
    "detail": (0.02, 0.012, 0.014, 1.0),
}


def _mat(name: str, rgba: tuple[float, float, float, float]) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = 0.28
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def _material_for(part_name: str, mats: dict[str, bpy.types.Material]) -> bpy.types.Material:
    if "eye" in part_name or "lip" in part_name:
        return mats["detail"]
    if "face" in part_name:
        return mats["face"]
    if "black" in part_name:
        return mats["black"]
    return mats["orange"]


def main() -> None:
    REVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.delete()
    mats = {name: _mat(name, color) for name, color in MATERIALS.items()}

    imported = []
    if ASSEMBLED_GLB.is_file():
        bpy.ops.import_scene.gltf(filepath=str(ASSEMBLED_GLB))
        for obj in bpy.context.selected_objects:
            obj.name = "assembled_bodykit_home"
            imported.append(obj)
    elif ASSEMBLED_OBJ.is_file():
        bpy.ops.wm.obj_import(filepath=str(ASSEMBLED_OBJ))
        for obj in bpy.context.selected_objects:
            obj.name = "assembled_bodykit_home"
            obj.data.materials.append(mats["orange"])
            imported.append(obj)
    else:
        for obj_path in sorted(MESH_ROOT.glob("*.obj")):
            bpy.ops.wm.obj_import(filepath=str(obj_path))
            for obj in bpy.context.selected_objects:
                obj.name = obj_path.stem
                obj.data.materials.append(_material_for(obj_path.stem, mats))
                imported.append(obj)

    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = imported[0] if imported else None

    bpy.ops.object.light_add(type="AREA", location=(1.0, -2.5, 2.2))
    light = bpy.context.object
    light.name = "large_softbox"
    light.data.energy = 500
    light.data.size = 4

    coords = []
    for obj in imported:
        for corner in obj.bound_box:
            coords.append(obj.matrix_world @ Vector(corner))
    min_v = Vector((min(v.x for v in coords), min(v.y for v in coords), min(v.z for v in coords)))
    max_v = Vector((max(v.x for v in coords), max(v.y for v in coords), max(v.z for v in coords)))
    center = (min_v + max_v) * 0.5
    radius = max((max_v - min_v).length, 0.5)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=center)
    target = bpy.context.object
    bpy.ops.object.camera_add(location=center + Vector((radius * 0.9, -radius * 1.45, radius * 0.38)))
    camera = bpy.context.object
    constraint = camera.constraints.new(type="TRACK_TO")
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    constraint.target = target
    bpy.context.scene.camera = camera

    bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    bpy.context.scene.render.resolution_x = 1280
    bpy.context.scene.render.resolution_y = 960
    bpy.context.scene.eevee.taa_render_samples = 64
    bpy.context.scene.view_settings.view_transform = "Filmic"
    bpy.context.scene.render.filepath = str(REVIEW_ROOT / "blender-bodykit-parts.png")
    bpy.ops.render.render(write_still=True)

    bpy.ops.wm.save_as_mainfile(filepath=str(REVIEW_ROOT / "unitree-r1-bodykit.blend"))


if __name__ == "__main__":
    main()
