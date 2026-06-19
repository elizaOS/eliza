"""Per-part mechanical analysis for erobot.

Closed-form mechanics for every load-bearing part, each reported with the
governing stress (or load) and a safety factor against the material/component
allowable. Conservative worst-case loads: peak actuator torque reacted through
the part, plus the body weight under a dynamic impact factor carried on a single
leg.

Checks by part class:
  * limb tubes (capsule shells) — combined bending + axial + torsion (von Mises),
    plus Euler column buckling for the compression members.
  * trunk/foot boxes — beam bending under the reacted joint moment.
  * joint housings (spheres) — wall shear reacting the motor torque.
  * output bearings — radial load vs the crossed-roller static rating.
  * toe tendons — cable tension vs Dyneema breaking strength.
  * fasteners — bolt-circle shear reacting the joint torque.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import MATERIALS, RobotSpec, build_spec

PROOFS_ROOT = Path(__file__).resolve().parents[2] / "cad" / "erobot" / "proofs"
DLF = 2.5                  # dynamic load factor
MIN_SF = 2.0
G = 9.81

# component allowables
_BEARING_STATIC_N = 10_000.0     # THK RB5013 crossed-roller, conservative C0
_CABLE_BREAK_N = 1800.0          # 1.5 mm Dyneema/UHMWPE
_CABLE_MAX_TENSION_N = 60.0      # toe actuator ctrlrange ceiling
_BOLT_SHEAR_PA = 210e6           # A2-70 stainless shear allowable
_BOLT_AREA = {"M3": 5.03e-6, "M4": 8.78e-6}   # tensile stress areas (m^2)
_BOLT_BY_TIER = {"high": ("M4", 6), "mid": ("M4", 4), "low": ("M3", 4)}
_BOLT_CIRCLE_R = {"high": 0.052, "mid": 0.044, "low": 0.030}


def _tube(part: str, group: str, mat_key: str, r: float, wall: float, length: float,
          moment_nm: float, axial_n: float, torque_nm: float) -> dict:
    mat = MATERIALS[mat_key]
    t = wall / 1000.0
    area = 2.0 * math.pi * r * t
    i_area = math.pi * r ** 3 * t
    j_polar = 2.0 * math.pi * r ** 3 * t
    sigma_b = moment_nm * r / i_area
    sigma_a = axial_n / area
    tau = torque_nm * r / j_polar
    sigma_axialbend = sigma_b + sigma_a
    sigma_vm = math.sqrt(sigma_axialbend ** 2 + 3.0 * tau ** 2)
    sf = mat.allowable_stress_pa / sigma_vm if sigma_vm > 0 else math.inf
    # Euler buckling (pinned-pinned column) for the compression member
    p_cr = math.pi ** 2 * mat.elastic_modulus_pa * i_area / (length ** 2) if length > 0 else math.inf
    buckle_sf = p_cr / axial_n if axial_n > 0 else math.inf
    return {
        "part": part, "class": "tube", "group": group, "material": mat_key,
        "radius_mm": round(r * 1000, 1), "wall_mm": round(wall, 1), "length_mm": round(length * 1000, 1),
        "bending_mpa": round(sigma_b / 1e6, 2), "axial_mpa": round(sigma_a / 1e6, 2),
        "torsion_mpa": round(tau / 1e6, 2), "von_mises_mpa": round(sigma_vm / 1e6, 2),
        "allowable_mpa": round(mat.allowable_stress_pa / 1e6, 1),
        "buckling_sf": round(buckle_sf, 1),
        "safety_factor": round(sf, 2), "pass": bool(sf >= MIN_SF and buckle_sf >= MIN_SF),
    }


def _box(part: str, group: str, mat_key: str, half: tuple[float, float, float],
         wall: float, moment_nm: float) -> dict:
    mat = MATERIALS[mat_key]
    # thin-wall box bent about its weak (smallest) axis: section modulus of the
    # two faces that resist bending, Z ~ 2 * (face_area) * lever.
    b = 2 * half[1]
    h = 2 * half[0]
    t = wall / 1000.0
    z = (b * t) * h + (t * h ** 2) / 3.0   # walls contributing to bending about y
    sigma = moment_nm / z if z > 0 else math.inf
    sf = mat.allowable_stress_pa / sigma if sigma > 0 else math.inf
    return {
        "part": part, "class": "box", "group": group, "material": mat_key,
        "wall_mm": round(wall, 1), "applied_moment_nm": round(moment_nm, 1),
        "bending_mpa": round(sigma / 1e6, 2), "allowable_mpa": round(mat.allowable_stress_pa / 1e6, 1),
        "safety_factor": round(sf, 2), "pass": bool(sf >= MIN_SF),
    }


def _housing(part: str, mat_key: str, r: float, wall: float, torque_nm: float) -> dict:
    mat = MATERIALS[mat_key]
    t = wall / 1000.0
    # motor torque reacted as shear flow in the housing wall (thin shell torsion)
    tau = torque_nm / (2.0 * math.pi * r ** 2 * t)
    sf = (mat.allowable_stress_pa * 0.577) / tau if tau > 0 else math.inf  # shear allowable
    return {
        "part": part, "class": "housing", "material": mat_key,
        "radius_mm": round(r * 1000, 1), "wall_mm": round(wall, 1),
        "torque_nm": round(torque_nm, 1), "wall_shear_mpa": round(tau / 1e6, 2),
        "shear_allowable_mpa": round(mat.allowable_stress_pa * 0.577 / 1e6, 1),
        "safety_factor": round(sf, 2), "pass": bool(sf >= MIN_SF),
    }


def mechanical_analysis(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    budget = compute_budget(spec)
    weight_n = budget.total_mass_kg * G
    leg_axial = weight_n * DLF

    parts: list[dict] = []
    for body in spec.bodies:
        if body.joint is None:
            continue
        torque = body.joint.torque_nm
        axial = leg_axial if body.group == "LEG" else 0.0
        for g in body.geoms:
            if g.role != "shell":
                continue
            if g.type == "capsule":
                length = math.dist(g.fromto[:3], g.fromto[3:])
                parts.append(_tube(g.name, body.group, g.material_key, g.size[0],
                                   g.wall_mm, length, moment_nm=torque, axial_n=axial,
                                   torque_nm=torque * 0.3))
            elif g.type == "sphere":
                parts.append(_housing(g.name, g.material_key, g.size[0], g.wall_mm, torque))
            elif g.type == "box":
                parts.append(_box(g.name, body.group, g.material_key, g.size, g.wall_mm, torque))
            elif g.type in ("cylinder", "ellipsoid"):
                # neck tube / head shell — light, bending under its own joint torque
                r = g.size[0] if g.type == "cylinder" else max(g.size)
                parts.append(_housing(g.name, g.material_key, r, g.wall_mm, torque))

    # bearings (6 crossed-roller on the high-tier hip/knee outputs)
    n_bearings = sum(1 for b in spec.bodies if b.actuator_tier == "high")
    bearing_load = weight_n * DLF / 2.0
    bearings = {
        "part": "crossed_roller_bearings", "class": "bearing", "count": n_bearings,
        "load_n": round(bearing_load, 1), "static_rating_n": _BEARING_STATIC_N,
        "safety_factor": round(_BEARING_STATIC_N / bearing_load, 1),
        "pass": _BEARING_STATIC_N / bearing_load >= MIN_SF,
    }

    # toe tendons
    tendon = {
        "part": "toe_tendon_cable", "class": "tendon", "count": 2,
        "max_tension_n": _CABLE_MAX_TENSION_N, "breaking_n": _CABLE_BREAK_N,
        "safety_factor": round(_CABLE_BREAK_N / _CABLE_MAX_TENSION_N, 1),
        "pass": _CABLE_BREAK_N / _CABLE_MAX_TENSION_N >= MIN_SF,
    }

    # fasteners — worst case is the high-tier joint reacting peak torque
    fasteners = []
    for tier, torque in (("high", 120.0), ("mid", 24.0), ("low", 10.0)):
        bolt, n = _BOLT_BY_TIER[tier]
        r_bc = _BOLT_CIRCLE_R[tier]
        f_bolt = torque / (n * r_bc)
        tau = f_bolt / _BOLT_AREA[bolt]
        sf = _BOLT_SHEAR_PA / tau
        fasteners.append({
            "tier": tier, "bolt": bolt, "count": n, "torque_nm": torque,
            "bolt_shear_mpa": round(tau / 1e6, 1), "allowable_mpa": round(_BOLT_SHEAR_PA / 1e6, 1),
            "safety_factor": round(sf, 1), "pass": sf >= MIN_SF,
        })

    everything = parts + [bearings, tendon] + fasteners
    worst = min(everything, key=lambda p: p["safety_factor"])
    return {
        "schema": "erobot-mechanical-analysis-v1",
        "ok": all(p["pass"] for p in everything),
        "method": "closed-form: tube von Mises + Euler buckling, box beam bending, "
                  "housing wall shear, bearing static rating, cable tension, bolt-circle shear",
        "loads": {"robot_weight_n": round(weight_n, 1), "dynamic_load_factor": DLF,
                  "single_leg_axial_n": round(leg_axial, 1)},
        "min_safety_factor": worst["safety_factor"],
        "worst_part": worst.get("part", worst.get("tier")),
        "structural_parts": parts,
        "bearings": bearings, "tendons": tendon, "fasteners": fasteners,
    }


def write_analysis(spec: RobotSpec | None = None) -> Path:
    spec = spec or build_spec()
    PROOFS_ROOT.mkdir(parents=True, exist_ok=True)
    out = PROOFS_ROOT / "mechanical-analysis.json"
    out.write_text(json.dumps(mechanical_analysis(spec), indent=2) + "\n", encoding="utf-8")
    return out


if __name__ == "__main__":
    a = mechanical_analysis()
    print(f"mechanical analysis: ok={a['ok']} min SF={a['min_safety_factor']} (worst: {a['worst_part']})")
    print(f"  loads: weight {a['loads']['robot_weight_n']} N, single-leg axial {a['loads']['single_leg_axial_n']} N")
    fails = [p for p in a["structural_parts"] if not p["pass"]]
    print(f"  structural parts: {len(a['structural_parts'])}, failures: {len(fails)}")
    for p in sorted(a["structural_parts"], key=lambda p: p["safety_factor"])[:6]:
        print(f"    {p['part']:24s} {p['class']:8s} SF={p['safety_factor']:<7} pass={p['pass']}")
    print(f"  bearings SF={a['bearings']['safety_factor']} tendon SF={a['tendons']['safety_factor']} "
          f"fastener SF(min)={min(f['safety_factor'] for f in a['fasteners'])}")
    print(f"  wrote {write_analysis()}")
