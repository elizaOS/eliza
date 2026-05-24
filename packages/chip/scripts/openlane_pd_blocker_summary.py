#!/usr/bin/env python3
"""Summarize the current OpenLane physical-signoff blocker handoff."""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
RUN_ROOT = ROOT / "pd/openlane/runs"
DEFAULT_REPORT = ROOT / "build/reports/openlane_pd_blocker_summary.json"
SCHEMA = "eliza.openlane_pd_blocker_summary.v1"
PD_SIGNOFF_MANIFEST = ROOT / "pd/signoff/manifest.yaml"
VOLARE_SNAPSHOT_RE = re.compile(r"/volare/sky130/versions/([^/]+)/")


METRIC_KEYS = (
    "magic__drc_error__count",
    "klayout__drc_error__count",
    "design__lvs_error__count",
    "timing__setup__wns",
    "timing__setup_vio__count",
    "timing__hold__wns",
    "timing__hold_vio__count",
    "design__max_slew_violation__count",
    "design__max_cap_violation__count",
    "design__max_fanout_violation__count",
    "route__antenna_violation__count",
)


def rel(path: Path) -> str:
    if not path.is_absolute():
        path = normalize_path(path)
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        try:
            return path.relative_to(REPO_ROOT).as_posix()
        except ValueError:
            return path.as_posix()


def normalize_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    if path.exists():
        return path.resolve()
    root_relative = ROOT / path
    if root_relative.exists():
        return root_relative.resolve()
    repo_relative = REPO_ROOT / path
    if repo_relative.exists():
        return repo_relative.resolve()
    return root_relative


def first_existing(run_dir: Path, patterns: tuple[str, ...]) -> Path | None:
    for pattern in patterns:
        matches = sorted(run_dir.glob(pattern))
        if matches:
            return matches[-1]
    return None


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}
    return payload if isinstance(payload, dict) else {}


def manufacturability_state(run_dir: Path) -> Path | None:
    return first_existing(run_dir, ("*-misc-reportmanufacturability/state_out.json",))


def manufacturability_report(run_dir: Path) -> Path | None:
    return first_existing(run_dir, ("*-misc-reportmanufacturability/manufacturability.rpt",))


def magic_drc_report(run_dir: Path) -> Path:
    return (
        first_existing(run_dir, ("*-magic-drc/reports/drc_violations.magic.rpt",))
        or run_dir / "63-magic-drc/reports/drc_violations.magic.rpt"
    )


def final_antenna_report(run_dir: Path) -> Path:
    return (
        first_existing(run_dir, ("*-openroad-checkantennas-1/reports/antenna_summary.rpt",))
        or first_existing(run_dir, ("*-openroad-checkantennas/reports/antenna_summary.rpt",))
        or run_dir / "46-openroad-checkantennas-1/reports/antenna_summary.rpt"
    )


def wirelength_report(run_dir: Path) -> Path:
    return (
        first_existing(run_dir, ("*-odb-reportwirelength/wire_lengths.csv",))
        or run_dir / "50-odb-reportwirelength/wire_lengths.csv"
    )


def complete_run_dirs(run_root: Path) -> list[Path]:
    runs = []
    for run in sorted(run_root.glob("RUN_*")):
        if not run.is_dir():
            continue
        if manufacturability_state(run) and manufacturability_report(run):
            runs.append(run)
    return runs


def latest_run_dir(run_root: Path) -> Path | None:
    runs = [run for run in run_root.glob("RUN_*") if run.is_dir()]
    if not runs:
        return None
    return max(runs, key=lambda path: path.stat().st_mtime)


def latest_stage_name(run_dir: Path) -> str | None:
    stages = []
    for child in run_dir.iterdir() if run_dir.is_dir() else []:
        if not child.is_dir():
            continue
        match = re.match(r"^(\d+)-", child.name)
        if match:
            stages.append((int(match.group(1)), child.name))
    if not stages:
        return None
    return max(stages)[1]


def numbered_step_dirs(run_dir: Path) -> list[Path]:
    return sorted(
        (
            child
            for child in run_dir.iterdir()
            if child.is_dir() and re.match(r"^(\d+)-", child.name)
        ),
        key=lambda path: int(path.name.split("-", 1)[0]),
    )


def last_completed_stage_name(run_dir: Path) -> str | None:
    completed = [
        step for step in numbered_step_dirs(run_dir) if (step / "state_out.json").is_file()
    ]
    if not completed:
        return None
    return completed[-1].name


def sample_matching_lines(path: Path, patterns: tuple[str, ...], limit: int = 20) -> list[str]:
    if not path.is_file():
        return []
    regexes = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    samples: list[str] = []
    with path.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            if any(regex.search(text) for regex in regexes):
                samples.append(text[:320])
                if len(samples) >= limit:
                    break
    return samples


def iter_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        strings: list[str] = []
        for item in value:
            strings.extend(iter_strings(item))
        return strings
    if isinstance(value, dict):
        strings = []
        for item in value.values():
            strings.extend(iter_strings(item))
        return strings
    return []


def volare_snapshots(value: Any) -> list[str]:
    snapshots = set()
    for text in iter_strings(value):
        for match in VOLARE_SNAPSHOT_RE.finditer(text):
            snapshots.add(match.group(1))
    return sorted(snapshots)


def pdk_snapshot_diagnostic(stage_dir: Path) -> dict[str, Any] | None:
    config_path = stage_dir / "config.json"
    if not config_path.is_file():
        return None
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {
            "status": "config_unreadable",
            "config": rel(config_path),
            "next_pd_action": "Inspect the terminal stage config before rerunning OpenLane.",
        }

    technology_fields = {
        key: config.get(key)
        for key in ("MAGICRC", "MAGIC_TECH", "MAGIC_PDK_SETUP", "CELL_GDS", "TECH_LEFS")
        if key in config
    }
    macro_fields = config.get("MACROS", {})
    macro_gds = (
        {
            name: macro.get("gds", [])
            for name, macro in macro_fields.items()
            if isinstance(macro, dict)
        }
        if isinstance(macro_fields, dict)
        else {}
    )
    macro_lef = (
        {
            name: macro.get("lef", [])
            for name, macro in macro_fields.items()
            if isinstance(macro, dict)
        }
        if isinstance(macro_fields, dict)
        else {}
    )
    macro_lib = (
        {
            name: macro.get("lib", {})
            for name, macro in macro_fields.items()
            if isinstance(macro, dict)
        }
        if isinstance(macro_fields, dict)
        else {}
    )

    technology_snapshots = volare_snapshots(technology_fields)
    macro_gds_snapshots = volare_snapshots(macro_gds)
    macro_lef_snapshots = volare_snapshots(macro_lef)
    macro_lib_snapshots = volare_snapshots(macro_lib)
    macro_snapshots = sorted(
        set(macro_gds_snapshots) | set(macro_lef_snapshots) | set(macro_lib_snapshots)
    )
    mixed_macro_gds = bool(
        technology_snapshots
        and macro_gds_snapshots
        and not set(macro_gds_snapshots).issubset(set(technology_snapshots))
    )
    mixed_any_macro = bool(
        technology_snapshots
        and macro_snapshots
        and not set(macro_snapshots).issubset(set(technology_snapshots))
    )
    status = (
        "mixed_macro_gds_pdk_snapshot"
        if mixed_macro_gds
        else "mixed_macro_pdk_snapshot"
        if mixed_any_macro
        else "consistent_or_unresolved"
    )

    return {
        "status": status,
        "config": rel(config_path),
        "technology_snapshots": technology_snapshots,
        "macro_gds_snapshots": macro_gds_snapshots,
        "macro_lef_snapshots": macro_lef_snapshots,
        "macro_lib_snapshots": macro_lib_snapshots,
        "macro_gds_paths": {
            name: [path[:240] for path in iter_strings(paths)] for name, paths in macro_gds.items()
        },
        "claim_boundary": (
            "Snapshot consistency is a diagnostic clue only. It does not prove "
            "layout correctness or signoff readiness."
        ),
        "next_pd_action": (
            "Align SRAM macro GDS/LEF/LIB references with the active PDK snapshot "
            "using pdk_dir:: paths, or rerun with a PDK root matching the hard macro "
            "snapshot; then rerun a complete fail-closed OpenLane flow."
        ),
    }


def signoff_artifact_files_for_run(
    run_dir: Path,
    run_root: str,
    spec: dict[str, Any],
) -> list[Path]:
    files: list[Path] = []
    prefix = f"{run_root.rstrip('/')}/*/"
    for pattern in spec.get("globs", []):
        if not isinstance(pattern, str) or not pattern.startswith(prefix):
            continue
        files.extend(
            sorted(path for path in run_dir.glob(pattern[len(prefix) :]) if path.is_file())
        )
    min_bytes = spec.get("min_bytes")
    if isinstance(min_bytes, int):
        files = [path for path in files if path.stat().st_size >= min_bytes]
    return files


def release_run_manifest_files(files: list[Path]) -> list[Path]:
    eligible: list[Path] = []
    for path in files:
        payload = load_yaml_mapping(path)
        if payload.get("design") == "e1_chip_top" and payload.get("status") == "complete":
            eligible.append(path)
    return eligible


def signoff_artifact_presence_for_run(
    run_dir: Path,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    required = manifest.get("required_artifacts")
    if not isinstance(required, dict):
        return {
            "run": rel(run_dir),
            "required_count": 0,
            "present_count": 0,
            "missing_count": 0,
            "present": [],
            "missing": [],
            "sample_files": {},
        }

    try:
        run_root = run_dir.parent.relative_to(ROOT).as_posix()
    except ValueError:
        run_root = run_dir.parent.as_posix()
    present: list[str] = []
    missing: list[str] = []
    missing_details: list[dict[str, Any]] = []
    sample_files: dict[str, list[str]] = {}
    for name, spec in required.items():
        if not isinstance(spec, dict):
            missing.append(str(name))
            missing_details.append(
                {
                    "artifact": str(name),
                    "expected_globs": [],
                    "release_credit": False,
                }
            )
            continue
        files = signoff_artifact_files_for_run(run_dir, run_root, spec)
        if name == "run_manifest":
            files = release_run_manifest_files(files)
        if files:
            present.append(str(name))
            sample_files[str(name)] = [rel(path) for path in files[:3]]
        else:
            missing.append(str(name))
            missing_details.append(
                {
                    "artifact": str(name),
                    "expected_globs": [
                        pattern for pattern in spec.get("globs", []) if isinstance(pattern, str)
                    ],
                    "release_credit": False,
                }
            )

    return {
        "run": rel(run_dir),
        "required_count": len(required),
        "present_count": len(present),
        "missing_count": len(missing),
        "present": present,
        "missing": missing,
        "missing_artifact_classes": missing_details,
        "sample_files": sample_files,
        "next_commands": [
            "scripts/run_openlane.sh --release",
            "python3 scripts/check_pd_signoff.py",
        ],
        "release_credit": False,
    }


def signoff_artifact_handoff_summary(
    run_dir: Path,
    manifest_path: Path = PD_SIGNOFF_MANIFEST,
) -> dict[str, Any]:
    manifest = load_yaml_mapping(manifest_path)
    required = manifest.get("required_artifacts")
    if not isinstance(required, dict):
        return {
            "manifest": rel(manifest_path),
            "present": False,
            "status": "missing_or_invalid_manifest",
            "release_credit": False,
            "claim_boundary": (
                "Artifact handoff completeness could not be evaluated because the "
                "PD signoff manifest was missing or invalid."
            ),
        }

    selected = signoff_artifact_presence_for_run(run_dir, manifest)
    candidates = []
    for run_root in manifest.get("run_roots", []):
        if not isinstance(run_root, str):
            continue
        root_path = ROOT / run_root
        for candidate in sorted(root_path.glob("RUN_*")):
            if candidate.is_dir():
                candidates.append(signoff_artifact_presence_for_run(candidate, manifest))
    best = max(
        candidates,
        key=lambda item: (item["present_count"], item["run"]),
        default=selected,
    )
    closest_runs = sorted(
        candidates or [selected],
        key=lambda item: (-item["present_count"], item["missing_count"], item["run"]),
    )[:8]
    release_blocked_gates = []
    blocked_gates = manifest.get("blocked_gates")
    if isinstance(blocked_gates, dict):
        for name, gate in blocked_gates.items():
            if isinstance(gate, dict) and gate.get("blocked") is True:
                release_blocked_gates.append(
                    {
                        "gate": name,
                        "reason": gate.get("reason"),
                    }
                )

    return {
        "manifest": rel(manifest_path),
        "present": True,
        "status": "blocked",
        "selected_run": selected,
        "closest_artifact_run": best,
        "closest_artifact_runs": closest_runs,
        "blocked_release_gates": release_blocked_gates,
        "primary_action": (
            "Package a single e1_chip_top release run under the manifest globs with "
            "a complete signoff-run.yaml, final GDS/DEF/netlist/timing parasitics, "
            "clean DRC/LVS/antenna/STA/utilization/congestion/density reports, and "
            "tool-version evidence. Do not mix smoke-run artifacts or diagnostic "
            "segments into the release handoff."
        ),
        "acceptance_check": (
            "python3 scripts/check_pd_signoff.py must find one run with every "
            "required artifact class and no dirty unwaived signoff reports; this "
            "summary grants no release credit by itself."
        ),
        "release_credit": False,
        "claim_boundary": (
            "This is a manifest/glob completeness diagnostic over existing files "
            "only. It does not run OpenLane and does not prove signoff cleanliness."
        ),
    }


def antenna_repair_log_summary(log: Path) -> dict[str, Any]:
    iteration_re = re.compile(r"Repairing antennas, iteration (?P<iteration>\d+)\.")
    violation_re = re.compile(r"Found (?P<count>\d+) antenna violations\.")
    diode_re = re.compile(r"Inserted (?P<count>\d+) diodes\.")
    reroute_re = re.compile(r"rerouting (?P<count>\d+) nets\.")
    iterations: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    port_diode_skipped = False
    port_diodes_inserted: int | None = None
    heuristic_diode_step_skipped = False
    heuristic_diodes_inserted: int | None = None
    design_name: str | None = None
    if not log.is_file():
        return {
            "log": rel(log),
            "present": False,
            "iterations": [],
            "iteration_count": 0,
        }

    with log.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            text = line.strip()
            if design_name is None and text.startswith("Design name:"):
                design_name = text.split(":", 1)[1].strip()
            if "DIODE_ON_PORTS" in text and "set to 'none'" in text and "skipping" in text:
                port_diode_skipped = True
            if (
                "Gating variable for step" in text
                and "Odb.HeuristicDiodeInsertion" in text
                and "False" in text
            ):
                heuristic_diode_step_skipped = True
            if "Skipping step 'Heuristic Diode Insertion'" in text:
                heuristic_diode_step_skipped = True
            if port_diodes_inserted is None and "PortDiodePlacement" in text and "Running" in text:
                port_diodes_inserted = 0
            match = iteration_re.search(text)
            if match:
                current = {
                    "iteration": int(match.group("iteration")),
                    "log": rel(log),
                }
                iterations.append(current)
                continue
            match = violation_re.search(text)
            if match:
                if current is not None:
                    current["antenna_violations"] = int(match.group("count"))
                continue
            match = diode_re.search(text)
            if match:
                inserted = int(match.group("count"))
                if current is None:
                    if port_diodes_inserted == 0:
                        port_diodes_inserted = inserted
                    else:
                        heuristic_diodes_inserted = inserted
                    continue
                current["diodes_inserted"] = inserted
                continue
            match = reroute_re.search(text)
            if match and current is not None:
                current["rerouted_nets"] = int(match.group("count"))

    counts = [
        row["antenna_violations"]
        for row in iterations
        if isinstance(row.get("antenna_violations"), int)
    ]
    return {
        "log": rel(log),
        "present": True,
        "design_name": design_name,
        "port_diode_step_skipped": port_diode_skipped,
        "port_diodes_inserted": port_diodes_inserted,
        "heuristic_diode_step_skipped": heuristic_diode_step_skipped,
        "heuristic_diodes_inserted": heuristic_diodes_inserted,
        "iterations": iterations,
        "iteration_count": len(iterations),
        "best_remaining_antenna_violations": min(counts) if counts else None,
        "last_remaining_antenna_violations": counts[-1] if counts else None,
        "total_inserted_diodes_logged": sum(
            int(row.get("diodes_inserted") or 0) for row in iterations
        ),
    }


def antenna_state_metrics(stage_dir: Path) -> dict[str, Any]:
    state_path = stage_dir / "state_in.json"
    if not state_path.is_file():
        return {
            "state": rel(state_path),
            "present": False,
        }
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {
            "state": rel(state_path),
            "present": True,
            "status": "unreadable",
        }
    metrics = state.get("metrics", state)
    if not isinstance(metrics, dict):
        metrics = {}
    keys = (
        "antenna__violating__nets",
        "antenna__violating__pins",
        "route__antenna_violation__count",
        "design__instance__count__class:antenna_cell",
        "design__max_slew_violation__count",
        "design__max_cap_violation__count",
    )
    return {
        "state": rel(state_path),
        "present": True,
        **{key: metrics.get(key) for key in keys if key in metrics},
    }


def related_antenna_attempts(
    current_log: Path,
    current_design_name: str | None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    candidates = sorted(
        {
            *ROOT.glob("build/reports/openlane-release*.log"),
            *RUN_ROOT.glob("RUN_*/**/diodeinsertion.log"),
        },
        key=lambda path: path.stat().st_mtime if path.is_file() else 0,
        reverse=True,
    )
    attempts = []
    for log in candidates:
        if not log.is_file() or log.resolve() == current_log.resolve():
            continue
        summary = antenna_repair_log_summary(log)
        if not summary["iteration_count"]:
            continue
        if current_design_name and summary.get("design_name") != current_design_name:
            continue
        attempts.append(
            {
                "log": summary["log"],
                "design_name": summary.get("design_name"),
                "port_diode_step_skipped": summary.get("port_diode_step_skipped"),
                "port_diodes_inserted": summary.get("port_diodes_inserted"),
                "heuristic_diodes_inserted": summary.get("heuristic_diodes_inserted"),
                "iteration_count": summary["iteration_count"],
                "best_remaining_antenna_violations": summary.get(
                    "best_remaining_antenna_violations"
                ),
                "last_remaining_antenna_violations": summary.get(
                    "last_remaining_antenna_violations"
                ),
            }
        )
        if len(attempts) >= limit:
            break
    return attempts


def unknown_layer_summary(paths: list[Path]) -> dict[str, Any]:
    cell_re = re.compile(
        r'cell "(?P<cell>[^"]+)".*Unknown layer/datatype.*layer=(?P<layer>\d+) type=(?P<datatype>\d+)'
    )
    cell_counts: dict[str, int] = {}
    layer_counts: dict[str, int] = {}
    samples: list[str] = []
    total = 0
    for path in paths:
        if not path.is_file():
            continue
        with path.open(encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                match = cell_re.search(line)
                if not match:
                    continue
                total += 1
                cell = match.group("cell")
                layer = f"{match.group('layer')}/{match.group('datatype')}"
                cell_counts[cell] = cell_counts.get(cell, 0) + 1
                layer_counts[layer] = layer_counts.get(layer, 0) + 1
                if len(samples) < 8:
                    samples.append(line.strip()[:320])
    return {
        "count": total,
        "top_cells": [
            {"cell": cell, "count": count}
            for cell, count in sorted(cell_counts.items(), key=lambda item: (-item[1], item[0]))[:8]
        ],
        "layer_datatypes": [
            {"layer_datatype": layer, "count": count}
            for layer, count in sorted(layer_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "samples": samples,
    }


def antenna_repair_diagnostic(stage_dir: Path) -> dict[str, Any] | None:
    run_dir = stage_dir.parent
    transcript_candidates = [
        ROOT / "build/reports" / f"openlane-release-{run_dir.name}.log",
    ]
    stage_logs = sorted(stage_dir.rglob("*.log"))
    transcript_logs = [path for path in transcript_candidates if path.is_file()]
    logs = stage_logs + transcript_logs
    if not logs:
        return None
    config_path = stage_dir / "config.json"
    config_values: dict[str, Any] = {}
    config_paths = [config_path]
    diode_on_ports_stages = sorted(run_dir.glob("*-odb-diodesonports/config.json"))
    config_paths.extend(path for path in diode_on_ports_stages if path not in config_paths)
    for config_path in config_paths:
        if not config_path.is_file():
            continue
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            config = {}
        for key in (
            "DIODE_ON_PORTS",
            "GRT_ANTENNA_ITERS",
            "GRT_ANTENNA_MARGIN",
            "RUN_HEURISTIC_DIODE_INSERTION",
            "RUN_ANTENNA_REPAIR",
            "RT_MAX_LAYER",
            "GPL_CELL_PADDING",
            "DPL_CELL_PADDING",
        ):
            if key in config and key not in config_values:
                config_values[key] = config[key]
    parse_logs = transcript_logs or stage_logs
    summaries_by_log = [(log, antenna_repair_log_summary(log)) for log in parse_logs]
    primary = next(
        ((log, summary) for log, summary in summaries_by_log if summary["iteration_count"]),
        None,
    )
    if primary is None:
        return None
    primary_log, primary_summary = primary
    iterations = primary_summary["iterations"]
    port_diode_skipped = bool(primary_summary.get("port_diode_step_skipped"))
    port_diodes_inserted = primary_summary.get("port_diodes_inserted")
    heuristic_diode_skipped = bool(primary_summary.get("heuristic_diode_step_skipped"))
    if heuristic_diode_skipped and "RUN_HEURISTIC_DIODE_INSERTION" not in config_values:
        config_values["RUN_HEURISTIC_DIODE_INSERTION"] = False
    antenna_margin = config_values.get("GRT_ANTENNA_MARGIN")
    bounded_segment_completed = (stage_dir / "state_out.json").is_file()
    timed_out = any(
        "status=timeout" in path.read_text(encoding="utf-8", errors="ignore")
        for path in transcript_logs
    )

    counts = [
        row["antenna_violations"]
        for row in iterations
        if isinstance(row.get("antenna_violations"), int)
    ]
    last_count = counts[-1] if counts else None
    best_count = min(counts) if counts else None
    plateau = False
    if len(counts) >= 6:
        recent = counts[-6:]
        plateau = max(recent) - min(recent) <= 10 and recent[-1] >= min(recent)
    status = (
        "antenna_repair_plateau"
        if plateau
        else "antenna_repair_in_progress"
        if last_count
        else "antenna_repair_log_present"
    )
    prior_attempts = related_antenna_attempts(
        primary_log,
        primary_summary.get("design_name"),
    )
    best_prior = min(
        (
            attempt["best_remaining_antenna_violations"]
            for attempt in prior_attempts
            if isinstance(attempt.get("best_remaining_antenna_violations"), int)
        ),
        default=None,
    )
    delta_vs_prior = (
        best_count - best_prior
        if isinstance(best_count, int) and isinstance(best_prior, int)
        else None
    )
    post_checkantennas = post_repair_checkantennas_summary(stage_dir)
    residual_ranking = segmented_antenna_experiment_ranking(
        stage_dir,
        primary_summary,
        config_values,
        post_checkantennas,
    )
    if port_diode_skipped:
        next_pd_action = (
            "Rerun with input-port diode protection enabled (`DIODE_ON_PORTS: in`) "
            "and only the canonical `GRT_ANTENNA_ITERS` key, then compare the "
            "OpenROAD.RepairAntennas best/last violation counts against this "
            "plateau before attempting a full signoff-length rerun."
        )
        next_bounded_experiment = {
            "claim_boundary": (
                "Use a temporary config copy only; this is a diagnostic segment, "
                "not release signoff evidence."
            ),
            "objective": (
                "Exercise input-port diode placement and compare the bounded "
                "RepairAntennas plateau with this no-port-diode attempt."
            ),
            "temporary_config_overrides": {
                "DIODE_ON_PORTS": "in",
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
                "GRT_ANTENNA_MARGIN": config_values.get("GRT_ANTENNA_MARGIN", 80),
            },
            "success_metric": (
                "RepairAntennas best/last remaining violations must materially "
                "improve before attempting full signoff."
            ),
        }
    elif (
        heuristic_diode_skipped
        and bounded_segment_completed
        and isinstance(antenna_margin, int)
        and antenna_margin <= 40
        and (best_prior is None or (isinstance(delta_vs_prior, int) and delta_vs_prior <= 0))
    ):
        improvement_text = (
            f" from {best_prior} to {best_count}" if best_prior is not None else f" to {best_count}"
        )
        next_margin = max(10, antenna_margin - 10)
        next_pd_action = (
            f"The no-heuristic margin-{antenna_margin} bounded segment completed and improved "
            f"the repair-loop best{improvement_text}, but "
            f"{last_count} antenna violations remain after the requested "
            "RepairAntennas endpoint and the bounded CheckAntennas report still "
            "has residual net/pin violations. Treat this as diagnostic evidence: "
            "inspect the residual CheckAntennas nets/layers, then tune routing, "
            "placement congestion, or diode strategy before attempting a complete "
            "signoff run."
        )
        next_bounded_experiment = {
            "claim_boundary": (
                "Use runtime overrides or a temporary config copy only; this is "
                "a diagnostic segment, not release signoff evidence."
            ),
            "objective": (
                "Drive the remaining post-repair antenna violations below the "
                f"margin-{antenna_margin} plateau without increasing diode churn "
                "enough to destabilize routing."
            ),
            "temporary_config_overrides": {
                "RUN_HEURISTIC_DIODE_INSERTION": False,
                "DIODE_ON_PORTS": config_values.get("DIODE_ON_PORTS", "in"),
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
                "GRT_ANTENNA_MARGIN": next_margin,
            },
            "comparison_baseline": {
                "best_prior_remaining_antenna_violations": best_prior,
                "current_best_remaining_antenna_violations": best_count,
                "current_last_remaining_antenna_violations": last_count,
                "current_total_inserted_diodes_logged": primary_summary[
                    "total_inserted_diodes_logged"
                ],
                "bounded_segment_completed": True,
            },
            "success_metric": (
                "The next bounded segment must beat the current best/last "
                f"remaining antenna violations of {best_count}/{last_count}. "
                "It should also not worsen the bounded CheckAntennas residual "
                "net/pin counts enough to make the repair-loop improvement a "
                "false optimization. "
                "Release credit still requires a complete clean run through final "
                "antenna, DRC, LVS, STA, IR, density, and manufacturability "
                "signoff."
            ),
        }
    elif heuristic_diode_skipped and isinstance(delta_vs_prior, int) and delta_vs_prior < 0:
        completion_note = (
            "timed out"
            if timed_out
            else "did not complete the bounded endpoint"
            if not bounded_segment_completed
            else "completed the bounded endpoint"
        )
        next_pd_action = (
            "Disabling heuristic diode insertion improved the bounded antenna "
            f"repair best from {best_prior} to {best_count}, but the run still "
            f"plateaued and {completion_note} while inserting a large number of repair "
            "diodes. Keep `RUN_HEURISTIC_DIODE_INSERTION=false` and "
            "`DIODE_ON_PORTS=in`, then run a bounded margin-sensitivity segment "
            "from the same post-global-routing state with a lower "
            "`GRT_ANTENNA_MARGIN` before attempting full signoff."
        )
        next_bounded_experiment = {
            "claim_boundary": (
                "Use runtime overrides or a temporary config copy only; this is "
                "a diagnostic segment, not release signoff evidence."
            ),
            "objective": (
                "Check whether the no-heuristic improvement survives with less "
                "aggressive antenna over-repair and fewer inserted repair diodes."
            ),
            "temporary_config_overrides": {
                "RUN_HEURISTIC_DIODE_INSERTION": False,
                "DIODE_ON_PORTS": config_values.get("DIODE_ON_PORTS", "in"),
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
                "GRT_ANTENNA_MARGIN": 40,
            },
            "comparison_baseline": {
                "best_prior_remaining_antenna_violations": best_prior,
                "current_best_remaining_antenna_violations": best_count,
                "current_last_remaining_antenna_violations": last_count,
                "current_total_inserted_diodes_logged": primary_summary[
                    "total_inserted_diodes_logged"
                ],
            },
            "success_metric": (
                "Best/last remaining antenna violations should stay near or below "
                f"{best_count if best_count is not None else 'the current best'} "
                "while materially reducing repair-diode churn and completing the "
                "bounded segment inside the timeout. Release credit still requires "
                "a complete clean run through final antenna, DRC, LVS, STA, IR, "
                "density, and manufacturability signoff."
            ),
        }
    elif isinstance(delta_vs_prior, int) and delta_vs_prior >= 0:
        next_pd_action = (
            "Input-port diode protection has now been exercised and did not beat "
            "the previous bounded repair plateau. Do not spend another full run "
            "on that setting alone; run the next bounded antenna experiment from "
            "the same post-global-routing state with diode over-insertion reduced "
            "(for example disable heuristic diode insertion or lower "
            "`GRT_ANTENNA_MARGIN`), then compare best/last violation counts before "
            "attempting signoff."
        )
        next_bounded_experiment = {
            "claim_boundary": (
                "Use a temporary config copy only; this is a diagnostic segment, "
                "not release signoff evidence."
            ),
            "objective": (
                "Determine whether heuristic diode over-insertion is driving the "
                "repair plateau after input-port diodes failed to improve it."
            ),
            "temporary_config_overrides": {
                "RUN_HEURISTIC_DIODE_INSERTION": False,
                "DIODE_ON_PORTS": config_values.get("DIODE_ON_PORTS", "in"),
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
                "GRT_ANTENNA_MARGIN": config_values.get("GRT_ANTENNA_MARGIN", 80),
            },
            "success_metric": (
                "RepairAntennas best/last remaining violations must materially "
                "improve on the comparable full-chip prior best of "
                f"{best_prior if best_prior is not None else 'unknown'} and "
                "must still proceed to final antenna, DRC, LVS, STA, IR, density, "
                "and manufacturability signoff before release credit."
            ),
        }
    else:
        next_pd_action = (
            "Input-port diode protection has now been exercised. Because antenna "
            "repair still plateaus, tune the remaining antenna strategy directly "
            "(routing constraints/layers, diode insertion margin/location, or "
            "placement congestion) and rerun this bounded segment before a full "
            "signoff-length flow."
        )
        next_bounded_experiment = {
            "claim_boundary": (
                "Use a temporary config copy only; this is a diagnostic segment, "
                "not release signoff evidence."
            ),
            "objective": ("Tune antenna strategy after the current repair attempt plateaued."),
            "temporary_config_overrides": {
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
                "GRT_ANTENNA_MARGIN": config_values.get("GRT_ANTENNA_MARGIN", 80),
            },
            "success_metric": (
                "RepairAntennas best/last remaining violations must materially "
                "improve before attempting full signoff."
            ),
        }
    if residual_ranking.get("repair_loop_improvement_is_potentially_false"):
        comparison = residual_ranking.get("comparison_baseline") or {}
        prior_label = comparison.get("prior_run") or "the prior bounded segment"
        residual_strategy = post_checkantennas.get("residual_met1_met3_strategy") or {}
        next_pd_action += (
            " The residual CheckAntennas comparison flags this as a possible false "
            f"repair-loop improvement versus {prior_label}: the RepairAntennas "
            "counter improved, but residual CheckAntennas net/row counts did not "
            "both improve. Before lowering margin again, inspect the ranked "
            "residual layers and repeated nets, then try a targeted routing, "
            "placement-congestion, or diode-location change."
        )
        if residual_strategy.get("present"):
            next_pd_action += " " + str(residual_strategy.get("next_pd_action"))
            next_bounded_experiment["objective"] = (
                "Classify and attack the residual met1/met3 antenna rows by "
                "net family and layer before any further margin sweep."
            )
            next_bounded_experiment["temporary_config_overrides"] = {
                "RUN_HEURISTIC_DIODE_INSERTION": False,
                "DIODE_ON_PORTS": config_values.get("DIODE_ON_PORTS", "in"),
                "GRT_ANTENNA_ITERS": config_values.get("GRT_ANTENNA_ITERS", 40),
            }
            next_bounded_experiment["diagnostic_targets"] = {
                "primary_strategy": residual_strategy.get("primary_strategy"),
                "layer_rows": residual_strategy.get("layer_rows"),
                "net_family_rows": residual_strategy.get("net_family_rows"),
                "top_targets_by_ratio": residual_strategy.get("top_targets_by_ratio"),
                "met3_synthesized_routing_targets": residual_strategy.get(
                    "met3_synthesized_routing_targets"
                ),
            }
            next_bounded_experiment["diagnostic_constraint"] = (
                "Do not lower `GRT_ANTENNA_MARGIN` again until the met1/met3 "
                "residual family split explains whether routing congestion or "
                "targeted diode/source-net changes are the limiting factor."
            )
            next_bounded_experiment["claim_boundary"] = (
                "Use runtime overrides or a temporary config copy only; this is "
                "a targeted diagnostic segment, not release signoff evidence."
            )
        next_bounded_experiment["comparison_baseline"] = {
            **next_bounded_experiment.get("comparison_baseline", {}),
            "residual_checkantennas_baseline": comparison,
        }
        next_bounded_experiment["success_metric"] += (
            " The next experiment must reduce both the RepairAntennas loop count "
            "and bounded CheckAntennas residual net/row counts; otherwise treat "
            "the lower repair-loop count as a false optimization."
        )
    return {
        "status": status,
        "logs": [rel(path) for path in logs],
        "config_values": config_values,
        "design_name": primary_summary.get("design_name"),
        "port_diode_step_skipped": port_diode_skipped,
        "port_diodes_inserted": port_diodes_inserted,
        "heuristic_diode_step_skipped": heuristic_diode_skipped,
        "heuristic_diodes_inserted": primary_summary.get("heuristic_diodes_inserted"),
        "pre_repair_state_metrics": antenna_state_metrics(stage_dir),
        "post_repair_checkantennas": post_checkantennas,
        "segmented_antenna_experiment_ranking": residual_ranking,
        "related_prior_attempts": prior_attempts,
        "best_prior_remaining_antenna_violations": best_prior,
        "delta_vs_best_prior_remaining_antenna_violations": delta_vs_prior,
        "next_bounded_experiment": next_bounded_experiment,
        "iterations": iterations[-12:],
        "iteration_count": len(iterations),
        "bounded_segment_completed": bounded_segment_completed,
        "timed_out": timed_out,
        "best_remaining_antenna_violations": best_count,
        "last_remaining_antenna_violations": last_count,
        "total_inserted_diodes_logged": primary_summary["total_inserted_diodes_logged"],
        "claim_boundary": (
            "Antenna repair logs are diagnostic only. They do not prove antenna "
            "closure unless the flow reaches final signoff reports."
        ),
        "next_pd_action": next_pd_action,
    }


def terminal_stage_diagnostic(run_dir: Path) -> dict[str, Any] | None:
    if not run_dir.is_dir():
        return None
    latest = latest_stage_name(run_dir)
    if latest is None:
        return None
    stage_dir = run_dir / latest
    log_paths = sorted(stage_dir.glob("*.log"))
    run_log_paths = [run_dir / "error.log", run_dir / "warning.log"]
    problem_patterns = (
        r"error",
        r"exception",
        r"traceback",
        r"no such file",
        r"unknown layer/datatype",
        r"couldn't be read",
        r"failed",
    )
    unknown_layers = unknown_layer_summary(log_paths + run_log_paths)
    pdk_diagnostic = pdk_snapshot_diagnostic(stage_dir)
    antenna_diagnostic = antenna_repair_diagnostic(stage_dir)
    diagnostic = {
        "stage": latest,
        "stage_dir": rel(stage_dir),
        "state_out_present": (stage_dir / "state_out.json").is_file(),
        "last_completed_stage": last_completed_stage_name(run_dir),
        "stage_logs": [
            {
                "path": rel(path),
                "bytes": path.stat().st_size,
                "problem_samples": sample_matching_lines(path, problem_patterns, limit=8),
            }
            for path in log_paths
        ],
        "run_logs": [
            {
                "path": rel(path),
                "present": path.is_file(),
                "bytes": path.stat().st_size if path.is_file() else 0,
                "problem_samples": sample_matching_lines(path, problem_patterns, limit=8),
            }
            for path in run_log_paths
        ],
        "unknown_layer_datatypes": unknown_layers,
        "pdk_snapshot_diagnostic": pdk_diagnostic,
        "antenna_repair_diagnostic": antenna_diagnostic,
        "produced_outputs": [
            {
                "path": rel(path),
                "bytes": path.stat().st_size,
            }
            for pattern in ("*.lef", "*.gds", "*.def", "*.odb")
            for path in sorted(stage_dir.glob(pattern))
        ],
        "next_pd_action": (
            "Treat the terminal-stage logs as diagnostic evidence only. Resolve the "
            "Magic/SRAM GDS layer-map or macro-abstraction failure, then rerun a "
            "complete fail-closed OpenLane flow through DRC, LVS, antenna, STA, "
            "IR, density, and manufacturability signoff."
        ),
    }
    if unknown_layers["count"] and pdk_diagnostic and pdk_diagnostic["status"].startswith("mixed_"):
        diagnostic["root_cause_hypothesis"] = (
            "Magic is reading SRAM GDS polygons from a macro snapshot that does "
            "not match the active Magic/technology snapshot; fix snapshot "
            "alignment before treating the generated LEF as release evidence."
        )
    elif antenna_diagnostic and antenna_diagnostic["status"] == "antenna_repair_plateau":
        diagnostic["root_cause_hypothesis"] = (
            "OpenROAD antenna repair is no longer reducing violations materially; "
            "the run needs antenna strategy, route constraints, diode insertion, "
            "or placement adjustments before release signoff can complete."
        )
    return diagnostic


def process_table_text() -> str:
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,ppid,etime,stat,args"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return ""
    return result.stdout


def count_magic_drc_boxes(report: Path) -> int | None:
    if not report.is_file() or report.stat().st_size == 0:
        return None
    count = 0
    coord_re = re.compile(r"^[0-9.]+um\s+[0-9.]+um\s+[0-9.]+um\s+[0-9.]+um$")
    with report.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if coord_re.match(line.strip()):
                count += 1
    return count


def manual_magic_drc_status(
    run_dir: Path, process_table: str | None = None
) -> dict[str, Any] | None:
    manual_dirs = sorted(run_dir.glob("manual-magic-drc*"))
    reports = []
    for manual_dir in manual_dirs:
        report = manual_dir / "reports/drc_violations.magic.rpt"
        reports.append(
            {
                "path": rel(report),
                "present": report.is_file(),
                "bytes": report.stat().st_size if report.is_file() else 0,
                "parsed_drc_box_count": count_magic_drc_boxes(report),
            }
        )

    if process_table is None:
        process_table = process_table_text()
    needles = {
        run_dir.as_posix(),
        rel(run_dir),
        f"/work/{rel(run_dir)}",
    }
    active_processes = []
    for line in process_table.splitlines():
        references_run = any(needle in line for needle in needles)
        references_manual_drc_child = "magicdnull" in line and "/tmp/manual_drc.tcl" in line
        if not ("manual-magic-drc" in line and references_run) and not references_manual_drc_child:
            continue
        parts = line.split(maxsplit=4)
        if len(parts) < 5:
            continue
        pid, _ppid, elapsed, stat, args = parts
        active_processes.append(
            {
                "pid": pid,
                "elapsed": elapsed,
                "stat": stat,
                "command": args[:320],
            }
        )

    if not manual_dirs and not active_processes:
        return None
    active = bool(active_processes)
    present_reports = [report for report in reports if report["present"]]
    nonempty_reports = [report for report in present_reports if report["bytes"] > 0]
    if active:
        status = "active"
        diagnostic_complete = False
        next_pd_action = (
            "Wait for the manual Magic DRC process to finish, then parse the report "
            "for concrete rules/counts; regardless of result, rerun OpenLane through "
            "manufacturability/signoff before granting release credit."
        )
    elif nonempty_reports:
        status = "finished_with_report"
        diagnostic_complete = True
        next_pd_action = (
            "Use the manual Magic DRC result only to guide geometry fixes, then "
            "rerun OpenLane through manufacturability/signoff."
        )
    elif present_reports:
        status = "finished_empty_report"
        diagnostic_complete = False
        next_pd_action = (
            "Manual Magic DRC is no longer running but produced an empty report; "
            "inspect the manual Magic invocation/logs, rerun the diagnostic if needed, "
            "then rerun OpenLane through manufacturability/signoff."
        )
    else:
        status = "missing_report"
        diagnostic_complete = False
        next_pd_action = (
            "Manual Magic DRC is no longer running and no report was found; rerun the "
            "diagnostic if useful, then rerun OpenLane through manufacturability/signoff."
        )
    return {
        "status": status,
        "diagnostic_complete": diagnostic_complete,
        "release_credit": False,
        "signoff_credit": False,
        "claim_boundary": (
            "Manual Magic DRC is diagnostic only. It does not replace a complete "
            "OpenLane manufacturability/signoff run."
        ),
        "directories": [rel(path) for path in manual_dirs],
        "reports": reports,
        "active_processes": active_processes,
        "next_pd_action": next_pd_action,
    }


def incomplete_run_report(
    run_root: Path,
    run_dir: Path | None,
    process_table: str | None = None,
) -> dict[str, Any]:
    evidence_path = run_dir if run_dir is not None else run_root
    message = (
        f"OpenLane run {rel(run_dir)} has no manufacturability signoff summary"
        if run_dir is not None
        else f"no complete OpenLane manufacturability run found under {rel(run_root)}"
    )
    finding = {
        "code": "openlane_incomplete_pd_run"
        if run_dir is not None
        else "openlane_no_complete_pd_run",
        "severity": "blocker",
        "message": message,
        "evidence": rel(evidence_path),
    }
    if run_dir is not None:
        finding["latest_stage"] = latest_stage_name(run_dir)
        terminal_diagnostic = terminal_stage_diagnostic(run_dir)
        if terminal_diagnostic:
            finding["terminal_stage_diagnostic"] = terminal_diagnostic
        finding["next_step"] = (
            "Re-run OpenLane through manufacturability/signoff or summarize the latest "
            "previous complete run instead."
        )
        manual_status = manual_magic_drc_status(run_dir, process_table)
        if manual_status:
            finding["manual_magic_drc"] = manual_status
            finding["next_step"] = manual_status["next_pd_action"]
    else:
        manual_status = None
    return {
        "schema": SCHEMA,
        "status": "blocked_incomplete_pd_run"
        if run_dir is not None
        else "blocked_no_complete_pd_run",
        "claim_boundary": (
            "Diagnostic-only OpenLane PD blocker summary. It is not signoff "
            "evidence and grants no release credit."
        ),
        "run": rel(run_dir) if run_dir is not None else None,
        "summary": {
            "release_ready": False,
            "release_credit": False,
            "complete_run_found": False,
            "latest_stage": latest_stage_name(run_dir) if run_dir is not None else None,
            "last_completed_stage": (
                last_completed_stage_name(run_dir) if run_dir is not None else None
            ),
            "manual_magic_drc_status": manual_status["status"] if manual_status else None,
            "terminal_stage_state_out_present": (
                terminal_diagnostic["state_out_present"]
                if run_dir is not None and terminal_diagnostic
                else None
            ),
        },
        "findings": [finding],
    }


def load_metrics(run_dir: Path) -> dict[str, Any]:
    state_path = manufacturability_state(run_dir)
    if state_path is None:
        return {}
    data = json.loads(state_path.read_text(encoding="utf-8"))
    metrics = data.get("metrics", data)
    if not isinstance(metrics, dict):
        return {}
    return {key: metrics.get(key) for key in METRIC_KEYS}


def load_all_metrics(run_dir: Path) -> dict[str, Any]:
    state_path = manufacturability_state(run_dir)
    if state_path is None:
        return {}
    data = json.loads(state_path.read_text(encoding="utf-8"))
    metrics = data.get("metrics", data)
    return metrics if isinstance(metrics, dict) else {}


def signoff_blocker_matrix(run_dir: Path, metrics: dict[str, Any]) -> dict[str, Any]:
    rows = {
        "drc": {
            "count": int(metrics.get("magic__drc_error__count") or 0)
            + int(metrics.get("klayout__drc_error__count") or 0),
            "artifact_paths": [rel(magic_drc_report(run_dir))],
            "next_action": "Fix Magic/KLayout DRC violations, then rerun release signoff.",
        },
        "lvs": {
            "count": int(metrics.get("design__lvs_error__count") or 0),
            "artifact_paths": [],
            "next_action": "Resolve LVS mismatches and rerun netgen/OpenLane signoff.",
        },
        "antenna": {
            "count": int(metrics.get("route__antenna_violation__count") or 0),
            "artifact_paths": [rel(final_antenna_report(run_dir))],
            "next_action": "Close final antenna violations with route/diode changes, then rerun.",
        },
        "timing": {
            "count": int(metrics.get("timing__setup_vio__count") or 0)
            + int(metrics.get("timing__hold_vio__count") or 0),
            "artifact_paths": [
                rel(path / "violator_list.rpt") for path in post_pnr_sta_corner_dirs(run_dir)
            ],
            "next_action": "Close setup/hold WNS/TNS in the dominant post-PnR corner.",
        },
        "drv": {
            "count": int(metrics.get("design__max_slew_violation__count") or 0)
            + int(metrics.get("design__max_cap_violation__count") or 0)
            + int(metrics.get("design__max_fanout_violation__count") or 0),
            "artifact_paths": [rel(wirelength_report(run_dir))],
            "next_action": "Reduce slew, capacitance, and fanout violations before release signoff.",
        },
    }
    return {
        "release_credit": False,
        "claim_boundary": (
            "Blocker counts are parsed from existing OpenLane metrics/reports only. "
            "They do not waive or replace signoff."
        ),
        "classes": {
            name: {
                **row,
                "blocked": row["count"] > 0,
                "next_command": (
                    "scripts/run_openlane.sh --release && "
                    "python3 scripts/openlane_pd_blocker_summary.py --write-report && "
                    "python3 scripts/check_pd_signoff.py"
                ),
                "release_credit": False,
            }
            for name, row in rows.items()
        },
    }


def post_pnr_sta_corner_dirs(run_dir: Path) -> list[Path]:
    sta_dir = first_existing(run_dir, ("*-openroad-stapostpnr",))
    if sta_dir is None:
        return []
    return sorted(child for child in sta_dir.iterdir() if child.is_dir())


def parse_length_um(value: str) -> float | None:
    text = value.strip().replace("\u00b5m", "um").replace("\u03bcm", "um")
    match = re.match(r"^(?P<number>[0-9.]+)\s*(?P<unit>um|mm)?$", text)
    if not match:
        return None
    number = float(match.group("number"))
    return number * 1000.0 if (match.group("unit") or "um") == "mm" else number


def wirelength_pressure_summary(run_dir: Path) -> dict[str, Any]:
    report = wirelength_report(run_dir)
    if not report.is_file():
        return {
            "present": False,
            "report": rel(report),
            "release_credit": False,
            "primary_action": (
                "No wirelength CSV was found for the selected run; rerun or archive "
                "the reportwirelength step before using this diagnostic."
            ),
        }

    rows: list[dict[str, Any]] = []
    try:
        with report.open(encoding="utf-8", errors="ignore", newline="") as handle:
            for row in csv.DictReader(handle):
                net = (row.get("net") or "").strip()
                length = parse_length_um(row.get("length_um") or "")
                if net and length is not None:
                    rows.append({"net": net, "length_um": round(length, 3)})
    except OSError:
        rows = []

    rows.sort(key=lambda row: (-row["length_um"], row["net"]))
    clock_rows = [row for row in rows if "clk" in row["net"].lower()]
    numbered_rows = [row for row in rows if re.fullmatch(r"net[0-9]+", row["net"])]
    long_threshold_um = 2000.0
    long_rows = [row for row in rows if row["length_um"] >= long_threshold_um]

    return {
        "present": True,
        "report": rel(report),
        "net_count": len(rows),
        "long_net_threshold_um": long_threshold_um,
        "long_net_count": len(long_rows),
        "top_long_nets": rows[:16],
        "top_clock_nets": clock_rows[:8],
        "top_synthesized_numbered_nets": numbered_rows[:12],
        "primary_action": (
            "Use the ranked long-net list to bound the next routing/timing diagnostic: "
            "first inspect clock trunks and synthesized numbered nets that overlap the "
            "dominant setup/DRV corner, then compare route wirelength, slew, cap, "
            "fanout, and antenna counts before launching a full signoff run."
            if rows
            else "The wirelength CSV did not contain parseable net lengths."
        ),
        "acceptance_check": (
            "A bounded routing diagnostic should reduce the top long-net lengths and "
            "the selected run's slew/cap/fanout or antenna counts. Release still "
            "requires complete clean signoff artifacts."
        ),
        "release_credit": False,
        "claim_boundary": (
            "This is parsed from an existing reportwirelength CSV only. It is not a "
            "new routing run, not timing closure, and not release signoff evidence."
        ),
    }


def _metric_number(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) else None


def _corner_metric(metrics: dict[str, Any], metric: str, corner: str) -> float | int | None:
    return _metric_number(metrics.get(f"{metric}__corner:{corner}"))


def corner_timing_rows(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    corners = sorted(
        {
            key.split("__corner:", 1)[1]
            for key in metrics
            if "__corner:" in key
            and (
                key.startswith("timing__")
                or key.startswith("design__max_slew")
                or key.startswith("design__max_cap")
                or key.startswith("design__max_fanout")
            )
        }
    )
    rows = []
    for corner in corners:
        rows.append(
            {
                "corner": corner,
                "setup_wns": _corner_metric(metrics, "timing__setup__wns", corner),
                "setup_tns": _corner_metric(metrics, "timing__setup__tns", corner),
                "setup_violations": _corner_metric(metrics, "timing__setup_vio__count", corner),
                "hold_wns": _corner_metric(metrics, "timing__hold__wns", corner),
                "hold_tns": _corner_metric(metrics, "timing__hold__tns", corner),
                "hold_violations": _corner_metric(metrics, "timing__hold_vio__count", corner),
                "slew_violations": _corner_metric(
                    metrics, "design__max_slew_violation__count", corner
                ),
                "cap_violations": _corner_metric(
                    metrics, "design__max_cap_violation__count", corner
                ),
                "fanout_violations": _corner_metric(
                    metrics, "design__max_fanout_violation__count", corner
                ),
                "unannotated_nets": _corner_metric(
                    metrics, "timing__unannotated_net__count", corner
                ),
                "filtered_unannotated_nets": _corner_metric(
                    metrics, "timing__unannotated_net_filtered__count", corner
                ),
            }
        )
    return rows


def _worst_minimum(rows: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    candidates = [row for row in rows if isinstance(row.get(key), (int, float))]
    if not candidates:
        return None
    return min(candidates, key=lambda row: row[key])


def _worst_maximum(rows: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    candidates = [row for row in rows if isinstance(row.get(key), (int, float))]
    if not candidates:
        return None
    return max(candidates, key=lambda row: row[key])


def _violator_endpoint_family(pin: str) -> str:
    if "u_sram/" in pin:
        return "sram_macro_pin"
    if "/" not in pin:
        return "top_level_port"
    if pin.startswith("_"):
        return "synthesized_flop_or_cell"
    return "internal_pin"


def parse_violator_list(report: Path, limit: int = 64) -> list[dict[str, Any]]:
    if not report.is_file():
        return []
    pattern = re.compile(
        r"^\[(?P<group>[^\]]+)\]\s+(?P<start>.+?)\s+->\s+"
        r"(?P<end>.+?)\s+:\s+(?P<slack>-?[0-9.]+)$"
    )
    rows = []
    with report.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            match = pattern.match(line.strip())
            if not match:
                continue
            row = match.groupdict()
            row["slack"] = float(row["slack"])
            row["start_family"] = _violator_endpoint_family(row["start"])
            row["end_family"] = _violator_endpoint_family(row["end"])
            rows.append(row)
            if len(rows) >= limit:
                break
    return rows


def _group_violators(rows: list[dict[str, Any]], key: str, limit: int = 8) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        group = row[key]
        item = grouped.setdefault(
            group,
            {
                key: group,
                "count": 0,
                "worst_slack": row["slack"],
                "sample_start": row["start"],
                "sample_end": row["end"],
            },
        )
        item["count"] += 1
        if row["slack"] < item["worst_slack"]:
            item["worst_slack"] = row["slack"]
            item["sample_start"] = row["start"]
            item["sample_end"] = row["end"]
    return sorted(
        grouped.values(),
        key=lambda item: (-item["count"], item["worst_slack"], item[key]),
    )[:limit]


def timing_electrical_closure_summary(run_dir: Path) -> dict[str, Any]:
    metrics = load_all_metrics(run_dir)
    rows = corner_timing_rows(metrics)
    violators_by_corner = []
    all_violators: list[dict[str, Any]] = []
    for corner_dir in post_pnr_sta_corner_dirs(run_dir):
        violator_report = corner_dir / "violator_list.rpt"
        parsed = parse_violator_list(violator_report)
        if not parsed:
            continue
        all_violators.extend(parsed)
        violators_by_corner.append(
            {
                "corner": corner_dir.name,
                "report": rel(violator_report),
                "parsed_sample_count": len(parsed),
                "worst_slack": min(row["slack"] for row in parsed),
                "top_path_groups": _group_violators(parsed, "group", limit=6),
                "top_endpoint_families": _group_violators(parsed, "end_family", limit=6),
                "samples": parsed[:8],
            }
        )

    worst_setup = _worst_minimum(rows, "setup_wns")
    worst_hold = _worst_minimum(rows, "hold_wns")
    worst_slew = _worst_maximum(rows, "slew_violations")
    worst_cap = _worst_maximum(rows, "cap_violations")
    worst_fanout = _worst_maximum(rows, "fanout_violations")
    unannotated = _worst_maximum(rows, "unannotated_nets")
    dominant_corner = None
    if worst_setup is not None:
        dominant_corner = worst_setup["corner"]
    elif worst_slew is not None:
        dominant_corner = worst_slew["corner"]

    return {
        "present": bool(rows or violators_by_corner),
        "state": rel(manufacturability_state(run_dir) or run_dir),
        "dominant_corner": dominant_corner,
        "worst_setup_corner": worst_setup,
        "worst_hold_corner": worst_hold,
        "worst_slew_corner": worst_slew,
        "worst_cap_corner": worst_cap,
        "worst_fanout_corner": worst_fanout,
        "worst_unannotated_corner": unannotated,
        "corners_with_setup_or_hold_violations": [
            row
            for row in rows
            if (row.get("setup_violations") or 0) > 0 or (row.get("hold_violations") or 0) > 0
        ],
        "top_violator_path_groups": _group_violators(all_violators, "group", limit=10),
        "top_violator_endpoint_families": _group_violators(all_violators, "end_family", limit=10),
        "wirelength_pressure": wirelength_pressure_summary(run_dir),
        "violator_reports": sorted(
            violators_by_corner,
            key=lambda item: (item["worst_slack"], item["corner"]),
        )[:6],
        "primary_action": (
            "Prioritize the dominant post-PnR corner and path family before another "
            "full run: inspect SRAM macro output-to-top-port setup paths, reset/input "
            "hold paths, and high-slew/high-cap/fanout nets in the listed violator "
            "reports after the nwell.4 macro geometry blocker is corrected."
            if rows or violators_by_corner
            else "No post-PnR timing/electrical metrics or violator lists were parsed."
        ),
        "acceptance_check": (
            "A bounded STA diagnostic should reduce worst setup/hold WNS and the "
            "per-corner slew/cap/fanout counts in this summary; release credit still "
            "requires a complete clean OpenLane signoff run."
        ),
        "release_credit": False,
        "claim_boundary": (
            "This summarizes existing post-PnR STA/manufacturability artifacts only. "
            "It is not new timing closure evidence and grants no release credit."
        ),
    }


def first_magic_drc_rule(run_dir: Path) -> dict[str, Any]:
    report = magic_drc_report(run_dir)
    if not report.is_file():
        return {"report": rel(report), "present": False}

    module = ""
    rule = ""
    samples = []
    with report.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            text = line.strip()
            if not text or set(text) == {"-"}:
                continue
            if not module:
                module = text
                continue
            if not rule:
                rule = text
                continue
            if re.match(r"^[0-9.]+um\s+[0-9.]+um\s+[0-9.]+um\s+[0-9.]+um$", text):
                samples.append(text)
                if len(samples) >= 8:
                    break

    return {
        "report": rel(report),
        "present": True,
        "module": module,
        "rule": rule,
        "sample_boxes": samples,
    }


def parse_magic_drc_boxes(report: Path) -> list[dict[str, Any]]:
    if not report.is_file():
        return []

    coord_re = re.compile(
        r"^(?P<x1>[0-9.]+)um\s+(?P<y1>[0-9.]+)um\s+"
        r"(?P<x2>[0-9.]+)um\s+(?P<y2>[0-9.]+)um$"
    )
    module: str | None = None
    rule: str | None = None
    saw_box_for_rule = False
    boxes: list[dict[str, Any]] = []
    with report.open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            text = line.strip()
            if not text or set(text) == {"-"}:
                continue
            if match := coord_re.match(text):
                if module and rule:
                    coords = {key: float(value) for key, value in match.groupdict().items()}
                    boxes.append(
                        {
                            "module": module,
                            "rule": rule,
                            "box": text,
                            **coords,
                        }
                    )
                    saw_box_for_rule = True
                continue
            if module is None or (rule is not None and saw_box_for_rule):
                module = text
                rule = None
                saw_box_for_rule = False
                continue
            if rule is None:
                rule = text

    return boxes


def _counter_rows(counter: dict[str, int], key_name: str, limit: int = 12) -> list[dict[str, Any]]:
    return [
        {key_name: key, "count": count}
        for key, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:limit]
    ]


def magic_drc_rule_summary(run_dir: Path) -> dict[str, Any]:
    report = magic_drc_report(run_dir)
    if not report.is_file():
        return {"report": rel(report), "present": False}

    boxes = parse_magic_drc_boxes(report)
    rule_counts: dict[str, int] = {}
    module_counts: dict[str, int] = {}
    module_rule_counts: dict[tuple[str, str], int] = {}
    for box in boxes:
        rule = box["rule"]
        module = box["module"]
        rule_counts[rule] = rule_counts.get(rule, 0) + 1
        module_counts[module] = module_counts.get(module, 0) + 1
        key = (module, rule)
        module_rule_counts[key] = module_rule_counts.get(key, 0) + 1

    nwell_boxes = [
        box
        for box in boxes
        if "nwell.4" in box["rule"] or "nwells must contain" in box["rule"].lower()
    ]
    nwell_x_spans: dict[str, int] = {}
    for box in nwell_boxes:
        x_span = f"{box['x1']:.3f}um..{box['x2']:.3f}um"
        nwell_x_spans[x_span] = nwell_x_spans.get(x_span, 0) + 1

    bounding_box = None
    if boxes:
        bounding_box = {
            "x1": round(min(box["x1"] for box in boxes), 3),
            "y1": round(min(box["y1"] for box in boxes), 3),
            "x2": round(max(box["x2"] for box in boxes), 3),
            "y2": round(max(box["y2"] for box in boxes), 3),
        }

    return {
        "report": rel(report),
        "present": True,
        "parsed_box_count": len(boxes),
        "top_rules": _counter_rows(rule_counts, "rule"),
        "top_modules": _counter_rows(module_counts, "module"),
        "top_module_rule_pairs": [
            {"module": module, "rule": rule, "count": count}
            for (module, rule), count in sorted(
                module_rule_counts.items(),
                key=lambda item: (-item[1], item[0][0], item[0][1]),
            )[:12]
        ],
        "bounding_box_um": bounding_box,
        "nwell4_focus": {
            "present": bool(nwell_boxes),
            "box_count": len(nwell_boxes),
            "top_x_spans": _counter_rows(nwell_x_spans, "x_span", limit=16),
            "primary_action": (
                "Treat nwell.4 as a macro-level tap/rail integration blocker in "
                "the dominant module, not as scattered cleanup. Inspect the ranked "
                "x-span stripes against the generated SRAM/macro array geometry and "
                "add metal-connected N+ tap coverage or replace the generated "
                "abstraction before spending another run on antenna/timing tuning."
                if nwell_boxes
                else "No nwell.4 boxes were parsed from the Magic DRC report."
            ),
            "acceptance_check": (
                "A bounded Magic DRC diagnostic should reduce the parsed nwell.4 "
                "box count and eliminate the repeated high-count x-span stripes; "
                "release credit still requires a complete clean OpenLane signoff run."
            ),
            "release_credit": False,
            "claim_boundary": (
                "This is parsed from an existing Magic DRC report only. It is not "
                "new layout evidence, not signoff evidence, and grants no release credit."
            ),
        },
        "claim_boundary": (
            "Magic DRC rule summaries are diagnostics from existing artifacts only. "
            "They do not replace a clean Magic/KLayout/LVS/STA/antenna signoff run."
        ),
    }


def parse_antenna_summary_rows(report: Path) -> list[dict[str, str]]:
    if not report.is_file():
        return []
    rows = []
    row_re = re.compile(
        r"^│\s*(?P<ratio>[0-9.]+)\s*│\s*(?P<partial>[0-9.]+)\s*│\s*"
        r"(?P<required>[0-9.]+)\s*│\s*(?P<net>.*?)\s*│\s*"
        r"(?P<pin>.*?)\s*│\s*(?P<layer>.*?)\s*│$"
    )
    for line in report.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = row_re.match(line)
        if not match:
            continue
        rows.append({key: value.strip() for key, value in match.groupdict().items()})
    return rows


def antenna_row_ratio(row: dict[str, str]) -> float | None:
    try:
        return float(row.get("ratio", ""))
    except ValueError:
        return None


def antenna_net_family(net: str) -> str:
    if "dram_mem[" in net:
        return "behavioral_dram_mem"
    if "bank_dout[" in net:
        return "bank_dout_bus"
    if re.match(r"^net\d+$", net):
        return "synthesized_numbered_net"
    if re.match(r"^_\d+_$", net):
        return "yosys_internal_net"
    return "named_or_other"


def met3_synthesized_routing_targets(rows: list[dict[str, str]]) -> dict[str, Any]:
    target_rows = [
        row
        for row in rows
        if row.get("layer") == "met3"
        and antenna_net_family(row.get("net") or "") == "synthesized_numbered_net"
    ]
    grouped: dict[str, dict[str, Any]] = {}
    for row in target_rows:
        net = row.get("net") or "unknown"
        ratio = antenna_row_ratio(row)
        entry = grouped.setdefault(
            net,
            {
                "net": net,
                "rows": 0,
                "max_ratio": None,
                "ratio_sum": 0.0,
                "pins": [],
                "sample_rows": [],
            },
        )
        entry["rows"] += 1
        if ratio is not None:
            entry["ratio_sum"] += ratio
            if entry["max_ratio"] is None or ratio > entry["max_ratio"]:
                entry["max_ratio"] = ratio
        pin = row.get("pin")
        if pin and pin not in entry["pins"] and len(entry["pins"]) < 6:
            entry["pins"].append(pin)
        if len(entry["sample_rows"]) < 3:
            entry["sample_rows"].append(row)

    ranked = sorted(
        grouped.values(),
        key=lambda entry: (
            -entry["rows"],
            -(entry["max_ratio"] if isinstance(entry["max_ratio"], float) else 0.0),
            entry["net"],
        ),
    )
    for entry in ranked:
        entry["ratio_sum"] = round(entry["ratio_sum"], 2)
        if isinstance(entry["max_ratio"], float):
            entry["max_ratio"] = round(entry["max_ratio"], 2)
    top = ranked[:16]
    return {
        "present": bool(target_rows),
        "total_rows": len(target_rows),
        "unique_nets": len(grouped),
        "ranked_targets": top,
        "primary_action": (
            "Run a bounded routing/congestion diagnostic against the ranked met3 "
            "synthesized nets, for example localized route-guide or congestion "
            "relief around these nets, then compare bounded CheckAntennas net, "
            "pin, and summary-row counts against the current report."
            if target_rows
            else "No met3 synthesized-net residual rows were parsed."
        ),
        "next_experiment_constraint": (
            "Do not lower `GRT_ANTENNA_MARGIN` for this experiment; keep the "
            "margin fixed and change only routing/congestion inputs so the "
            "comparison isolates whether met3 congestion is the limiter."
        ),
        "success_metric": (
            "The next bounded diagnostic must reduce met3 synthesized-net rows "
            "and total bounded CheckAntennas net/row counts without relying on "
            "a lower antenna margin. It still grants no release credit."
        ),
        "claim_boundary": (
            "This ranking is derived from bounded CheckAntennas rows only. It is "
            "not final antenna signoff, route-quality proof, or fabrication evidence."
        ),
    }


def residual_met_strategy(rows: list[dict[str, str]]) -> dict[str, Any]:
    target_rows = [row for row in rows if row.get("layer") in {"met1", "met3"}]
    layer_counts: dict[str, int] = {}
    family_counts: dict[str, int] = {}
    layer_family_counts: dict[tuple[str, str], int] = {}
    ratio_bands = {
        "ratio_ge_5": 0,
        "ratio_ge_3_lt_5": 0,
        "ratio_ge_1_5_lt_3": 0,
        "ratio_lt_1_5": 0,
        "ratio_unparsed": 0,
    }
    top_by_ratio = sorted(
        target_rows,
        key=lambda row: antenna_row_ratio(row) or 0.0,
        reverse=True,
    )[:12]

    for row in target_rows:
        layer = row.get("layer") or "unknown"
        net = row.get("net") or "unknown"
        family = antenna_net_family(net)
        ratio = antenna_row_ratio(row)
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        family_counts[family] = family_counts.get(family, 0) + 1
        key = (layer, family)
        layer_family_counts[key] = layer_family_counts.get(key, 0) + 1
        if ratio is None:
            ratio_bands["ratio_unparsed"] += 1
        elif ratio >= 5:
            ratio_bands["ratio_ge_5"] += 1
        elif ratio >= 3:
            ratio_bands["ratio_ge_3_lt_5"] += 1
        elif ratio >= 1.5:
            ratio_bands["ratio_ge_1_5_lt_3"] += 1
        else:
            ratio_bands["ratio_lt_1_5"] += 1

    total = len(target_rows)
    met3_synth = layer_family_counts.get(("met3", "synthesized_numbered_net"), 0)
    met1_dram = layer_family_counts.get(("met1", "behavioral_dram_mem"), 0)
    met3_synth_targets = met3_synthesized_routing_targets(rows)
    if total and met3_synth >= max(8, total // 3):
        primary_strategy = "routing_congestion_first"
        next_action = (
            "Prioritize a bounded routing/congestion probe for met3 synthesized nets "
            "before another margin-only sweep; use the top targets as route-guide or "
            "placement-congestion evidence, then compare bounded CheckAntennas rows."
        )
    elif total and met1_dram >= max(6, total // 5):
        primary_strategy = "targeted_diode_or_source_net_review"
        next_action = (
            "Prioritize explicit diode/source-net review for repeated met1 DRAM nets; "
            "compare whether targeted diode placement reduces these rows without "
            "increasing met3 residuals."
        )
    elif total:
        primary_strategy = "mixed_route_and_diode_review"
        next_action = (
            "Use the ranked met1/met3 targets to choose a localized routing, "
            "placement-congestion, or diode-location experiment before changing "
            "antenna margin again."
        )
    else:
        primary_strategy = "no_met1_met3_rows"
        next_action = "No met1/met3 residual rows were parsed from this antenna report."

    return {
        "present": bool(target_rows),
        "total_met1_met3_rows": total,
        "layer_rows": [
            {"layer": layer, "rows": count}
            for layer, count in sorted(layer_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "net_family_rows": [
            {"family": family, "rows": count}
            for family, count in sorted(family_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "layer_net_family_rows": [
            {"layer": layer, "family": family, "rows": count}
            for (layer, family), count in sorted(
                layer_family_counts.items(),
                key=lambda item: (-item[1], item[0][0], item[0][1]),
            )
        ][:12],
        "ratio_bands": ratio_bands,
        "top_targets_by_ratio": top_by_ratio,
        "met3_synthesized_routing_targets": met3_synth_targets,
        "primary_strategy": primary_strategy,
        "next_pd_action": next_action,
        "claim_boundary": (
            "This classifies residual antenna rows to choose the next bounded "
            "diagnostic. It is not diode-placement proof, route-quality proof, "
            "or release signoff evidence."
        ),
    }


def antenna_rows(run_dir: Path) -> list[dict[str, str]]:
    return parse_antenna_summary_rows(final_antenna_report(run_dir))


def post_repair_checkantennas_summary(stage_dir: Path) -> dict[str, Any]:
    repair_dir = stage_dir.parent if stage_dir.name == "1-diodeinsertion" else stage_dir
    check_dir = repair_dir / "2-openroad-checkantennas"
    log = check_dir / "openroad-checkantennas.log"
    report = check_dir / "reports/antenna_summary.rpt"
    net_violations: int | None = None
    pin_violations: int | None = None
    if log.is_file():
        net_re = re.compile(r"Found (?P<count>\d+) net violations\.")
        pin_re = re.compile(r"Found (?P<count>\d+) pin violations\.")
        with log.open(encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                if match := net_re.search(line):
                    net_violations = int(match.group("count"))
                if match := pin_re.search(line):
                    pin_violations = int(match.group("count"))
    rows = parse_antenna_summary_rows(report)
    layer_counts: dict[str, int] = {}
    net_counts: dict[str, int] = {}
    for row in rows:
        layer = row.get("layer") or "unknown"
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        net = row.get("net") or "unknown"
        net_counts[net] = net_counts.get(net, 0) + 1
    return {
        "log": rel(log),
        "report": rel(report),
        "present": log.is_file() or report.is_file(),
        "net_violations": net_violations,
        "pin_violations": pin_violations,
        "summary_rows": len(rows),
        "top_layers": [
            {"layer": layer, "rows": count}
            for layer, count in sorted(layer_counts.items(), key=lambda item: (-item[1], item[0]))[
                :8
            ]
        ],
        "top_nets": [
            {"net": net, "rows": count}
            for net, count in sorted(net_counts.items(), key=lambda item: (-item[1], item[0]))[:12]
        ],
        "top_rows": rows[:12],
        "residual_met1_met3_strategy": residual_met_strategy(rows),
        "claim_boundary": (
            "This is the bounded post-repair CheckAntennas report, not final "
            "signoff antenna evidence."
        ),
    }


def antenna_repair_stage_dirs(run_root: Path) -> list[Path]:
    return sorted(
        (
            stage
            for stage in run_root.glob("RUN_*/*-openroad-repairantennas/1-diodeinsertion")
            if stage.is_dir() and "segment" in stage.parent.parent.name
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def antenna_experiment_snapshot(
    stage_dir: Path,
    repair_summary: dict[str, Any] | None = None,
    config_values: dict[str, Any] | None = None,
    post_checkantennas: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    repair_dir = stage_dir.parent if stage_dir.name == "1-diodeinsertion" else stage_dir
    diode_dir = repair_dir / "1-diodeinsertion"
    log = diode_dir / "diodeinsertion.log"
    repair_summary = repair_summary or antenna_repair_log_summary(log)
    if not repair_summary.get("iteration_count"):
        return None
    if config_values is None:
        config_values = {}
        for config_path in (
            repair_dir / "config.json",
            repair_dir.parent / "01-odb-diodesonports/config.json",
        ):
            if not config_path.is_file():
                continue
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            for key in (
                "DIODE_ON_PORTS",
                "GRT_ANTENNA_ITERS",
                "GRT_ANTENNA_MARGIN",
                "RUN_HEURISTIC_DIODE_INSERTION",
                "RT_MAX_LAYER",
            ):
                if key in config and key not in config_values:
                    config_values[key] = config[key]
    post_checkantennas = post_checkantennas or post_repair_checkantennas_summary(stage_dir)
    return {
        "run": rel(repair_dir.parent),
        "stage": rel(repair_dir),
        "log": rel(log),
        "design_name": repair_summary.get("design_name"),
        "config_values": config_values,
        "bounded_segment_completed": (repair_dir / "state_out.json").is_file(),
        "best_remaining_antenna_violations": repair_summary.get(
            "best_remaining_antenna_violations"
        ),
        "last_remaining_antenna_violations": repair_summary.get(
            "last_remaining_antenna_violations"
        ),
        "total_inserted_diodes_logged": repair_summary.get("total_inserted_diodes_logged"),
        "post_repair_checkantennas": {
            key: post_checkantennas.get(key)
            for key in (
                "present",
                "net_violations",
                "pin_violations",
                "summary_rows",
                "top_layers",
                "top_nets",
                "top_rows",
                "residual_met1_met3_strategy",
            )
        },
    }


def segmented_antenna_experiment_ranking(
    current_stage_dir: Path,
    current_repair_summary: dict[str, Any],
    current_config_values: dict[str, Any],
    current_post_checkantennas: dict[str, Any],
    limit: int = 8,
) -> dict[str, Any]:
    current = antenna_experiment_snapshot(
        current_stage_dir,
        current_repair_summary,
        current_config_values,
        current_post_checkantennas,
    )
    if current is None:
        return {"present": False, "experiments": []}
    current_design = current.get("design_name")
    snapshots = [current]
    for stage_dir in antenna_repair_stage_dirs(RUN_ROOT):
        if stage_dir.resolve() == current_stage_dir.resolve():
            continue
        snapshot = antenna_experiment_snapshot(stage_dir)
        if snapshot is None:
            continue
        if snapshot["run"] == current["run"]:
            continue
        if (
            current_design
            and snapshot.get("design_name")
            and snapshot.get("design_name") != current_design
        ):
            continue
        snapshots.append(snapshot)
        if len(snapshots) >= limit:
            break

    def repair_key(snapshot: dict[str, Any]) -> tuple[int, int, str]:
        best = snapshot.get("best_remaining_antenna_violations")
        last = snapshot.get("last_remaining_antenna_violations")
        return (
            best if isinstance(best, int) else 10**9,
            last if isinstance(last, int) else 10**9,
            snapshot["run"],
        )

    ranked_by_repair = sorted(snapshots, key=repair_key)
    current_best = current.get("best_remaining_antenna_violations")
    current_post = current["post_repair_checkantennas"]
    prior_with_post = [
        snapshot
        for snapshot in ranked_by_repair
        if snapshot["run"] != current["run"]
        and snapshot["post_repair_checkantennas"].get("present")
        and isinstance(snapshot.get("best_remaining_antenna_violations"), int)
    ]
    baseline = prior_with_post[0] if prior_with_post else None
    comparison: dict[str, Any] | None = None
    possible_false_improvement = False
    if baseline and isinstance(current_best, int):
        prior_post = baseline["post_repair_checkantennas"]
        current_rows = current_post.get("summary_rows")
        prior_rows = prior_post.get("summary_rows")
        current_nets = current_post.get("net_violations")
        prior_nets = prior_post.get("net_violations")
        repair_delta = current_best - baseline["best_remaining_antenna_violations"]
        row_delta = (
            current_rows - prior_rows
            if isinstance(current_rows, int) and isinstance(prior_rows, int)
            else None
        )
        net_delta = (
            current_nets - prior_nets
            if isinstance(current_nets, int) and isinstance(prior_nets, int)
            else None
        )
        possible_false_improvement = bool(
            repair_delta < 0
            and (
                (isinstance(row_delta, int) and row_delta >= 0)
                or (isinstance(net_delta, int) and net_delta >= 0)
            )
        )
        comparison = {
            "prior_run": baseline["run"],
            "repair_loop_best_delta": repair_delta,
            "post_checkantennas_net_violation_delta": net_delta,
            "post_checkantennas_pin_violation_delta": (
                current_post.get("pin_violations") - prior_post.get("pin_violations")
                if isinstance(current_post.get("pin_violations"), int)
                and isinstance(prior_post.get("pin_violations"), int)
                else None
            ),
            "post_checkantennas_summary_row_delta": row_delta,
            "prior_top_layers": prior_post.get("top_layers"),
            "current_top_layers": current_post.get("top_layers"),
        }

    return {
        "present": True,
        "claim_boundary": (
            "Segmented antenna experiments are diagnostic only and do not replace "
            "a complete clean OpenLane signoff run."
        ),
        "current_run": current["run"],
        "ranked_by_repair_loop": ranked_by_repair[:limit],
        "comparison_baseline": comparison,
        "repair_loop_improvement_is_potentially_false": possible_false_improvement,
        "next_experiment_recommendation": (
            "Do not treat a lower RepairAntennas loop count as progress unless "
            "bounded CheckAntennas residual net, pin, and summary-row counts also "
            "move down. Prioritize met3/met1 residual nets from the ranking before "
            "another margin-only sweep."
            if possible_false_improvement
            else "Use the ranked residual layers/nets to choose the next bounded "
            "routing, placement, or diode-location experiment before any full "
            "signoff-length rerun."
        ),
    }


def build_report(
    run_root: Path = RUN_ROOT,
    run_dir: Path | None = None,
    process_table: str | None = None,
) -> dict[str, Any]:
    run_root = normalize_path(run_root)
    explicit_run_dir = run_dir is not None
    if run_dir is not None and not run_dir.is_absolute():
        run_dir = normalize_path(run_dir)
    if run_dir is not None and (
        not manufacturability_state(run_dir) or not manufacturability_report(run_dir)
    ):
        return incomplete_run_report(run_root, run_dir, process_table)
    runs = [run_dir] if run_dir else complete_run_dirs(run_root)
    if not runs:
        return incomplete_run_report(run_root, None, process_table)

    run_dir = runs[0] if run_dir else max(runs, key=lambda path: path.stat().st_mtime)
    latest_run = None if explicit_run_dir else latest_run_dir(run_root)
    metrics = load_metrics(run_dir)
    magic_count = int(metrics.get("magic__drc_error__count") or 0)
    klayout_count = int(metrics.get("klayout__drc_error__count") or 0)
    lvs_count = int(metrics.get("design__lvs_error__count") or 0)
    antenna_count = int(metrics.get("route__antenna_violation__count") or 0)
    setup_count = int(metrics.get("timing__setup_vio__count") or 0)
    hold_count = int(metrics.get("timing__hold_vio__count") or 0)
    slew_count = int(metrics.get("design__max_slew_violation__count") or 0)
    cap_count = int(metrics.get("design__max_cap_violation__count") or 0)
    fanout_count = int(metrics.get("design__max_fanout_violation__count") or 0)
    release_ready = not any(
        (
            magic_count,
            klayout_count,
            lvs_count,
            antenna_count,
            setup_count,
            hold_count,
            slew_count,
            cap_count,
            fanout_count,
        )
    )

    findings = []
    blocker_matrix = signoff_blocker_matrix(run_dir, metrics)
    artifact_summary = signoff_artifact_handoff_summary(run_dir)
    selected_artifacts = artifact_summary.get("selected_run", {})
    if selected_artifacts.get("missing_count"):
        findings.append(
            {
                "code": "pd_signoff_artifact_handoff_blocked",
                "severity": "blocker",
                "message": (
                    "Selected PD run is missing "
                    f"{selected_artifacts['missing_count']} of "
                    f"{selected_artifacts['required_count']} required signoff "
                    "artifact classes"
                ),
                "evidence": artifact_summary,
                "next_step": artifact_summary["primary_action"],
                "next_command": "python3 scripts/check_pd_signoff.py",
                "release_credit": False,
            }
        )
    manual_status = manual_magic_drc_status(run_dir, process_table)
    if manual_status:
        findings.append(
            {
                "code": "manual_magic_drc_diagnostic_only",
                "severity": "blocker" if manual_status["status"] == "active" else "info",
                "message": (
                    "Manual Magic DRC evidence is diagnostic only and does not prove "
                    "physical signoff."
                ),
                "evidence": manual_status,
                "next_step": manual_status["next_pd_action"],
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )
    if magic_count:
        first_rule = first_magic_drc_rule(run_dir)
        rule_summary = magic_drc_rule_summary(run_dir)
        findings.append(
            {
                "code": "magic_drc_blocked",
                "severity": "blocker",
                "message": f"Magic DRC reports {magic_count} violations",
                "evidence": {
                    "first_rule": first_rule,
                    "rule_summary": rule_summary,
                },
                "next_step": (
                    rule_summary.get("nwell4_focus", {}).get("primary_action")
                    or "Fix or replace the macro/SRAM generated geometry before "
                    "chasing smaller antenna or timing counters."
                ),
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )
    if klayout_count and not magic_count:
        findings.append(
            {
                "code": "klayout_drc_blocked",
                "severity": "blocker",
                "message": f"KLayout DRC reports {klayout_count} violations",
                "evidence": blocker_matrix["classes"]["drc"],
                "next_step": "Fix KLayout DRC violations and rerun complete fail-closed signoff.",
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )
    if lvs_count:
        findings.append(
            {
                "code": "lvs_blocked",
                "severity": "blocker",
                "message": f"LVS reports {lvs_count} errors",
                "evidence": blocker_matrix["classes"]["lvs"],
                "next_step": "Resolve netlist/layout mismatches and rerun complete signoff.",
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )
    if antenna_count:
        findings.append(
            {
                "code": "antenna_blocked",
                "severity": "blocker",
                "message": f"OpenROAD antenna check reports {antenna_count} violations",
                "evidence": {
                    "report": rel(final_antenna_report(run_dir)),
                    "rows": antenna_rows(run_dir),
                },
                "next_step": "Repair the listed nets after Magic DRC geometry is under control.",
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )
    if setup_count or hold_count or slew_count or cap_count or fanout_count:
        timing_summary = timing_electrical_closure_summary(run_dir)
        findings.append(
            {
                "code": "timing_electrical_blocked",
                "severity": "blocker",
                "message": (
                    f"setup={setup_count}, hold={hold_count}, slew={slew_count}, "
                    f"cap={cap_count}, fanout={fanout_count}"
                ),
                "evidence": timing_summary,
                "next_step": timing_summary["primary_action"],
                "next_command": "scripts/run_openlane.sh --release",
                "release_credit": False,
            }
        )

    latest_incomplete_diagnostic = None
    if (
        latest_run is not None
        and latest_run != run_dir
        and (not manufacturability_state(latest_run) or not manufacturability_report(latest_run))
    ):
        latest_incomplete_diagnostic = incomplete_run_report(
            run_root,
            latest_run,
            process_table,
        )

    report = {
        "schema": SCHEMA,
        "status": "blocked" if not release_ready else "pass",
        "claim_boundary": (
            "Diagnostic-only OpenLane PD blocker summary from existing run artifacts. "
            "It is not new OpenLane execution, not signoff evidence, and grants no release credit."
        ),
        "run": rel(run_dir),
        "summary": {
            "release_ready": release_ready,
            "release_credit": False,
            "complete_run_found": True,
            "latest_run": rel(latest_run) if latest_run is not None else rel(run_dir),
            "latest_complete_run": rel(run_dir),
            "latest_run_is_complete": latest_run is None or latest_run == run_dir,
            "manual_magic_drc_status": manual_status["status"] if manual_status else None,
            "signoff_artifact_handoff_status": artifact_summary["status"],
            "signoff_artifact_handoff_missing_count": selected_artifacts.get("missing_count"),
            "drc_blocked": blocker_matrix["classes"]["drc"]["blocked"],
            "lvs_blocked": blocker_matrix["classes"]["lvs"]["blocked"],
            "antenna_blocked": blocker_matrix["classes"]["antenna"]["blocked"],
            "timing_blocked": blocker_matrix["classes"]["timing"]["blocked"],
            "drv_blocked": blocker_matrix["classes"]["drv"]["blocked"],
            **metrics,
        },
        "blocker_matrix": blocker_matrix,
        "findings": findings,
    }
    if latest_incomplete_diagnostic is not None:
        report["latest_incomplete_pd_run_diagnostic"] = latest_incomplete_diagnostic
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", type=Path, default=RUN_ROOT)
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.run_root, args.run_dir)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
