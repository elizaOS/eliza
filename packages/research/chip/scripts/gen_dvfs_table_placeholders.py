#!/usr/bin/env python3
"""Generate per-corner placeholder DVFS tables.

Inputs:
  docs/pd/dvfs-tables/dvfs-table-tt-25c.yaml (canonical TT/25C placeholder)
  docs/pd/rail-plan-2028.yaml (rail envelope authority)

Outputs (one per SS/TT/FF x 0/25/85/105 C corner = 12 files):
  docs/pd/dvfs-tables/dvfs-table-<corner>-<temp>c.yaml

Each output file carries:
  - schema: eliza.dvfs_table.v1
  - status: placeholder_release_blocked
  - corner_status: pending_silicon_corner_sta
  - planning derate vs the TT/25C anchor:
      SS: +1 LSB (6.25 mV) per operating point (slower silicon)
      FF: -1 LSB (6.25 mV) per operating point (faster silicon)
      cold (0 C):  +0 LSB (carrier mobility offsets device leakage; approx wash)
      hot (85 C):  +0 LSB
      hot (105 C): +1 LSB
  Combinations clamp at the [dvfs_min_v, dvfs_max_v] window declared in the
  rail plan; if a derate would push code outside that window, the cell is
  marked `pending_silicon_corner_sta` instead of a numeric value.

These are planning placeholders only; real silicon characterization replaces
them at signoff. Do not use any of these tables for release claims.
"""

from __future__ import annotations

import copy
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TT_25C = ROOT / "docs" / "pd" / "dvfs-tables" / "dvfs-table-tt-25c.yaml"
RAIL_PLAN = ROOT / "docs" / "pd" / "rail-plan-2028.yaml"
OUT_DIR = ROOT / "docs" / "pd" / "dvfs-tables"

CORNERS = ["ss", "tt", "ff"]
TEMPS_C = [0, 25, 85, 105]

PROCESS_DERATE_LSB = {"ss": 1, "tt": 0, "ff": -1}
TEMP_DERATE_LSB = {0: 0, 25: 0, 85: 0, 105: 1}


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow, False)


def code_to_volts(code: int) -> float:
    return code * 6.25e-3


def volts_to_code(v: float) -> int:
    return int(round(v / 6.25e-3))


def main() -> int:
    if not TT_25C.is_file():
        print(f"missing anchor: {TT_25C.relative_to(ROOT)}")
        return 1
    if not RAIL_PLAN.is_file():
        print(f"missing rail plan: {RAIL_PLAN.relative_to(ROOT)}")
        return 1

    anchor = yaml.safe_load(TT_25C.read_text())
    plan = yaml.safe_load(RAIL_PLAN.read_text())
    rail_window = {rail["id"]: (rail["dvfs_min_v"], rail["dvfs_max_v"]) for rail in plan["rails"]}

    for corner in CORNERS:
        for temp in TEMPS_C:
            if corner == "tt" and temp == 25:
                # Anchor file is hand-curated to fit inside the rail plan
                # windows; do not regenerate it from itself.
                continue

            payload = copy.deepcopy(anchor)
            payload["corner"] = corner
            payload["process_temperature_c"] = temp
            payload["corner_status"] = "placeholder_pending_silicon_corner_sta"
            payload["status"] = "placeholder_release_blocked"
            payload["claim_boundary"] = (
                f"Per-corner placeholder for the {corner.upper()} process / "
                f"{temp} C thermal corner. Values are planning derates from "
                f"docs/pd/dvfs-tables/dvfs-table-tt-25c.yaml using the rule "
                f"in scripts/gen_dvfs_table_placeholders.py. Any cell that "
                f"would fall outside the rail plan's [dvfs_min_v, dvfs_max_v] "
                f"window is marked pending_silicon_corner_sta and is not a "
                f"signed-off operating point. Replace with STA-corner-bin "
                f"output from pd/signoff/sta/{corner}-{temp}c/ before signoff."
            )
            payload["release_blockers"] = [
                "Silicon characterization data not available; values are planning derates only.",
                "PDK selection not finalized; STA corner sweep not run.",
                "Voltage guardband policy not formally adopted; placeholder uses 1 DVFS LSB (6.25 mV) per direction.",
            ]
            derate = PROCESS_DERATE_LSB[corner] + TEMP_DERATE_LSB[temp]

            new_rails: dict = {}
            for rail_id, rail_data in anchor["rails"].items():
                vmin, vmax = rail_window.get(rail_id, (0.0, 1.6))
                code_min = volts_to_code(vmin)
                code_max = volts_to_code(vmax)
                new_ops = []
                for op in rail_data.get("operating_points", []):
                    nom = op["nominal_code"] + derate
                    mn = op["min_code"] + derate
                    mx = op["max_code"] + derate
                    if mn < code_min or mx > code_max:
                        new_ops.append(
                            {
                                "frequency_hz": op["frequency_hz"],
                                "nominal_code": "pending_silicon_corner_sta",
                                "min_code": "pending_silicon_corner_sta",
                                "max_code": "pending_silicon_corner_sta",
                            }
                        )
                    else:
                        new_ops.append(
                            {
                                "frequency_hz": op["frequency_hz"],
                                "nominal_code": nom,
                                "min_code": mn,
                                "max_code": mx,
                            }
                        )
                new_rails[rail_id] = {"operating_points": new_ops}
            payload["rails"] = new_rails

            tag = f"{corner}-{temp}c"
            out_path = OUT_DIR / f"dvfs-table-{tag}.yaml"
            _write(out_path, payload)

    print(
        f"wrote {len(CORNERS) * len(TEMPS_C)} corner placeholders under {OUT_DIR.relative_to(ROOT)}"
    )
    return 0


def _write(path: Path, payload: dict) -> None:
    # Stable key order for diffability.
    yaml_text = yaml.dump(
        payload,
        Dumper=IndentedSafeDumper,
        sort_keys=False,
        default_flow_style=False,
    )
    path.write_text(yaml_text)


if __name__ == "__main__":
    raise SystemExit(main())
