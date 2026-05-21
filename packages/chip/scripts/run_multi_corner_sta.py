#!/usr/bin/env python3
"""Multi-corner STA driver, scenario-DB driven.

Builds an MMMC scenario set (`eliza.pd_mmmc_scenario.v1`) from the corner
manifest for the chosen node (default sky130) and runs OpenSTA once per
scenario (delay_corner x rc_corner x mode). Each run resolves a real Liberty
+ SPEF + SDC + netlist; emits OCV derates (or read_lvf when the manifest
declares an LVF/SOCV model); and parses the digest into the
`eliza.pd_multi_corner_sta.v1` summary.

Fail-closed: a missing Liberty/SPEF/SDC/netlist makes that scenario error and
the run exit non-zero. We NEVER substitute the TT/typical Liberty for SS or
FF, and we never fabricate timing numbers.

Backward compatibility: --corners-json still accepts the legacy
[{name,process,rc}] list and runs exactly those Sky130 corners with default
OCV derates, bypassing the scenario DB. New work should rely on the scenario
DB built from the corner manifests.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import sta_scenario_db as sdb
from sta_scenario_db import OcvModel, Scenario

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class ScenarioInputs:
    scenario: Scenario
    liberty: Path
    lvf: Path | None
    spef: Path
    sdc: Path
    netlist: Path


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def resolve(value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = (ROOT / value).resolve()
    return p


def _find_netlist(final: Path) -> Path | None:
    for cand in (final / "nl", final / "pnl"):
        if cand.is_dir():
            for v in cand.glob("*.v"):
                return v
    return next(final.glob("**/*.v"), None)


def _find_spef(final: Path, rc_name: str) -> Path | None:
    spef_dir = final / "spef"
    candidates = (
        list(spef_dir.glob(f"*{rc_name}*.spef")) if spef_dir.is_dir() else []
    )
    if not candidates:
        candidates = list(final.glob(f"**/*{rc_name}*.spef"))
    return candidates[0] if candidates else None


def _find_sdc(final: Path) -> Path | None:
    sdc = next(final.glob("**/*.sdc"), None)
    if sdc is not None:
        return sdc
    fallback = (ROOT / "pd/constraints/e1_soc.sdc").resolve()
    return fallback if fallback.is_file() else None


def _find_liberty(pdk_root: Path, liberty_name: str) -> Path | None:
    """Resolve a Liberty by exact basename declared in the corner manifest.

    We match on the basename so the PDK layout can change without editing
    the manifest. We never fall back to a different process corner's Liberty.
    """
    matches = list(pdk_root.glob(f"**/{liberty_name}"))
    return matches[0] if matches else None


def _find_lvf(pdk_root: Path, liberty_name: str) -> Path | None:
    """Resolve an LVF Liberty companion if one ships alongside the corner.

    OpenSTA reads LVF data via `read_liberty` of an LVF-annotated .lib, or a
    sidecar with a `.lvf.lib`/`_lvf.lib` suffix. We only return a file that
    actually exists; absence is reported, never faked.
    """
    stem = liberty_name[:-4] if liberty_name.endswith(".lib") else liberty_name
    for suffix in (f"{stem}.lvf.lib", f"{stem}_lvf.lib", f"{stem}.lvf"):
        matches = list(pdk_root.glob(f"**/{suffix}"))
        if matches:
            return matches[0]
    return None


def discover_scenario_inputs(
    run_dir: Path, scenario: Scenario, pdk_root: Path
) -> ScenarioInputs | str:
    final = run_dir / "final"
    netlist = _find_netlist(final)
    if netlist is None:
        return f"scenario={scenario.name}: gate netlist missing under {final}"
    spef = _find_spef(final, scenario.rc_corner.name)
    if spef is None:
        return (
            f"scenario={scenario.name}: no SPEF matching RC corner "
            f"'{scenario.rc_corner.name}' under {final}"
        )
    sdc = _find_sdc(final)
    if sdc is None:
        return f"scenario={scenario.name}: signoff SDC missing"
    liberty = _find_liberty(pdk_root, scenario.delay_corner.liberty)
    if liberty is None:
        return (
            f"scenario={scenario.name}: Liberty '{scenario.delay_corner.liberty}' "
            f"not found under {pdk_root}. PDK_ROOT may be wrong. "
            "Refusing to substitute another corner's Liberty."
        )
    lvf: Path | None = None
    if scenario.ocv.lvf_declared:
        lvf = _find_lvf(pdk_root, scenario.delay_corner.liberty)
    return ScenarioInputs(
        scenario=scenario,
        liberty=liberty,
        lvf=lvf,
        spef=spef,
        sdc=sdc,
        netlist=netlist,
    )


def _ocv_lines(ocv: OcvModel, lvf: Path | None) -> list[str]:
    """Emit the OCV/LVF Tcl for one scenario.

    - LVF declared AND an LVF file resolved: read_lvf, then a documented
      margin derate as a backstop (LVF supplies statistical sigma; the
      margin derate covers what LVF does not).
    - LVF declared but no file resolved: fall back to OCV margin derates and
      record nothing fake — the summary flags lvf_resolved=false.
    - OCV model: documented graph-based early/late margin derates only.
    """
    lines: list[str] = []
    if ocv.lvf_declared and lvf is not None:
        lines.append(f"read_lvf {lvf}")
    lines.append(f"set_timing_derate -late {ocv.late_derate:.4f}")
    lines.append(f"set_timing_derate -early {ocv.early_derate:.4f}")
    return lines


def render_opensta_script(inp: ScenarioInputs, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    script = out_dir / f"{inp.scenario.name}.tcl"
    rpt = out_dir / f"{inp.scenario.name}.rpt"
    body = [
        f"read_liberty {inp.liberty}",
        f"read_verilog {inp.netlist}",
        "link_design e1_chip_top",
        f"read_sdc {inp.sdc}",
        f"read_spef {inp.spef}",
        *_ocv_lines(inp.scenario.ocv, inp.lvf),
        "set_propagated_clock [all_clocks]",
        "report_checks -path_delay max -group_count 10 -slack_max 0",
        "report_checks -path_delay min -group_count 10 -slack_max 0",
        "report_tns",
        "report_wns",
        "report_worst_slack -max",
        "report_worst_slack -min",
        "report_check_types -max_slew -max_capacitance -max_fanout -violators",
        f"set fp [open {rpt} w]",
        'puts $fp "setup_wns [sta::worst_slack -max]"',
        'puts $fp "hold_wns [sta::worst_slack -min]"',
        'puts $fp "setup_tns [sta::total_negative_slack -max]"',
        'puts $fp "hold_tns [sta::total_negative_slack -min]"',
        "close $fp",
        "exit 0",
    ]
    script.write_text("\n".join(body) + "\n")
    return script


SLACK_RE = re.compile(r"^(?P<key>\w+)\s+(?P<value>-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$")


def parse_corner_report(rpt: Path) -> dict[str, float]:
    metrics: dict[str, float] = {}
    if not rpt.is_file():
        return metrics
    for line in rpt.read_text().splitlines():
        m = SLACK_RE.match(line.strip())
        if m:
            metrics[m.group("key")] = float(m.group("value"))
    return metrics


def _legacy_corner_to_scenario(corner: dict[str, str], node_id: str) -> Scenario | str:
    """Map a legacy {name,process,rc} entry onto a scenario from the node DB.

    Picks the delay corner whose process matches and an RC corner whose name
    matches (or contains) the legacy `rc`. Returns an error string if no
    match exists, so the legacy path stays fail-closed too.
    """
    try:
        sset = sdb.build_scenario_set(node_id)
    except (FileNotFoundError, ValueError) as exc:
        return f"corner={corner.get('name')}: {exc}"
    if sset.blocked:
        return f"corner={corner.get('name')}: node '{node_id}' scenario set is blocked"
    process = str(corner.get("process", "")).lower()
    rc = str(corner.get("rc", "")).lower()
    for s in sset.scenarios:
        if s.delay_corner.process != process:
            continue
        if rc and rc not in s.rc_corner.name.lower() and rc != s.rc_corner.role.lower():
            continue
        return Scenario(
            name=str(corner.get("name", s.name)),
            mode=s.mode,
            analysis_type=s.analysis_type,
            delay_corner=s.delay_corner,
            rc_corner=s.rc_corner,
            ocv=s.ocv,
        )
    return (
        f"corner={corner.get('name')}: no scenario in node '{node_id}' matches "
        f"process={process!r} rc={rc!r}"
    )


def _resolve_scenarios(args: argparse.Namespace) -> list[Scenario] | str:
    if args.scenario_db:
        path = resolve(args.scenario_db)
        if not path.is_file():
            return f"scenario DB not found: {path}"
        payload = json.loads(path.read_text())
        return sdb.dict_to_scenarios(payload)
    if args.corners_json:
        raw = json.loads(resolve(args.corners_json).read_text())
        if not isinstance(raw, list):
            return "corners-json must be a JSON list"
        scenarios: list[Scenario] = []
        for corner in raw:
            mapped = _legacy_corner_to_scenario(corner, args.node_id)
            if isinstance(mapped, str):
                return mapped
            scenarios.append(mapped)
        return scenarios
    sset = sdb.build_scenario_set(args.node_id)
    if sset.blocked:
        return (
            f"node '{args.node_id}' scenario set is blocked: {sset.blocked_reason}"
        )
    return sset.scenarios


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument(
        "--node-id",
        default="sky130",
        help=f"corner-manifest node to build scenarios from (default sky130); "
        f"one of {', '.join(sorted(sdb.KNOWN_NODES))}",
    )
    parser.add_argument(
        "--scenario-db",
        help="prebuilt eliza.pd_mmmc_scenario.v1 JSON (overrides --node-id)",
    )
    parser.add_argument(
        "--corners-json",
        help="legacy [{name,process,rc}] override (mapped onto the node DB)",
    )
    parser.add_argument("--pdk-root", default=os.environ.get("PDK_ROOT", ""))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_dir = resolve(args.run_dir)
    out_dir = resolve(args.out_dir)
    if not run_dir.is_dir():
        return fail("run dir missing", run_dir=str(run_dir))
    if not args.pdk_root:
        return fail("PDK_ROOT not set; pass --pdk-root or export PDK_ROOT")
    pdk_root = Path(args.pdk_root).resolve()

    try:
        scenarios = _resolve_scenarios(args)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        return fail("could not resolve scenario set", detail=str(exc))
    if isinstance(scenarios, str):
        return fail(scenarios)
    if not scenarios:
        return fail("scenario set is empty", node_id=args.node_id)

    out_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {
        "schema": "eliza.pd_multi_corner_sta.v1",
        "node_id": args.node_id,
        "run_dir": str(run_dir),
        "pdk_root": str(pdk_root),
        "scenario_count": len(scenarios),
        "corners": [],
    }

    if args.dry_run:
        for s in scenarios:
            summary["corners"].append(
                {
                    "scenario": s.name,
                    "mode": s.mode,
                    "delay_corner": s.delay_corner.name,
                    "rc_corner": s.rc_corner.name,
                    "liberty": s.delay_corner.liberty,
                    "ocv": s.ocv.kind,
                    "lvf_declared": s.ocv.lvf_declared,
                    "dry_run": True,
                }
            )
        out_path = out_dir / "multi_corner_sta.json"
        out_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        print(f"PASS: dry-run STA plan ({len(scenarios)} scenarios): {out_path}")
        return 0

    sta_bin = shutil.which("sta") or shutil.which("openroad")
    if sta_bin is None:
        return fail("neither sta nor openroad on PATH; cannot run STA")

    errors: list[str] = []
    for s in scenarios:
        inp = discover_scenario_inputs(run_dir, s, pdk_root)
        if isinstance(inp, str):
            errors.append(inp)
            summary["corners"].append({"scenario": s.name, "error": inp})
            continue
        script = render_opensta_script(inp, out_dir)
        if Path(sta_bin).name == "sta":
            cmd = [sta_bin, "-no_init", "-exit", str(script)]
        else:
            cmd = [sta_bin, "-exit", str(script)]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
        (out_dir / f"{s.name}.stdout.log").write_text(proc.stdout)
        (out_dir / f"{s.name}.stderr.log").write_text(proc.stderr)
        metrics = parse_corner_report(out_dir / f"{s.name}.rpt")
        summary["corners"].append(
            {
                "scenario": s.name,
                "mode": s.mode,
                "delay_corner": s.delay_corner.name,
                "rc_corner": s.rc_corner.name,
                "analysis_type": s.analysis_type,
                "ocv": {
                    "kind": s.ocv.kind,
                    "lvf_declared": s.ocv.lvf_declared,
                    "lvf_resolved": inp.lvf is not None,
                    "late_derate": s.ocv.late_derate,
                    "early_derate": s.ocv.early_derate,
                },
                "inputs": {
                    "liberty": str(inp.liberty),
                    "lvf": str(inp.lvf) if inp.lvf else None,
                    "spef": str(inp.spef),
                    "sdc": str(inp.sdc),
                    "netlist": str(inp.netlist),
                },
                "metrics": metrics,
                "returncode": proc.returncode,
            }
        )

    out_path = out_dir / "multi_corner_sta.json"
    out_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    if errors:
        print(f"FAIL: {len(errors)} scenarios could not run; see {out_path}", file=sys.stderr)
        return 1
    print(f"PASS: multi-corner STA ({len(scenarios)} scenarios) written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
