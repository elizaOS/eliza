"""Feminize LEFT_TOE: parametric spine + cross-section loft.

Warp logic lives in _footlib.build('LEFT_TOE'); run this file to rebuild + write the
femme STL and print a validation report. See _footlib.py for the per-part intent.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
import _footlib as F
import connections as C

NAME = 'LEFT_TOE'

if __name__ == '__main__':
    orig, femme, param, out = F.write(NAME)
    ob, rb = orig.bounds, femme.bounds
    print(f"=== {NAME} ===")
    for i, ax in enumerate('XYZ'):
        o = (ob[1][i] - ob[0][i]) * 1000.0
        r = (rb[1][i] - rb[0][i]) * 1000.0
        print(f"  {ax}: orig={o:7.2f}mm femme={r:7.2f}mm ratio={r/o:.3f}")
    print(f"  watertight={femme.is_watertight}")
    print(f"  reserved={[round(x,4) for x in C.reserved_levels(NAME)]}")
    print(f"  wrote {out}")
