#!/usr/bin/env python3
"""Collect post-route PPA for an E1 macro-array OpenLane run and score it.

This closes the (c)/(d) half of the macro-placement replay loop: read the real
post-route metrics from a completed OpenLane run's ``62-checker-xor/state_out.json``
and reduce them to the canonical PPA slice the 07_post_route_ppa experiment used:

  * route wirelength (estimated)
  * setup WNS / TNS at the nominal corner (nom_tt_025C_1v80)
  * hold WNS at the nominal corner
  * first-iteration route DRC count
  * antenna-violating nets
  * instance / macro counts and total power

It then scores each placement against the others on a lexicographic objective
matching the placement case (minimize setup TNS, then wirelength, then route DRC,
then antenna). All numbers are read from real OpenLane state; nothing is
fabricated. If a run directory has no completed checker state, that placement is
recorded as BLOCKED rather than scored.

Reads ``pd/openlane/runs/`` and writes only ``build/ai_eda/e1_macro_array_ppa/``.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNS_ROOT = ROOT / "pd/openlane/runs"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/e1_macro_array_ppa"
CLAIM_BOUNDARY = "e1_macro_array_post_route_ppa_collection_only_no_release_claim"
NOM_CORNER = "corner:nom_tt_025C_1v80"
CHECKER_STATE = "62-checker-xor/state_out.json"
MACRO_ARRAY_DESIGN = "e1_npu_weight_buffer_array"

# Maps each placement variant to the MACRO_PLACEMENT_CFG basename OpenLane records
# in resolved.json so we can attribute a completed run to a placement.
VARIANT_CFG_BASENAME = {
    "baseline_4x2": "macro_array_baseline.cfg",
    "compact_4x2": "macro_array_cand_compact.cfg",
    "stack_2x4": "macro_array_cand_stack2x4.cfg",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def metric(metrics: dict[str, Any], key: str) -> float | int | None:
    value = metrics.get(key)
    return value if isinstance(value, (int, float)) else None


def extract_ppa(state_out: dict[str, Any]) -> dict[str, Any]:
    metrics = state_out.get("metrics", state_out)
    return {
        "route_wirelength_est": metric(metrics, "route__wirelength__estimated"),
        "route_wirelength_routed": metric(metrics, "route__wirelength"),
        "setup_ws_ns": metric(metrics, f"timing__setup__ws__{NOM_CORNER}"),
        "setup_tns_ns": metric(metrics, f"timing__setup__tns__{NOM_CORNER}"),
        "hold_ws_ns": metric(metrics, f"timing__hold__ws__{NOM_CORNER}"),
        "route_drc_iter1": metric(metrics, "route__drc_errors__iter:1"),
        "route_drc_final": metric(metrics, "route__drc_errors"),
        "antenna_violating_nets": metric(metrics, "antenna__violating__nets"),
        "instance_count": metric(metrics, "design__instance__count"),
        "macro_count": metric(metrics, "design__instance__count__class:macro"),
        "power_total": metric(metrics, "power__total"),
    }


def find_runs(runs_root: Path) -> dict[str, dict[str, Any]]:
    """Attribute completed macro-array runs to placement variants.

    The latest completed run per variant wins (run dirs sort chronologically).
    """

    found: dict[str, dict[str, Any]] = {}
    if not runs_root.exists():
        return found
    for run_dir in sorted(runs_root.glob("RUN_*")):
        resolved = run_dir / "resolved.json"
        checker = run_dir / CHECKER_STATE
        if not resolved.is_file() or not checker.is_file():
            continue
        config = load_json(resolved)
        if config.get("DESIGN_NAME") != MACRO_ARRAY_DESIGN:
            continue
        cfg = str(config.get("MACRO_PLACEMENT_CFG", ""))
        basename = Path(cfg).name
        variant = next((name for name, base in VARIANT_CFG_BASENAME.items() if base == basename), None)
        if variant is None:
            continue
        found[variant] = {"run_dir": run_dir, "checker": checker}
    return found


def lexicographic_rank(ppa_by_variant: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    def sort_key(item: tuple[str, dict[str, Any]]) -> tuple[float, float, float, float]:
        ppa = item[1]
        # Minimize: -TNS magnitude (less negative is better -> larger TNS),
        # then wirelength, route DRC, antenna. Use sentinels for missing values.
        tns = ppa.get("setup_tns_ns")
        wl = ppa.get("route_wirelength_est")
        drc = ppa.get("route_drc_iter1")
        ant = ppa.get("antenna_violating_nets")
        return (
            -(tns if isinstance(tns, (int, float)) else -1e18),
            wl if isinstance(wl, (int, float)) else 1e18,
            drc if isinstance(drc, (int, float)) else 1e18,
            ant if isinstance(ant, (int, float)) else 1e18,
        )

    ordered = sorted(ppa_by_variant.items(), key=sort_key)
    ranked = []
    for rank, (variant, ppa) in enumerate(ordered, start=1):
        ranked.append({"rank": rank, "variant": variant, "ppa": ppa})
    return ranked


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--runs-root", type=Path, default=DEFAULT_RUNS_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    runs = find_runs(args.runs_root)

    ppa_by_variant: dict[str, dict[str, Any]] = {}
    blocked: list[dict[str, Any]] = []
    for variant, cfg_basename in VARIANT_CFG_BASENAME.items():
        entry = runs.get(variant)
        if entry is None:
            blocked.append(
                {
                    "variant": variant,
                    "reason": "no completed OpenLane run with 62-checker-xor state for this placement",
                    "expected_cfg": cfg_basename,
                }
            )
            continue
        state_out = load_json(entry["checker"])
        ppa = extract_ppa(state_out)
        ppa["run_dir"] = rel(entry["run_dir"])
        ppa["checker_state"] = rel(entry["checker"])
        ppa_by_variant[variant] = ppa

    ranked = lexicographic_rank(ppa_by_variant)
    baseline = ppa_by_variant.get("baseline_4x2")
    deltas: dict[str, Any] = {}
    if baseline:
        for variant, ppa in ppa_by_variant.items():
            if variant == "baseline_4x2":
                continue
            variant_deltas: dict[str, Any] = {}
            for key in ("route_wirelength_est", "setup_tns_ns", "route_drc_iter1"):
                base_value = baseline.get(key)
                value = ppa.get(key)
                if isinstance(base_value, (int, float)) and isinstance(value, (int, float)) and base_value:
                    variant_deltas[f"{key}_pct_vs_baseline"] = round(
                        (value - base_value) / abs(base_value) * 100.0, 3
                    )
            deltas[variant] = variant_deltas

    status = "COLLECTED_POST_ROUTE_PPA" if ppa_by_variant else "BLOCKED_NO_COMPLETED_RUNS"
    report = {
        "schema": "eliza.ai_eda.e1_macro_array_post_route_ppa.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "design_name": MACRO_ARRAY_DESIGN,
        "nominal_corner": NOM_CORNER,
        "placement_case_id": "e1-macro-array-weight-buffer-placement-case",
        "variants_collected": sorted(ppa_by_variant),
        "ppa_by_variant": ppa_by_variant,
        "ranking": ranked,
        "deltas_vs_baseline": deltas,
        "best_variant": ranked[0]["variant"] if ranked else None,
        "blocked": blocked,
        "release_use_allowed": False,
    }
    report_path = out_dir / "post_route_ppa.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    label = "PASS" if ppa_by_variant else "PASS_BLOCKED"
    print(
        f"STATUS: {label} ai_eda.e1_macro_array_post_route_ppa "
        f"collected={len(ppa_by_variant)} blocked={len(blocked)} "
        f"best={report['best_variant']} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
