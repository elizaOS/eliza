"""Bill of materials for erobot.

Two classes of part:

  * **Off-the-shelf** — actuators, compute, sensors, battery, bearings,
    fasteners, camera. Each line carries a confirmed-or-estimated unit price and
    a vendor source URL (pricing researched 2026-05; treat as planning numbers,
    re-RFQ before purchase).
  * **Custom injection-molded shells** — the structural plastic. Derived from
    the spec geometry: shell resin mass drives material cost, and each unique
    part needs a mold (tooling capex). Left/right mirror parts share one mold.

Actuator quantities are pulled from the spec's per-joint tier assignment, so the
BOM can never drift from the kinematics. Everything rolls up to a mass total
(reconciled against :mod:`eliza_robot.erobot.mass`) and a cost total at qty 1
and qty 1000.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from eliza_robot.erobot.mass import compute_budget
from eliza_robot.erobot.spec import MATERIALS, RobotSpec, build_spec

MECH_ROOT = Path(__file__).resolve().parents[2] / "mechanical" / "erobot"

PRICED_ON = "2026-05-30"


@dataclass(frozen=True)
class Part:
    category: str
    name: str
    vendor: str
    model: str
    spec: str
    qty: int
    unit_mass_kg: float
    unit_price_qty1_usd: float
    unit_price_qty1000_usd: float
    source_url: str
    confirmed: bool
    note: str = ""

    @property
    def line_mass_kg(self) -> float:
        return self.qty * self.unit_mass_kg

    @property
    def line_cost_qty1(self) -> float:
        return self.qty * self.unit_price_qty1_usd

    @property
    def line_cost_qty1000(self) -> float:
        return self.qty * self.unit_price_qty1000_usd


# Resin cost ($/kg) for molded shells — Xometry/PolymersX references, qty-dependent.
RESIN_USD_PER_KG = {
    "PA6_GF30": 12.0,
    "PC_ABS": 7.0,
    "TPU_SHORE_A95": 5.0,
}
# Per-mold tooling (aluminum bridge tool for small humanoid shells), and the
# molding/finishing labor added on top of resin per part.
TOOLING_USD_PER_MOLD = 7000.0
MOLDING_LABOR_QTY1_USD = 35.0      # FDM/SLA prototype regime per shell
MOLDING_LABOR_QTY1000_USD = 4.5    # injection-molded per shell at qty 1000


def _tier_counts(spec: RobotSpec) -> Counter[str]:
    return Counter(j.tier for j in spec.joints)


def off_the_shelf_parts(spec: RobotSpec) -> list[Part]:
    tiers = _tier_counts(spec)
    parts: list[Part] = [
        # --- actuators (qty tied to spec tiers) ---
        Part("actuator", "High-torque leg actuator", "CubeMars", "AK80-64 (KV80)",
             "120 N·m peak / 48 N·m rated, 48 V, CAN", tiers["high"], 0.85,
             889.90, 560.0, "https://store.cubemars.com/products/ak80-64", True,
             "hip pitch/roll + knee. List price confirmed; qty-1000 ~37% volume est."),
        Part("actuator", "Mid-torque joint actuator", "CubeMars", "AK70-10 (KV100)",
             "24.8 N·m peak / 8.3 N·m rated, 48 V, CAN", tiers["mid"], 0.52,
             398.90, 255.0, "https://store.cubemars.com/products/ak70-10", True,
             "hip yaw, ankles, shoulders, elbows, waist. List confirmed; qty-1000 est."),
        Part("actuator", "Low-torque smart servo", "Robotis", "Dynamixel XM540-W270-R",
             "10.6 N·m stall, 12 V, TTL/RS-485", tiers["low"], 0.165,
             494.39, 360.0, "https://robotis.us/dynamixel-xm540-w270-r/", True,
             "wrist yaw + neck pitch/yaw. List confirmed."),
        # --- compute + sensing ---
        Part("compute", "Onboard compute", "NVIDIA", "Jetson Orin Nano Super Dev Kit",
             "8 GB, 67 TOPS", 1, 0.18, 249.0, 230.0,
             "https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/nano-super-developer-kit/",
             True, "Confirmed. Carrier accepts Orin NX 16 GB upgrade (~$599 module)."),
        Part("sensor", "IMU", "Bosch / SparkFun", "BMI088 breakout",
             "6-axis, SPI/I2C", 1, 0.01, 18.50, 10.0,
             "https://www.digikey.com/en/products/detail/bosch-sensortec/BMI088/8634936",
             True, "Confirmed at Digi-Key."),
        Part("sensor", "Head depth + RGB camera", "Intel", "RealSense D435i",
             "stereo depth + RGB + IMU, ~10 m", 1, 0.072, 320.0, 220.0,
             "https://store.intelrealsense.com/buy-intel-realsense-depth-camera-d435i.html",
             False, "D435 lists ~$149; D435i ~$280-340 — Intel store 403'd, estimate."),
        # --- power ---
        Part("power", "Battery pack", "Custom (Aegis/DNK class)", "13S Li-ion NMC ~400 Wh",
             "~46 V, ~400 Wh", 1, 2.2, 420.0, 130.0,
             "https://www.bioennopower.com/products/48v-10ah-lfp-battery-black-a-pvc-pack",
             False,
             "Off-the-shelf 48 V 10 Ah LiFePO4 (Bioenno BLF-4810A, $299.99) is 5.1 kg "
             "and blows the mass budget; a custom 13S Li-ion pack at ~2.2 kg is required. "
             "Price is a contact-sales estimate."),
        Part("power", "Power distribution board + DC-DC + wiring", "Custom / Pololu",
             "PDB + 48->5/12/19 V buck + harness", "split rails, e-stop", 1, 0.9,
             120.0, 55.0, "https://www.pololu.com/category/130/step-down-voltage-regulators",
             False, "Harness + regulators + connectors, estimate."),
        # --- bearings (only passive high-load joints; QDD units have integral bearings) ---
        Part("bearing", "Crossed-roller joint bearing", "THK", "RB5013 (50x80x13 mm)",
             "crossed-roller slewing", 6, 0.27, 110.0, 48.0,
             "https://us.amazon.com/Original-Roller-Bearings-RB5013UUCC0-RB5013UUC0/dp/B0DSZFCC7Y",
             False, "Hip/knee output reinforcement; ~6 units. Price estimate."),
        # --- fasteners / inserts ---
        Part("fastener", "Brass heat-set inserts (M3x5.7)", "CNC Kitchen", "M3 x 5.7 (100 pc)",
             "for plastic bosses", 3, 0.02, 14.0, 8.0,
             "https://cnckitchen.store/products/heat-set-insert-m3-x-5-7-100-pieces",
             False, "~300 inserts across the robot; 3 packs. Estimate."),
        Part("fastener", "Socket-head screws M3/M4 (assorted)", "McMaster-Carr",
             "A2 stainless SHCS kit", "M3/M4 x various", 4, 0.05, 12.0, 6.0,
             "https://www.mcmaster.com/products/inserts/thread-size~m3/", False,
             "~400 screws. Estimate."),
        # --- foot ---
        Part("wear", "Molded TPU sole pads", "Custom", "TPU 90A sole (pair)",
             "high-friction wear pad", 2, 0.05, 18.0, 7.0,
             "https://www.polymersx.com/product/tpu-price/", False,
             "Counted separately from the structural sole shell. Estimate."),
    ]
    return parts


def _shell_part_groups(spec: RobotSpec) -> dict[str, dict]:
    """Group structural shells by mirror-independent base name -> aggregate."""
    budget = compute_budget(spec)
    gm_by_name = {gm.name: gm for bm in budget.bodies for gm in bm.geoms}
    groups: dict[str, dict] = {}
    for body in spec.bodies:
        for g in body.geoms:
            if g.role != "shell":
                continue
            base = g.name.replace("left_", "").replace("right_", "")
            gm = gm_by_name[g.name]
            entry = groups.setdefault(base, {
                "base": base, "material": g.material_key, "wall_mm": g.wall_mm,
                "count": 0, "unit_mass_kg": gm.mass_kg, "unit_volume_m3": gm.volume_m3,
            })
            entry["count"] += 1
    return groups


def molded_shell_parts(spec: RobotSpec) -> list[Part]:
    """Each unique shell part is a custom injection-molded clamshell (2 halves).

    A unique part needs one mold; left/right mirrors share tooling. Resin mass
    drives material cost; molding labor + amortized tooling are added in the
    cost roll-up (tooling is reported separately as capex).
    """
    parts: list[Part] = []
    for base, e in sorted(_shell_part_groups(spec).items()):
        mat = MATERIALS[e["material"]]
        resin_per_kg = RESIN_USD_PER_KG[e["material"]]
        # each shell is 2 molded halves; resin per part = shell mass * 2.1 (sprue/runner)
        resin_mass = e["unit_mass_kg"]
        resin_cost = resin_mass * resin_per_kg * 2.1
        unit_qty1 = resin_cost + MOLDING_LABOR_QTY1_USD
        unit_qty1000 = resin_cost + MOLDING_LABOR_QTY1000_USD
        parts.append(Part(
            category="molded_shell",
            name=f"{base} (2-piece clamshell)",
            vendor="Injection molder (Xometry/Protolabs/Fictiv)",
            model=mat.name,
            spec=f"wall {e['wall_mm']} mm, shell mass {resin_mass*1000:.0f} g",
            qty=e["count"],
            unit_mass_kg=e["unit_mass_kg"],
            unit_price_qty1_usd=round(unit_qty1, 2),
            unit_price_qty1000_usd=round(unit_qty1000, 2),
            source_url="https://www.xometry.com/resources/injection-molding/injection-molding-cost/",
            confirmed=False,
            note="Custom molded. Qty-1 is FDM/SLA prototype regime; qty-1000 is molded.",
        ))
    return parts


@dataclass(frozen=True)
class Bom:
    parts: list[Part]
    n_unique_molds: int
    tooling_capex_usd: float

    def total_mass_kg(self) -> float:
        return sum(p.line_mass_kg for p in self.parts)

    def total_cost_qty1(self) -> float:
        return sum(p.line_cost_qty1 for p in self.parts)

    def total_cost_qty1000(self) -> float:
        # qty-1000 spreads tooling capex across 1000 units
        return sum(p.line_cost_qty1000 for p in self.parts) + self.tooling_capex_usd / 1000.0


def build_bom(spec: RobotSpec | None = None) -> Bom:
    spec = spec or build_spec()
    shells = molded_shell_parts(spec)
    n_molds = len(_shell_part_groups(spec))  # one mold per unique part (mirrors shared)
    parts = off_the_shelf_parts(spec) + shells
    return Bom(parts=parts, n_unique_molds=n_molds,
              tooling_capex_usd=n_molds * TOOLING_USD_PER_MOLD)


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def _category_rollup(bom: Bom) -> dict[str, dict[str, float]]:
    roll: dict[str, dict[str, float]] = {}
    for p in bom.parts:
        c = roll.setdefault(p.category, {"qty": 0, "mass_kg": 0.0, "cost_qty1": 0.0, "cost_qty1000": 0.0})
        c["qty"] += p.qty
        c["mass_kg"] += p.line_mass_kg
        c["cost_qty1"] += p.line_cost_qty1
        c["cost_qty1000"] += p.line_cost_qty1000
    return {k: {kk: round(vv, 2) for kk, vv in v.items()} for k, v in roll.items()}


def bom_json(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    bom = build_bom(spec)
    budget = compute_budget(spec)
    return {
        "schema": "erobot-bom-v1",
        "priced_on": PRICED_ON,
        "currency": "USD",
        "robot": {"profile_id": spec.profile_id, "dof": spec.dof,
                  "standing_height_m": round(spec.standing_height_m, 4)},
        "totals": {
            "bom_mass_kg": round(bom.total_mass_kg(), 3),
            "mass_model_total_kg": round(budget.total_mass_kg, 3),
            "cost_qty1_usd": round(bom.total_cost_qty1(), 2),
            "cost_qty1000_usd_per_unit": round(bom.total_cost_qty1000(), 2),
            "tooling_capex_usd": round(bom.tooling_capex_usd, 2),
            "unique_molds": bom.n_unique_molds,
        },
        "by_category": _category_rollup(bom),
        "parts": [asdict(p) for p in bom.parts],
    }


def sourcing_cost_model_json(spec: RobotSpec | None = None) -> dict:
    spec = spec or build_spec()
    bom = build_bom(spec)
    shells = [p for p in bom.parts if p.category == "molded_shell"]
    ots = [p for p in bom.parts if p.category != "molded_shell"]
    return {
        "schema": "erobot-sourcing-cost-model-v1",
        "priced_on": PRICED_ON,
        "off_the_shelf": {
            "line_items": len(ots),
            "cost_qty1_usd": round(sum(p.line_cost_qty1 for p in ots), 2),
            "cost_qty1000_usd": round(sum(p.line_cost_qty1000 for p in ots), 2),
            "confirmed_prices": sum(1 for p in ots if p.confirmed),
            "estimated_prices": sum(1 for p in ots if not p.confirmed),
        },
        "custom_molded": {
            "unique_parts": len(shells),
            "total_molded_pieces": sum(p.qty for p in shells),
            "tooling_capex_usd": round(bom.tooling_capex_usd, 2),
            "tooling_usd_per_mold": TOOLING_USD_PER_MOLD,
            "shell_cost_qty1_usd": round(sum(p.line_cost_qty1 for p in shells), 2),
            "shell_cost_qty1000_usd": round(sum(p.line_cost_qty1000 for p in shells), 2),
            "resin_usd_per_kg": RESIN_USD_PER_KG,
        },
        "unit_cost_curve": {
            "qty1_usd": round(bom.total_cost_qty1(), 2),
            "qty1000_usd_per_unit": round(bom.total_cost_qty1000(), 2),
        },
        "blockers": [
            "Battery is a custom Li-ion pack (contact-sales); stock LiFePO4 is too heavy.",
            "RealSense D435i, bearing, fastener, PDB, and TPU prices are estimates pending RFQ.",
            "Mid-tier actuator at 24.8 N·m peak limits dynamic gait; verify against gait torque demand.",
            "Shell tooling assumes aluminum family tools; final mold count depends on part splits + draft.",
        ],
    }


def _money(x: float) -> str:
    return f"${x:,.2f}"


def bom_markdown(spec: RobotSpec | None = None) -> str:
    spec = spec or build_spec()
    bom = build_bom(spec)
    data = bom_json(spec)
    t = data["totals"]
    budget = compute_budget(spec)

    lines = [
        "# erobot — Bill of Materials",
        "",
        f"Generated from the parametric spec by `eliza_robot.erobot.bom`. Priced {PRICED_ON} (USD).",
        "Prices are planning numbers — confirmed items cite a live vendor page; estimated items",
        "need an RFQ. Re-run `python -m eliza_robot.erobot.build` to regenerate.",
        "",
        "## Totals",
        "",
        f"- Robot: {spec.dof}-DoF humanoid, {data['robot']['standing_height_m']} m standing.",
        f"- **BOM mass: {t['bom_mass_kg']} kg** (sim mass model: {t['mass_model_total_kg']} kg; "
        "the delta is discrete bearings/fasteners/wear pads not modeled as sim shells).",
        f"- **Unit cost @ qty 1: {_money(t['cost_qty1_usd'])}**",
        f"- **Unit cost @ qty 1000: {_money(t['cost_qty1000_usd_per_unit'])}/unit** "
        f"(incl. amortized tooling).",
        f"- Tooling capex: {_money(t['tooling_capex_usd'])} across {t['unique_molds']} molds.",
        "",
        "## By category",
        "",
        "| Category | Qty | Mass (kg) | Cost @ qty 1 | Cost @ qty 1000 |",
        "|---|---:|---:|---:|---:|",
    ]
    for cat, c in sorted(data["by_category"].items(), key=lambda kv: -kv[1]["cost_qty1"]):
        lines.append(f"| {cat} | {int(c['qty'])} | {c['mass_kg']:.2f} | "
                     f"{_money(c['cost_qty1'])} | {_money(c['cost_qty1000'])} |")

    lines += ["", "## Off-the-shelf parts", "",
              "| Part | Vendor / Model | Spec | Qty | Unit mass (kg) | Unit $ (qty 1) | Unit $ (qty 1k) | Price | Source |",
              "|---|---|---|---:|---:|---:|---:|:--:|---|"]
    for p in bom.parts:
        if p.category == "molded_shell":
            continue
        flag = "confirmed" if p.confirmed else "est."
        lines.append(
            f"| {p.name} | {p.vendor} {p.model} | {p.spec} | {p.qty} | {p.unit_mass_kg:.3f} | "
            f"{_money(p.unit_price_qty1_usd)} | {_money(p.unit_price_qty1000_usd)} | {flag} | "
            f"[link]({p.source_url}) |")

    lines += ["", "## Custom injection-molded shells", "",
              "Each unique shell is a 2-piece clamshell bolted around its actuator with brass "
              "heat-set inserts (left/right mirrors share one mold). Qty-1 is the FDM/SLA "
              "prototype regime; qty-1000 is molded PC-ABS / PA6-GF30.", "",
              "| Shell | Material | Spec | Pieces | Unit mass (kg) | Unit $ (qty 1) | Unit $ (qty 1k) |",
              "|---|---|---|---:|---:|---:|---:|"]
    for p in bom.parts:
        if p.category != "molded_shell":
            continue
        lines.append(f"| {p.name} | {p.model} | {p.spec} | {p.qty} | {p.unit_mass_kg:.3f} | "
                     f"{_money(p.unit_price_qty1_usd)} | {_money(p.unit_price_qty1000_usd)} |")

    lines += ["", "## Mass reconciliation vs sim model", "",
              "| Source | Mass (kg) |", "|---|---:|",
              f"| Structural shells (PA6-GF30 + PC-ABS) | {budget.shell_mass_kg:.2f} |",
              f"| Off-the-shelf actuators (25) | {budget.actuator_mass_kg:.2f} |",
              f"| Electronics + battery (lumped in sim) | {sum_electronics():.2f} |",
              f"| **Sim mass model total** | **{budget.total_mass_kg:.2f}** |",
              f"| + bearings / fasteners / wear pads (BOM-only) | {t['bom_mass_kg']-budget.total_mass_kg:.2f} |",
              f"| **BOM total** | **{t['bom_mass_kg']:.2f}** |", ""]
    return "\n".join(lines) + "\n"


def sum_electronics() -> float:
    from eliza_robot.erobot.mass import ELECTRONICS_KG_TOTAL
    return ELECTRONICS_KG_TOTAL


def sourcing_plan_markdown(spec: RobotSpec | None = None) -> str:
    spec = spec or build_spec()
    scm = sourcing_cost_model_json(spec)
    tiers = _tier_counts(spec)
    return f"""# erobot Sourcing and Cost Plan

Date: {PRICED_ON}

## Design source

- erobot is designed from scratch in this repo. The single source of truth is the
  parametric spec `eliza_robot/erobot/spec.py`; the MJCF, URDF, profile, and this
  BOM are all generated from it.
- Reference robots studied for proportions, joint counts, and shell strategy:
  Unitree G1/H1/R1 (`assets/profiles/unitree-*`) and the ASIMOV fembot CAD
  (`cad/asimov-feminine/`).

## Actuator strategy (off-the-shelf QDD)

| Tier | DoF | Count | Part | Peak torque | Unit mass | Unit $ (qty 1) |
|---|---|---:|---|---:|---:|---:|
| High | hip pitch/roll, knee | {tiers['high']} | CubeMars AK80-64 | 120 N·m | 0.85 kg | $889.90 |
| Mid | hip yaw, ankles, shoulders, elbows, waist | {tiers['mid']} | CubeMars AK70-10 | 24.8 N·m | 0.52 kg | $398.90 |
| Low | wrist yaw, neck | {tiers['low']} | Dynamixel XM540-W270 | 10.6 N·m | 0.165 kg | $494.39 |

Quasi-direct-drive units are chosen for backdrivability + integral encoders/bearings,
keeping the joint count of dedicated bearings low. The mid tier at 24.8 N·m peak is
the cost/mass sweet spot but limits aggressive dynamic gait — flagged below.

## Fabrication sources

- **FDM/SLA prototype** (qty 1): local ASA/PETG or service bureau from `assets/profiles/erobot/mesh`
  derived STLs. First fit + aesthetic check, not production-grade.
- **Injection molding** (qty 100-10k): Xometry / Protolabs / Fictiv. Aluminum family
  tools for bridge volume, steel for production. PC-ABS for cosmetic orange shells,
  PA6-GF30 for load paths (legs, pelvis, spine), TPU for soles.
- Resin $/kg used: PA6-GF30 ${RESIN_USD_PER_KG['PA6_GF30']}, PC-ABS ${RESIN_USD_PER_KG['PC_ABS']},
  TPU ${RESIN_USD_PER_KG['TPU_SHORE_A95']}. Source: Xometry injection-molding cost guide.

## Cost model

- Off-the-shelf: {_money(scm['off_the_shelf']['cost_qty1_usd'])} at qty 1,
  {_money(scm['off_the_shelf']['cost_qty1000_usd'])} at qty 1000
  ({scm['off_the_shelf']['confirmed_prices']} confirmed / {scm['off_the_shelf']['estimated_prices']} estimated prices).
- Custom molded: {scm['custom_molded']['unique_parts']} unique parts / {scm['custom_molded']['total_molded_pieces']} pieces;
  tooling capex {_money(scm['custom_molded']['tooling_capex_usd'])}.
- **Whole robot: {_money(scm['unit_cost_curve']['qty1_usd'])} at qty 1,
  {_money(scm['unit_cost_curve']['qty1000_usd_per_unit'])}/unit at qty 1000.**

## RFQ package required before quotes

- Production STEP for all {scm['custom_molded']['unique_parts']} unique shells (convert primitives to solids).
- Per-part material + finish callouts; parting-line + draft review (2° draft baked into spec).
- 2D tolerance drawings for actuator-mounting bosses + bearing seats.
- Assembly BOM with fasteners, heat-set inserts, and wiring harness.
- Clearance report (the joint-sweep proof) passing static + dynamic gates.

## Open blockers

{chr(10).join('- ' + b for b in scm['blockers'])}
"""


def write_bom_files(spec: RobotSpec | None = None) -> dict[str, Path]:
    spec = spec or build_spec()
    MECH_ROOT.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}

    out["bom_json"] = MECH_ROOT / "bom.json"
    out["bom_json"].write_text(json.dumps(bom_json(spec), indent=2) + "\n", encoding="utf-8")

    out["cost_model"] = MECH_ROOT / "sourcing-cost-model.json"
    out["cost_model"].write_text(json.dumps(sourcing_cost_model_json(spec), indent=2) + "\n",
                                 encoding="utf-8")

    out["bom_md"] = MECH_ROOT / "BOM.md"
    out["bom_md"].write_text(bom_markdown(spec), encoding="utf-8")

    out["sourcing_md"] = MECH_ROOT / "sourcing-and-cost-plan.md"
    out["sourcing_md"].write_text(sourcing_plan_markdown(spec), encoding="utf-8")
    return out


if __name__ == "__main__":
    spec = build_spec()
    paths = write_bom_files(spec)
    for k, p in paths.items():
        print(f"wrote {k}: {p}")
    data = bom_json(spec)
    t = data["totals"]
    print(f"erobot BOM — {len(data['parts'])} line items")
    print(f"  BOM mass:        {t['bom_mass_kg']} kg  (mass-model {t['mass_model_total_kg']} kg)")
    print(f"  cost @ qty 1:    ${t['cost_qty1_usd']:,}")
    print(f"  cost @ qty 1000: ${t['cost_qty1000_usd_per_unit']:,}/unit")
    print(f"  tooling capex:   ${t['tooling_capex_usd']:,} ({t['unique_molds']} molds)")
    for cat, c in sorted(data["by_category"].items(), key=lambda kv: -kv[1]["cost_qty1"]):
        print(f"    {cat:14s} qty={int(c['qty']):3d}  {c['mass_kg']:6.2f} kg  ${c['cost_qty1']:>9,.0f} -> ${c['cost_qty1000']:>8,.0f}")
