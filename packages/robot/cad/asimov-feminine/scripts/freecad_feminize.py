"""
FreeCAD B-rep parametric feminization of ASIMOV-1 robot.

This script operates on the STEP fabrication parts (MJF_PA12 shells only),
applies shape transformations, and exports modified simulation STL files
in link-local coordinate frames matching the MJCF.

Usage:
  /opt/homebrew/Caskroom/freecad/1.1.1/FreeCAD.app/Contents/Resources/bin/freecadcmd \
    packages/robot/cad/asimov-feminine/scripts/freecad_feminize.py

Outputs to: packages/robot/cad/asimov-feminine/output/stl/
"""
import FreeCAD
import Part
import MeshPart
import Mesh
import sys
import os
import math

STEP_BASE = '/tmp/asimov-1-src/mechanical/ASV1'
STL_OUT   = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/output/stl'
os.makedirs(STL_OUT, exist_ok=True)

FREECAD_CMD = '/opt/homebrew/Caskroom/freecad/1.1.1/FreeCAD.app/Contents/Resources/bin/freecadcmd'

# ---------------------------------------------------------------------------
# Joint origin world positions (meters) — from MJCF kinematic chain
# These define the link-local → world coordinate transform.
# link-local = world_STEP_pos - joint_origin_world
# ---------------------------------------------------------------------------
JOINT_WORLD = {
    'IMU_ORIGIN':           FreeCAD.Vector(  0.000,  0.000,  630.0),
    'WAIST_YAW':            FreeCAD.Vector(-52.000,  0.000,  704.8),
    'LEFT_HIP_PITCH':       FreeCAD.Vector(-52.000, 67.500,  586.0),
    'LEFT_HIP_ROLL':        FreeCAD.Vector( -9.700, 107.50,  586.0),
    'LEFT_HIP_YAW':         FreeCAD.Vector(-52.000, 107.50,  534.0),
    'LEFT_KNEE':            FreeCAD.Vector(-52.000, 107.50,  338.3),
    'LEFT_ANKLE_A':         FreeCAD.Vector(-52.000, 107.50,   43.7),
    'LEFT_ANKLE_B':         FreeCAD.Vector(-53.500, 107.50,   33.7),
    'LEFT_TOE':             FreeCAD.Vector( 49.000, 103.10,   26.9),
    'RIGHT_HIP_PITCH':      FreeCAD.Vector(-52.000,-67.500,  586.0),
    'RIGHT_HIP_ROLL':       FreeCAD.Vector( -9.700,-107.50,  586.0),
    'RIGHT_HIP_YAW':        FreeCAD.Vector(-52.000,-107.50,  534.0),
    'RIGHT_KNEE':           FreeCAD.Vector(-52.000,-107.50,  338.3),
    'RIGHT_ANKLE_A':        FreeCAD.Vector(-52.000,-107.40,   43.7),
    'RIGHT_ANKLE_B':        FreeCAD.Vector(-53.500,-107.40,   33.7),
    'RIGHT_TOE':            FreeCAD.Vector( 49.000,-103.10,   26.9),
    'NECK_YAW':             FreeCAD.Vector(-68.600,  0.000, 1082.9),
    'NECK_PITCH':           FreeCAD.Vector(-68.600,  0.000, 1120.3),
    'LEFT_SHOULDER_PITCH':  FreeCAD.Vector(-78.200, 96.500,  965.9),
    'LEFT_SHOULDER_ROLL':   FreeCAD.Vector(-78.100, 161.90,  965.9),
    'LEFT_SHOULDER_YAW':    FreeCAD.Vector(-78.100, 161.90,  836.9),
    'LEFT_ELBOW':           FreeCAD.Vector(-78.100, 161.90,  740.6),
    'LEFT_WRIST_YAW':       FreeCAD.Vector(  8.500, 161.90,  668.0),
    'RIGHT_SHOULDER_PITCH': FreeCAD.Vector(-78.200,-96.500,  965.9),
    'RIGHT_SHOULDER_ROLL':  FreeCAD.Vector(-78.200,-161.90,  965.8),
    'RIGHT_SHOULDER_YAW':   FreeCAD.Vector(-78.200,-161.90,  836.8),
    'RIGHT_ELBOW':          FreeCAD.Vector(-78.200,-161.90,  740.2),
    'RIGHT_WRIST_YAW':      FreeCAD.Vector(  8.400,-161.90,  667.6),
}

# ---------------------------------------------------------------------------
# World bounding boxes of simulation links (mm) — derived from simulation STLs
# Used to assign STEP parts to their kinematic link.
# ---------------------------------------------------------------------------
LINK_WORLD_BOUNDS = {
    'IMU_ORIGIN':           {'z': (526, 710),   'y': (-67, 67),     'x': None},
    'WAIST_YAW':            {'z': (701, 1083),  'y': (-125, 125),   'x': None},
    'NECK_YAW':             {'z': (1081, 1156), 'y': (-33, 28),     'x': None},
    'NECK_PITCH':           {'z': (1069, 1253), 'y': (-65, 67),     'x': None},
    'LEFT_HIP_PITCH':       {'z': (545, 641),   'y': (64, 162),     'x': None},
    'LEFT_HIP_ROLL':        {'z': (529, 609),   'y': (77, 130),     'x': None},
    'LEFT_HIP_YAW':         {'z': (302, 611),   'y': (52, 167),     'x': None},
    'LEFT_KNEE':            {'z': (30, 400),    'y': (58, 159),     'x': None},
    'LEFT_ANKLE_A':         {'z': (11, 62),     'y': (82, 133),     'x': None},
    'LEFT_ANKLE_B':         {'z': (0, 66),      'y': (62, 159),     'x': None},
    'LEFT_TOE':             {'z': (-3, 38),     'y': (53, 149),     'x': None},
    'RIGHT_HIP_PITCH':      {'z': (545, 641),   'y': (-162, -64),   'x': None},
    'RIGHT_HIP_ROLL':       {'z': (529, 609),   'y': (-130, -77),   'x': None},
    'RIGHT_HIP_YAW':        {'z': (302, 611),   'y': (-167, -52),   'x': None},
    'RIGHT_KNEE':           {'z': (30, 400),    'y': (-159, -58),   'x': None},
    'RIGHT_ANKLE_A':        {'z': (11, 62),     'y': (-133, -82),   'x': None},
    'RIGHT_ANKLE_B':        {'z': (0, 66),      'y': (-159, -62),   'x': None},
    'RIGHT_TOE':            {'z': (-3, 38),     'y': (-149, -53),   'x': None},
    'LEFT_SHOULDER_PITCH':  {'z': (933, 999),   'y': (78, 195),     'x': None},
    'LEFT_SHOULDER_ROLL':   {'z': (832, 1016),  'y': (112, 212),    'x': None},
    'LEFT_SHOULDER_YAW':    {'z': (707, 842),   'y': (130, 195),    'x': None},
    'LEFT_ELBOW':           {'z': (642, 774),   'y': (125, 199),    'x': None},
    'LEFT_WRIST_YAW':       {'z': (645, 685),   'y': (143, 181),    'x': None},
    'RIGHT_SHOULDER_PITCH': {'z': (924, 1007),  'y': (-195, -78),   'x': None},
    'RIGHT_SHOULDER_ROLL':  {'z': (832, 1016),  'y': (-212, -112),  'x': None},
    'RIGHT_SHOULDER_YAW':   {'z': (706, 842),   'y': (-195, -129),  'x': None},
    'RIGHT_ELBOW':          {'z': (642, 774),   'y': (-199, -125),  'x': None},
    'RIGHT_WRIST_YAW':      {'z': (644, 685),   'y': (-181, -143),  'x': None},
}

# ---------------------------------------------------------------------------
# Feminization parameters
# ---------------------------------------------------------------------------
FEMME_PARAMS = {
    # Torso: waist cinch + breast shape
    'waist_y_scale':     0.82,   # 18% narrower waist (Y axis)
    'waist_z_scale':     1.00,   # height unchanged
    'torso_x_scale':     0.96,   # slightly shallower front-back

    # Hips: outward flare (X axis for robot frame where X is front-back)
    'hip_flare_scale':   1.12,   # 12% wider hips perpendicular to sagittal

    # Arms: slimmer upper arms
    'arm_xy_scale':      0.90,   # 10% slimmer arms

    # Shoulder pauldron: scale up shoulder roll link
    'shoulder_flare':    1.10,   # 10% wider shoulder caps

    # Breast parameters (applied to front chest surface)
    'breast_radius':     38.0,   # mm dome radius
    'breast_y_offset':   48.0,   # mm lateral offset from midline
    'breast_z_center_frac': 0.55, # fraction from bottom of torso to breast center

    # Pelvis: keep original (structural constraints)
}


def load_step(path):
    """Load a STEP file as a Part.Shape."""
    shape = Part.Shape()
    shape.read(path)
    return shape


def bbox_world(shape):
    """Return (z_min, z_max, y_min, y_max, x_min, x_max) in mm."""
    bb = shape.BoundBox
    return bb.ZMin, bb.ZMax, bb.YMin, bb.YMax, bb.XMin, bb.XMax


def assign_to_link(z_min, z_max, y_min, y_max):
    """Find the simulation link whose world bounds best overlap the part's bounds."""
    best_link = None
    best_vol = 0.0
    for link, bounds in LINK_WORLD_BOUNDS.items():
        lz = bounds['z']
        ly = bounds['y']
        # Intersection volume
        iz = max(0, min(z_max, lz[1]) - max(z_min, lz[0]))
        iy = max(0, min(y_max, ly[1]) - max(y_min, ly[0]))
        vol = iz * iy
        if vol > best_vol:
            best_vol = vol
            best_link = link
    return best_link, best_vol


def scale_shape(shape, sx, sy, sz):
    """Apply non-uniform scale via B-rep transform."""
    mat = FreeCAD.Matrix()
    mat.A11 = sx
    mat.A22 = sy
    mat.A33 = sz
    return shape.transformGeometry(mat)


def make_breast_dome(radius, center_vec):
    """Create a hemisphere B-rep solid for breast mound."""
    sphere = Part.makeSphere(radius, center_vec)
    # Cut off the back hemisphere (keep only front half facing +X)
    # Cut plane at X = center_x - 5 (so dome starts just before mounting surface)
    box = Part.makeBox(radius * 3, radius * 3, radius * 3,
                       FreeCAD.Vector(center_vec.x - radius * 3, center_vec.y - radius * 1.5, center_vec.z - radius * 1.5))
    dome = sphere.cut(box)
    return dome


def apply_torso_femme(shape):
    """
    Apply feminization to a torso shell:
    1. Waist cinch (Y-axis compression)
    2. Breast mounds (add hemispheres on front face)
    3. Slight front-back compression
    """
    p = FEMME_PARAMS
    bb = shape.BoundBox

    # Step 1: Apply waist scale
    mat = FreeCAD.Matrix()
    mat.A11 = p['torso_x_scale']
    mat.A22 = p['waist_y_scale']
    mat.A33 = p['waist_z_scale']
    cinched = shape.transformGeometry(mat)

    # Step 2: Add breast mounds
    # Find front face X position (max X after scaling)
    bb2 = cinched.BoundBox
    front_x = bb2.XMax
    z_center = bb2.ZMin + (bb2.ZMax - bb2.ZMin) * p['breast_z_center_frac']

    r = p['breast_radius']
    y_off = p['breast_y_offset'] * p['waist_y_scale']  # scale Y offset with waist

    # Position breast dome centers slightly inside the front surface
    center_l = FreeCAD.Vector(front_x - r * 0.3, y_off, z_center)
    center_r = FreeCAD.Vector(front_x - r * 0.3, -y_off, z_center)

    try:
        dome_l = make_breast_dome(r, center_l)
        dome_r = make_breast_dome(r, center_r)
        result = cinched.fuse(dome_l)
        result = result.fuse(dome_r)
        if result.isValid() and len(result.Solids) >= 1:
            print(f"    Breast domes fused successfully")
            return result
        else:
            print(f"    Breast dome fusion invalid, returning cinched only")
            return cinched
    except Exception as e:
        print(f"    Breast dome failed ({e}), returning cinched only")
        return cinched


def apply_hip_femme(shape, is_left):
    """Hip flare: expand the hip housing outward (Y axis for left/right)."""
    p = FEMME_PARAMS
    sy = p['hip_flare_scale']
    # Flip Y direction for right side
    mat = FreeCAD.Matrix()
    mat.A11 = 1.0
    mat.A22 = sy
    mat.A33 = 1.0
    return shape.transformGeometry(mat)


def apply_arm_femme(shape):
    """Slim the arm: scale XY down."""
    p = FEMME_PARAMS
    s = p['arm_xy_scale']
    mat = FreeCAD.Matrix()
    mat.A11 = s
    mat.A22 = s
    mat.A33 = 1.0
    return shape.transformGeometry(mat)


def apply_shoulder_femme(shape):
    """Shoulder pauldron: scale slightly, then add a flared ring."""
    p = FEMME_PARAMS
    # Scale up the shoulder cap
    s = p['shoulder_flare']
    mat = FreeCAD.Matrix()
    mat.A11 = s
    mat.A22 = s
    mat.A33 = 1.0
    flared = shape.transformGeometry(mat)

    # Add a disc pauldron flange
    bb = flared.BoundBox
    z_bot = bb.ZMin
    pauldron_h = 8.0  # mm thick rim
    pauldron_r_outer = max(bb.XLength, bb.YLength) * 0.6
    pauldron_r_inner = max(bb.XLength, bb.YLength) * 0.40

    try:
        outer_cyl = Part.makeCylinder(pauldron_r_outer, pauldron_h,
                                      FreeCAD.Vector(0, 0, z_bot - pauldron_h))
        inner_cyl = Part.makeCylinder(pauldron_r_inner, pauldron_h,
                                      FreeCAD.Vector(0, 0, z_bot - pauldron_h))
        ring = outer_cyl.cut(inner_cyl)
        result = flared.fuse(ring)
        if result.isValid():
            print(f"    Pauldron ring added")
            return result
        else:
            print(f"    Pauldron ring invalid, returning flared only")
            return flared
    except Exception as e:
        print(f"    Pauldron ring failed ({e}), returning flared only")
        return flared


def export_to_stl(shape, out_path, linear_deflection=0.3):
    """Tessellate B-rep shape and write to STL."""
    mesh = MeshPart.meshFromShape(
        Shape=shape,
        LinearDeflection=linear_deflection,
        AngularDeflection=0.3,
        Relative=False
    )
    mesh.write(out_path)
    return mesh.CountFacets


def world_to_link_local(shape, joint_world_mm):
    """Translate a world-space shape to link-local frame (mm)."""
    mat = FreeCAD.Matrix()
    mat.A14 = -joint_world_mm.x
    mat.A24 = -joint_world_mm.y
    mat.A34 = -joint_world_mm.z
    return shape.transformGeometry(mat)


# ---------------------------------------------------------------------------
# Main processing pipeline
# ---------------------------------------------------------------------------

def get_all_mjf_parts():
    """Return list of (sub_id, part_name, full_path) for all MJF_PA12 STEP files."""
    parts = []
    for sub in ['100', '200', '300', '400', '500', '600', '700']:
        mjf_dir = os.path.join(STEP_BASE, sub, 'FABRICATION', 'MJF_PA12')
        if not os.path.isdir(mjf_dir):
            continue
        for fname in sorted(os.listdir(mjf_dir)):
            upper = fname.upper()
            # Handle double extension like ASV1_600_03C.step.STEP
            if '.STEP' in upper:
                parts.append((sub, fname, os.path.join(mjf_dir, fname)))
    return parts


def process_part(sub, part_name, part_path):
    """
    Load, transform, assign to link, export.
    Returns (link_name, out_path) or None on error.
    """
    print(f"\n  [{sub}] {part_name}")

    try:
        shape = load_step(part_path)
    except Exception as e:
        print(f"    LOAD ERROR: {e}")
        return None

    if not shape.isValid():
        print(f"    INVALID SHAPE, skipping")
        return None

    z_min, z_max, y_min, y_max, x_min, x_max = bbox_world(shape)
    print(f"    BBox: X[{x_min:.0f},{x_max:.0f}] Y[{y_min:.0f},{y_max:.0f}] Z[{z_min:.0f},{z_max:.0f}] mm")

    link, overlap = assign_to_link(z_min, z_max, y_min, y_max)
    if link is None or overlap < 100:
        print(f"    No clear link assignment (best overlap {overlap:.0f}), skipping")
        return None
    print(f"    → Link: {link} (overlap area {overlap:.0f} mm²)")

    # Apply appropriate transform based on link
    transformed = None

    if link == 'WAIST_YAW':
        print(f"    Applying torso feminization (waist cinch + breast)")
        transformed = apply_torso_femme(shape)

    elif link in ('LEFT_HIP_YAW', 'LEFT_HIP_PITCH', 'LEFT_HIP_ROLL'):
        print(f"    Applying hip flare (left)")
        transformed = apply_hip_femme(shape, is_left=True)

    elif link in ('RIGHT_HIP_YAW', 'RIGHT_HIP_PITCH', 'RIGHT_HIP_ROLL'):
        print(f"    Applying hip flare (right)")
        transformed = apply_hip_femme(shape, is_left=False)

    elif link in ('LEFT_SHOULDER_ROLL', 'RIGHT_SHOULDER_ROLL'):
        print(f"    Applying shoulder pauldron")
        transformed = apply_shoulder_femme(shape)

    elif link in ('LEFT_SHOULDER_YAW', 'LEFT_ELBOW', 'LEFT_WRIST_YAW',
                  'RIGHT_SHOULDER_YAW', 'RIGHT_ELBOW', 'RIGHT_WRIST_YAW'):
        print(f"    Applying arm taper")
        transformed = apply_arm_femme(shape)

    else:
        print(f"    No transform for this link, exporting original")
        transformed = shape

    if transformed is None or not transformed.isValid():
        print(f"    Transform produced invalid shape, using original")
        transformed = shape

    # Convert from world to link-local coordinates
    joint_origin = JOINT_WORLD.get(link)
    if joint_origin:
        local_shape = world_to_link_local(transformed, joint_origin)
        print(f"    Translated to link-local (subtracted joint origin {joint_origin})")
    else:
        local_shape = transformed

    # Export
    out_name = f"{part_name.replace('.STEP', '').replace('.step', '')}_femme.stl"
    out_path = os.path.join(STL_OUT, out_name)
    try:
        n_facets = export_to_stl(local_shape, out_path)
        print(f"    Exported: {out_path} ({n_facets} facets)")
    except Exception as e:
        print(f"    EXPORT ERROR: {e}")
        return None

    return link, out_path


def merge_link_stl(link, part_stl_paths):
    """Merge multiple per-part STL files into a single link STL."""
    if not part_stl_paths:
        return

    merged = Mesh.Mesh()
    for p in part_stl_paths:
        m = Mesh.Mesh(p)
        merged.addMesh(m)

    out_path = os.path.join(STL_OUT, f"{link}.STL")
    merged.write(out_path)
    print(f"  Merged {len(part_stl_paths)} parts → {out_path} ({merged.CountFacets} facets)")
    return out_path


def main():
    print("=" * 60)
    print("ASIMOV-1 Feminine B-rep Transformation Pipeline")
    print("=" * 60)

    parts = get_all_mjf_parts()
    print(f"\nFound {len(parts)} MJF_PA12 fabrication parts")

    link_parts = {}  # link_name → [stl_paths]

    for sub, part_name, part_path in parts:
        result = process_part(sub, part_name, part_path)
        if result:
            link, out_path = result
            link_parts.setdefault(link, []).append(out_path)

    print("\n" + "=" * 60)
    print("Merging parts per kinematic link")
    print("=" * 60)

    link_stl_paths = {}
    for link, paths in sorted(link_parts.items()):
        print(f"\n  {link}: {len(paths)} parts")
        out = merge_link_stl(link, paths)
        if out:
            link_stl_paths[link] = out

    print("\n" + "=" * 60)
    print(f"Generated {len(link_stl_paths)} link STL files in {STL_OUT}")
    print("Links processed:", ', '.join(sorted(link_stl_paths.keys())))
    print("=" * 60)


if __name__ == '__main__':
    main()
