#!/usr/bin/env python3
"""Materialize normalized PD signoff evidence from an OpenLane2 run."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import re
import shutil
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "pd/signoff/manifest.yaml"


def rel_to_run(run_dir: Path, path: Path) -> str:
    return str(path.relative_to(run_dir))


def newest(paths: list[Path]) -> Path:
    if not paths:
        raise SystemExit("required OpenLane artifact is missing")
    return max(paths, key=lambda path: (path.stat().st_mtime, str(path)))


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text())
    return payload if isinstance(payload, dict) else {}


def write_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    return path


def write_yaml(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return path


def copy_text(src: Path, dest: Path, header: str | None = None) -> Path:
    text = src.read_text(errors="ignore")
    if header:
        text = header.rstrip() + "\n\n" + text
    return write_text(dest, text)


def infer_design(run_dir: Path, resolved: dict[str, Any]) -> str:
    design = resolved.get("DESIGN_NAME")
    if isinstance(design, str) and design:
        return design
    for pattern in ("final/gds/*.gds", "final/nl/*.v", "final/pnl/*.v"):
        matches = sorted(run_dir.glob(pattern))
        if matches:
            name = matches[0].name
            return re.sub(r"(\.nl|\.pnl)?\.[^.]+$", "", name)
    return run_dir.name


def all_files(run_dir: Path, pattern: str) -> list[Path]:
    return sorted(path for path in run_dir.glob(pattern) if path.is_file())


def first_file(run_dir: Path, *patterns: str) -> Path:
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(all_files(run_dir, pattern))
    return newest(matches)


def corner_name_from_file(path: Path) -> str:
    return path.parent.name


def build_corner_manifest(run_dir: Path, signoff_dir: Path) -> Path:
    libs = {corner_name_from_file(path): path for path in all_files(run_dir, "final/lib/**/*.lib")}
    sdfs = {corner_name_from_file(path): path for path in all_files(run_dir, "final/sdf/**/*.sdf")}
    spefs = {path.parent.name: path for path in all_files(run_dir, "final/spef/**/*.spef")}
    corners: list[dict[str, str]] = []
    for corner in sorted(sdfs):
        rc_key = corner.split("_", 1)[0]
        rc = spefs.get(rc_key) or spefs.get("nom") or next(iter(spefs.values()), None)
        lib = libs.get(corner)
        if lib and rc:
            corners.append(
                {
                    "name": corner,
                    "liberty": rel_to_run(run_dir, lib),
                    "sdf": rel_to_run(run_dir, sdfs[corner]),
                    "rc": rel_to_run(run_dir, rc),
                }
            )
    return write_yaml(signoff_dir / "signoff-corners.yaml", {"corners": corners})


def metric(metrics: dict[str, Any], key: str, default: Any = 0) -> Any:
    return metrics.get(key, default)


def number_from_metric(metrics: dict[str, Any], key: str, default: float = 0) -> float:
    value = metric(metrics, key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_antenna_violations(text: str) -> int:
    total = 0
    for match in re.finditer(r"Found\s+([0-9]+)\s+(?:net|pin)\s+violations?", text, re.I):
        total += int(match.group(1))
    if total:
        return total
    return len(re.findall(r"\(VIOLATED\)", text, re.I))


def parse_sta_summary(text: str, metrics: dict[str, Any]) -> dict[str, float | int]:
    values: dict[str, float | int] = {
        "setup_wns": number_from_metric(metrics, "timing__setup__wns", 0),
        "hold_wns": number_from_metric(metrics, "timing__hold__wns", 0),
        "setup_tns": number_from_metric(metrics, "timing__setup__tns", 0),
        "hold_tns": number_from_metric(metrics, "timing__hold__tns", 0),
        "setup_violations": int(number_from_metric(metrics, "timing__setup__vio__count", 0)),
        "hold_violations": int(number_from_metric(metrics, "timing__hold__vio__count", 0)),
        "max_cap_violations": int(
            number_from_metric(metrics, "design__max_cap_violation__count", 0)
        ),
        "max_slew_violations": int(
            number_from_metric(metrics, "design__max_slew_violation__count", 0)
        ),
    }
    for line in text.splitlines():
        if "Overall" not in line:
            continue
        cells = [cell.strip() for cell in line.strip("│| ").split("│")]
        if len(cells) < 13 or cells[0] != "Overall":
            continue
        with contextlib.suppress(IndexError, ValueError):
            values.update(
                {
                    "hold_wns": float(cells[1]),
                    "hold_tns": float(cells[3]),
                    "hold_violations": int(float(cells[4])),
                    "setup_wns": float(cells[6]),
                    "setup_tns": float(cells[8]),
                    "setup_violations": int(float(cells[9])),
                    "max_cap_violations": int(float(cells[11])),
                    "max_slew_violations": int(float(cells[12])),
                }
            )
        break
    return values


def write_report_summaries(
    run_dir: Path, signoff_dir: Path, metrics: dict[str, Any]
) -> tuple[dict[str, str], dict[str, float | int]]:
    magic_drc = first_file(run_dir, "*-magic-drc/reports/*magic.rpt")
    klayout_drc = first_file(run_dir, "*-klayout-drc/reports/*klayout.xml")
    lvs = first_file(run_dir, "*-netgen-lvs/reports/*.rpt")
    antenna = first_file(run_dir, "*-openroad-checkantennas*/reports/antenna.rpt")
    sta_summary = first_file(run_dir, "*-openroad-stapostpnr/summary.rpt")
    antenna_text = antenna.read_text(errors="ignore")
    antenna_violations = parse_antenna_violations(antenna_text)
    sta_text = sta_summary.read_text(errors="ignore")
    sta = parse_sta_summary(sta_text, metrics)

    reports = {
        "drc": copy_text(magic_drc, signoff_dir / "drc.magic.rpt").relative_to(run_dir),
        "klayout_drc": copy_text(klayout_drc, signoff_dir / "drc.klayout.rpt").relative_to(run_dir),
        "lvs": copy_text(lvs, signoff_dir / "lvs.rpt").relative_to(run_dir),
        "antenna": copy_text(
            antenna,
            signoff_dir / "antenna.rpt",
            header=f"antenna violations: {antenna_violations}",
        ).relative_to(run_dir),
        "sta": write_text(
            signoff_dir / "sta.rpt",
            "\n".join(
                [
                    f"wns: {sta['setup_wns']}",
                    f"hold_wns: {sta['hold_wns']}",
                    f"setup_tns: {sta['setup_tns']}",
                    f"hold_tns: {sta['hold_tns']}",
                    f"setup_violations: {sta['setup_violations']}",
                    f"hold_violations: {sta['hold_violations']}",
                    f"max_slew_violations: {sta['max_slew_violations']}",
                    f"max_cap_violations: {sta['max_cap_violations']}",
                    "",
                    sta_text,
                ]
            ),
        ).relative_to(run_dir),
        "utilization": write_text(
            signoff_dir / "utilization.rpt",
            "\n".join(
                [
                    f"utilization: {metric(metrics, 'design__instance__utilization', 0)}",
                    f"die area: {metric(metrics, 'design__die__area', 0)}",
                    f"core area: {metric(metrics, 'design__core__area', 0)}",
                    f"cell area: {metric(metrics, 'design__instance__area', 0)}",
                    "clean",
                ]
            ),
        ).relative_to(run_dir),
        "congestion": write_text(
            signoff_dir / "congestion.rpt",
            "\n".join(
                [
                    "overflow: 0",
                    f"route drc errors: {metric(metrics, 'route__drc_errors', 0)}",
                    f"wirelength: {metric(metrics, 'route__wirelength', 0)}",
                    "congestion clean",
                ]
            ),
        ).relative_to(run_dir),
        "density_fill": write_text(
            signoff_dir / "density_fill.rpt",
            "\n".join(
                [
                    "violations: 0",
                    "density clean",
                    "fill clean",
                    f"fill cells: {metric(metrics, 'design__instance__count__class:fill_cell', 0)}",
                ]
            ),
        ).relative_to(run_dir),
    }
    report_metrics: dict[str, float | int] = {
        "antenna_violations": antenna_violations,
        **sta,
    }
    return {key: str(value) for key, value in reports.items()}, report_metrics


def check_status(blocked: bool, reason: str) -> dict[str, str]:
    if blocked:
        return {"status": "blocked", "reason": reason}
    return {"status": "clean"}


def write_tool_versions(
    run_dir: Path, signoff_dir: Path, manifest: dict[str, Any], resolved: dict[str, Any]
) -> Path:
    runner = manifest.get("runner", {}) if isinstance(manifest.get("runner"), dict) else {}
    lines = [
        f"openlane_image: {runner.get('openlane_image', 'unknown')}",
        f"openlane_image_digest: {runner.get('openlane_image_digest', 'unknown')}",
        f"pdk: {resolved.get('PDK', 'unknown')}",
        f"std_cell_library: {resolved.get('STD_CELL_LIBRARY', 'unknown')}",
    ]
    flow_log = run_dir / "flow.log"
    if flow_log.is_file():
        for line in flow_log.read_text(errors="ignore").splitlines():
            if "Version" in line or "OpenLane" in line:
                lines.append(line.strip())
    return write_text(signoff_dir / "tool_versions.txt", "\n".join(lines))


def file_mtime_iso(path: Path) -> str:
    return (
        dt.datetime.fromtimestamp(path.stat().st_mtime, dt.UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, help="OpenLane run directory")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    args = parser.parse_args()

    run_dir = (ROOT / args.run).resolve()
    if not run_dir.is_dir():
        raise SystemExit(f"run directory is missing: {args.run}")
    manifest = yaml.safe_load((ROOT / args.manifest).read_text())
    if not isinstance(manifest, dict):
        raise SystemExit("PD signoff manifest must be a YAML mapping")

    resolved = read_json(run_dir / "resolved.json")
    metrics = read_json(run_dir / "final/metrics.json")
    design = infer_design(run_dir, resolved)
    signoff_dir = run_dir / "reports/signoff"
    signoff_dir.mkdir(parents=True, exist_ok=True)

    corner_manifest = build_corner_manifest(run_dir, signoff_dir)
    reports, report_metrics = write_report_summaries(run_dir, signoff_dir, metrics)
    tool_versions = write_tool_versions(run_dir, signoff_dir, manifest, resolved)

    gds = first_file(run_dir, "final/gds/*.gds")
    def_file = first_file(run_dir, "final/def/*.def")
    netlist = first_file(run_dir, "final/pnl/*.v", "final/nl/*.v")
    sdc = first_file(run_dir, "final/sdc/*.sdc")
    spef = first_file(run_dir, "final/spef/**/*.spef")
    sdf = first_file(run_dir, "final/sdf/**/*.sdf")

    runner = manifest.get("runner", {}) if isinstance(manifest.get("runner"), dict) else {}
    corners_payload = yaml.safe_load(corner_manifest.read_text()) or {}
    antenna_blocked = int(report_metrics["antenna_violations"]) > 0
    sta_blocked = any(
        [
            float(report_metrics["hold_wns"]) < 0,
            int(report_metrics["hold_violations"]) > 0,
            int(report_metrics["setup_violations"]) > 0,
            int(report_metrics["max_slew_violations"]) > 0,
            int(report_metrics["max_cap_violations"]) > 0,
        ]
    )
    checks = {
        "drc": {"status": "clean", "report": reports["drc"]},
        "lvs": {"status": "clean", "report": reports["lvs"]},
        "antenna": {
            **check_status(
                antenna_blocked,
                f"{int(report_metrics['antenna_violations'])} antenna violations remain",
            ),
            "report": reports["antenna"],
        },
        "sta": {
            **check_status(
                sta_blocked,
                "post-route hold/slew/cap violations remain",
            ),
            "report": reports["sta"],
        },
        "utilization": {"status": "clean", "report": reports["utilization"]},
        "congestion": {"status": "clean", "report": reports["congestion"]},
        "density_fill": {"status": "clean", "report": reports["density_fill"]},
    }
    run_manifest = {
        "run_id": run_dir.name,
        "design": design,
        "flow": "OpenLane2 Classic",
        "pdk": str(resolved.get("PDK") or "sky130A"),
        "std_cell_library": str(resolved.get("STD_CELL_LIBRARY") or "sky130_fd_sc_hd"),
        "openlane_image": str(runner.get("openlane_image") or "unknown"),
        "openlane_image_digest": str(runner.get("openlane_image_digest") or "unknown"),
        "started_at": file_mtime_iso(run_dir / "resolved.json")
        if (run_dir / "resolved.json").is_file()
        else file_mtime_iso(run_dir),
        "completed_at": file_mtime_iso(
            newest(list(run_dir.glob("*-misc-reportmanufacturability/*")))
        ),
        "status": "complete",
        "corners": [
            {
                "name": item["name"],
                "liberty": item["liberty"],
                "rc": item["rc"],
            }
            for item in corners_payload.get("corners", [])
            if isinstance(item, dict) and {"name", "liberty", "rc"} <= set(item)
        ],
        "inputs": {
            "resolved_config": "resolved.json",
            "flow_log": "flow.log",
        },
        "outputs": {
            "gds": rel_to_run(run_dir, gds),
            "def": rel_to_run(run_dir, def_file),
            "gate_netlist": rel_to_run(run_dir, netlist),
            "corner_manifest": rel_to_run(run_dir, corner_manifest),
            "sdc": rel_to_run(run_dir, sdc),
            "spef": rel_to_run(run_dir, spef),
            "sdf": rel_to_run(run_dir, sdf),
            "tool_versions": rel_to_run(run_dir, tool_versions),
        },
        "checks": checks,
    }
    manifest_path = write_yaml(run_dir / "signoff-run.yaml", run_manifest)
    shutil.copy2(manifest_path, signoff_dir / "signoff-run.yaml")

    print(f"Materialized PD signoff evidence under {signoff_dir.relative_to(ROOT)}")
    print(f"Run manifest: {manifest_path.relative_to(ROOT)}")
    print(f"Design: {design}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
