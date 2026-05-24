"""RIGHT_WRIST_YAW — exact Y-mirror of the LEFT_WRIST_YAW femme mesh.

Build the LEFT femme hand once and reflect it across Y so the RIGHT hand is a
true mirror by construction (the LEFT/RIGHT source meshes have slightly
different triangulations, so independent warps would not match exactly). The
wrist mate at z=0 is unaffected by a Y reflection, so it stays pinned.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param/parts')
import trimesh
import LEFT_WRIST_YAW as LW

PART = 'RIGHT_WRIST_YAW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'


def build():
    left = LW.build()  # writes LEFT, returns the femme mesh
    right = left.copy()
    right.apply_scale([1.0, -1.0, 1.0])  # reflect across Y
    trimesh.repair.fix_normals(right)
    if right.volume < 0:
        right.invert()
    right.export(OUT)
    rb = right.bounds
    print(f"=== {PART} (Y-mirror of LEFT_WRIST_YAW) ===")
    for i, ax in enumerate('XYZ'):
        print(f"  {ax}: femme={(rb[1][i]-rb[0][i])*1000:.1f}mm")
    print(f"  watertight={right.is_watertight} vol={right.volume*1e6:.2f}cm3")
    return right


if __name__ == '__main__':
    build()
