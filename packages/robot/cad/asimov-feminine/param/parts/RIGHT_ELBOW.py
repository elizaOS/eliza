"""RIGHT_ELBOW — exact Y-mirror of the LEFT_ELBOW femme mesh.

The hard requirement is that mirror parts get the SAME treatment mirrored across
Y. The source LEFT/RIGHT meshes are not perfect mirrors of each other (different
triangulations), so warping each side independently would inherit that source
asymmetry. Instead we build the LEFT femme once (LEFT_ELBOW.build) and reflect
it across Y, guaranteeing true L/R symmetry by construction. Spine/reserved data
is unchanged by a Y reflection.
"""
import sys
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param')
sys.path.insert(0, '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot/cad/asimov-feminine/param/parts')
import trimesh
import LEFT_ELBOW as LE

PART = 'RIGHT_ELBOW'
ROOT = '/Users/shawwalters/eliza-workspace/milady/eliza/packages/robot'
OUT = f'{ROOT}/cad/asimov-feminine/output/stl/{PART}.STL'


def build():
    left = LE.build()  # writes LEFT, returns the femme mesh
    right = left.copy()
    right.apply_scale([1.0, -1.0, 1.0])  # reflect across Y (robot left → right)
    trimesh.repair.fix_normals(right)
    if right.volume < 0:
        right.invert()
    right.export(OUT)
    rb = right.bounds
    print(f"=== {PART} (Y-mirror of LEFT_ELBOW) ===")
    for i, ax in enumerate('XYZ'):
        print(f"  {ax}: femme={(rb[1][i]-rb[0][i])*1000:.1f}mm")
    print(f"  watertight={right.is_watertight} vol={right.volume*1e6:.1f}cm3")
    return right


if __name__ == '__main__':
    build()
