#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.spline_fit_proof import (  # noqa: E402
    ASIMOV_PARAM_PROOFS,
    SECTION_METHODS,
    VALIDATION_MESH_SOURCES,
    build_spline_fit_proof,
    load_connection_specs,
    write_spline_fit_proof,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fit and validate periodic cubic splines for ASIMOV-1 STL cross-sections."
    )
    parser.add_argument(
        "--link",
        action="append",
        default=None,
        help="ASIMOV mesh link name, e.g. LEFT_TOE. May be repeated.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Generate proof reports for every link in cad/asimov-feminine/param/connections.py.",
    )
    parser.add_argument(
        "--axis",
        default=None,
        choices=["x", "y", "z"],
        help=(
            "Override spine axis. Defaults to the connection-table spine axis, "
            "or x for legacy single-link mode."
        ),
    )
    parser.add_argument("--step-m", type=float, default=0.01)
    parser.add_argument("--slab-m", type=float, default=0.004)
    parser.add_argument("--angular-samples", type=int, default=96)
    parser.add_argument("--control-count", type=int, default=32)
    parser.add_argument("--max-error-m", type=float, default=0.003)
    parser.add_argument("--rms-error-m", type=float, default=0.001)
    parser.add_argument("--interface-tolerance-m", type=float, default=0.003)
    parser.add_argument("--surface-distance-tolerance-m", type=float, default=0.02)
    parser.add_argument("--surface-distance-samples", type=int, default=5000)
    parser.add_argument(
        "--section-method",
        choices=sorted(SECTION_METHODS),
        default="slab",
        help=(
            "Cross-section sampler. plane_intersection uses exact triangle-plane "
            "intersections instead of nearby slab vertices; plane_loops fits every "
            "closed contour loop above --min-loop-perimeter-m."
        ),
    )
    parser.add_argument("--min-loop-perimeter-m", type=float, default=0.005)
    parser.add_argument("--section-nudge-m", type=float, default=1e-7)
    parser.add_argument(
        "--validation-mesh-source",
        choices=sorted(VALIDATION_MESH_SOURCES),
        default="output_mesh",
        help=(
            "Mesh used for interface/topology/surface proof. controlled_loft "
            "validates a sealed mesh generated from the fitted spline sections."
        ),
    )
    parser.add_argument(
        "--reuse-existing-parameters",
        action="store_true",
        help=(
            "When an existing proof JSON is present in --output-dir, reuse its "
            "axis, section method, validation source, sampling, and tolerance "
            "parameters before regenerating. This is useful when refreshing the "
            "proof schema across all links without losing per-link repair settings."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "Single-link output JSON path. Defaults to "
            "cad/asimov-feminine/proofs/<LINK>.spline-fit.json"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ASIMOV_PARAM_PROOFS,
        help="Directory for multi-link outputs.",
    )
    parser.add_argument(
        "--failed-output-dir",
        type=Path,
        default=None,
        help=(
            "Optional directory for failed reports. When set, passing reports go to "
            "--output-dir and failed reports go here so failed attempts do not count as proofs."
        ),
    )
    args = parser.parse_args()

    connection_specs = load_connection_specs()
    if args.all:
        links = sorted(connection_specs)
    else:
        links = args.link or ["LEFT_TOE"]

    if len(links) > 1 and args.output is not None:
        parser.error("--output can only be used with one --link")

    results = []
    for link in links:
        existing_report = None
        existing_path = args.output if args.output is not None else args.output_dir / f"{link}.spline-fit.json"
        if args.reuse_existing_parameters and existing_path.is_file():
            try:
                existing_report = json.loads(existing_path.read_text(encoding="utf-8"))
            except Exception:
                existing_report = None
        existing_tolerances = (
            existing_report.get("tolerances", {})
            if isinstance(existing_report, dict)
            else {}
        )
        existing_surface_distance = (
            existing_report.get("surface_distance", {})
            if isinstance(existing_report, dict)
            else {}
        )
        axis = (
            args.axis
            or (existing_report.get("axis") if isinstance(existing_report, dict) else None)
            or connection_specs.get(link, {}).get("spine")
            or "x"
        )
        report = build_spline_fit_proof(
            link=link,
            axis=axis,
            step_m=(
                existing_report.get("step_m", args.step_m)
                if isinstance(existing_report, dict)
                else args.step_m
            ),
            slab_m=(
                existing_report.get("slab_m", args.slab_m)
                if isinstance(existing_report, dict)
                else args.slab_m
            ),
            angular_samples=(
                existing_report.get("angular_samples", args.angular_samples)
                if isinstance(existing_report, dict)
                else args.angular_samples
            ),
            control_count=(
                existing_report.get("control_count", args.control_count)
                if isinstance(existing_report, dict)
                else args.control_count
            ),
            max_error_m=existing_tolerances.get("max_error_m", args.max_error_m),
            rms_error_m=existing_tolerances.get("rms_error_m", args.rms_error_m),
            interface_tolerance_m=existing_tolerances.get(
                "interface_tolerance_m",
                args.interface_tolerance_m,
            ),
            surface_distance_tolerance_m=existing_tolerances.get(
                "surface_distance_tolerance_m",
                args.surface_distance_tolerance_m,
            ),
            topology_merge_tolerance_m=existing_tolerances.get(
                "topology_merge_tolerance_m",
                1e-6,
            ),
            surface_distance_samples=existing_surface_distance.get(
                "source_sample_count",
                args.surface_distance_samples,
            ),
            section_method=(
                existing_report.get("section_method", args.section_method)
                if isinstance(existing_report, dict)
                else args.section_method
            ),
            min_loop_perimeter_m=existing_tolerances.get(
                "min_loop_perimeter_m",
                args.min_loop_perimeter_m,
            ),
            section_nudge_m=existing_tolerances.get(
                "section_nudge_m",
                args.section_nudge_m,
            ),
            validation_mesh_source=(
                existing_report.get("validation_mesh_source", args.validation_mesh_source)
                if isinstance(existing_report, dict)
                else args.validation_mesh_source
            ),
        )
        if args.output is not None:
            output = args.output
        elif report["summary"]["ok"] or args.failed_output_dir is None:
            output = args.output_dir / f"{link}.spline-fit.json"
        else:
            output = args.failed_output_dir / f"{link}.spline-fit.json"
        write_spline_fit_proof(report, output)
        if report["summary"]["ok"] and args.failed_output_dir is not None:
            stale_failed_output = args.failed_output_dir / f"{link}.spline-fit.json"
            if stale_failed_output != output and stale_failed_output.is_file():
                stale_failed_output.unlink()
        results.append(
            {
                "link": link,
                "axis": axis,
                "output": str(output),
                **report["summary"],
            }
        )

    summary = {
        "ok": all(result["ok"] for result in results),
        "links": len(results),
        "passed": sum(1 for result in results if result["ok"]),
        "failed": sum(1 for result in results if not result["ok"]),
        "results": results,
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
