#!/usr/bin/env python3
"""Drive a REAL Sky130 synth->QoR baseline and populate the regression store.

This is the open-PDK proof for the QoR loop. It runs, in order:

  1. Liberty-aware Sky130 synthesis (yosys_e1_soc_qor.ys + the tech-map passes
     this runner appends from the PD feedback manifest). Real Yosys + the
     sky130_fd_sc_hd TT Liberty already vendored under external/pdks/volare.
  2. Optionally a full OpenLane signoff run (--with-openlane) to produce
     final/metrics.json, then records the post-route PPA row into the QoR
     regression store as the Sky130 baseline.

When --with-openlane is set but openlane/openroad are absent (or the run does
not reach signoff), the script emits a fail-closed BLOCKED QoR row naming the
exact reproduction command — it never fabricates QoR numbers.

The synth-only step is real on any host with Yosys + the Sky130 Liberty (both
present in this tree). It proves the Liberty-aware frontend; post-route truth
remains gated behind a completed OpenLane signoff.

Usage:
  scripts/run_sky130_qor_baseline.py --run-id <id> [--baseline] \
      [--feedback build/qor/pd_feedback.sky130.json] \
      [--with-openlane] [--clock-period-ns 100]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qor_regression import (  # noqa: E402
    append_row,
    collect_metrics,
    make_blocked_row,
    make_row,
    required_metric_keys,
)

ROOT = Path(__file__).resolve().parents[1]
NODE_ID = "sky130"
DESIGN = "e1_chip_top"
QOR_SYNTH_YS = ROOT / "yosys_e1_soc_qor.ys"
SKY130_LIBERTY = (
    ROOT / "external/pdks/volare/sky130/versions/"
    "c6d73a35f524070e85faff4a6a9eef49553ebc2b/sky130A/libs.ref/"
    "sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib"
)
OPENLANE_CONFIG = ROOT / "pd" / "openlane" / "config.sky130.json"


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def yosys_bin() -> str | None:
    local = ROOT / "external" / "oss-cad-suite" / "bin" / "yosys"
    if local.is_file():
        return str(local)
    return shutil.which("yosys")


def _read_feedback(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    doc = json.loads(path.read_text())
    return doc if isinstance(doc, dict) else {}


def build_synth_script(
    *, build_dir: Path, retime: bool, abc_delay_ps: int, stat_json: Path
) -> Path:
    """Compose the full QoR synth script: shared passes + Sky130 tech-map."""
    base = QOR_SYNTH_YS.read_text()
    netlist = build_dir / "e1_chip_synth_sky130.v"
    abc_cmd = f"abc -liberty {SKY130_LIBERTY} -D {abc_delay_ps}"
    if retime:
        # ABC retiming requires the -dff path; this moves registers across logic
        # to balance the critical path the PD feedback flagged.
        abc_cmd = f"abc -liberty {SKY130_LIBERTY} -dff -D {abc_delay_ps}"
    tech_passes = [
        "",
        f"# --- Sky130 technology mapping (appended by {Path(__file__).name}) ---",
        f"dfflibmap -liberty {SKY130_LIBERTY}",
        abc_cmd,
        "setundef -zero",
        "splitnets",
        "opt_clean -purge",
        f"tee -o {build_dir / 'sky130_stat.log'} stat -liberty {SKY130_LIBERTY}",
        f"tee -o {stat_json} stat -liberty {SKY130_LIBERTY} -json",
        f"write_verilog {netlist}",
    ]
    script = base + "\n".join(tech_passes) + "\n"
    out = build_dir / "yosys_e1_soc_qor.generated.ys"
    out.write_text(script)
    return out


def run_synth(args: argparse.Namespace, feedback: dict[str, Any]) -> int:
    yosys = yosys_bin()
    build_dir = ROOT / "build" / "qor" / "sky130" / args.run_id
    if yosys is None:
        print(
            "STATUS: BLOCKED sky130-qor.synth - Yosys missing. "
            "Install oss-cad-suite (external/oss-cad-suite) or `apt install yosys`. "
            "Reproduce: . tools/env.sh && python3 "
            f"scripts/run_sky130_qor_baseline.py --run-id {args.run_id}",
            file=sys.stderr,
        )
        return 2
    if not SKY130_LIBERTY.is_file():
        print(
            "STATUS: BLOCKED sky130-qor.synth - Sky130 Liberty missing at "
            f"{SKY130_LIBERTY.relative_to(ROOT)}. Fetch the volare sky130 PDK. "
            "Reproduce: make sky130-pdk && python3 "
            f"scripts/run_sky130_qor_baseline.py --run-id {args.run_id}",
            file=sys.stderr,
        )
        return 2

    build_dir.mkdir(parents=True, exist_ok=True)
    abc_delay_ps = int(round(args.clock_period_ns * 1000))
    retime = bool(
        feedback.get("signals", {}).get("critical_paths", {}).get("recommend_retiming", False)
    )
    stat_json = build_dir / "sky130_stat.json"
    script = build_synth_script(
        build_dir=build_dir,
        retime=retime,
        abc_delay_ps=abc_delay_ps,
        stat_json=stat_json,
    )
    log = build_dir / "yosys_qor.log"
    completed = subprocess.run(
        [yosys, "-q", "-l", str(log), str(script)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        tail = "\n".join(completed.stderr.splitlines()[-30:])
        return fail("yosys QoR synthesis failed", returncode=completed.returncode, stderr_tail=tail)
    print(
        f"PASS: Sky130 Liberty-aware synth complete (retime={retime}) "
        f"-> {stat_json.relative_to(ROOT)}; log {log.relative_to(ROOT)}"
    )
    return 0


def record_post_route(args: argparse.Namespace) -> int:
    """Run/parse an OpenLane signoff and record the QoR row, or fail closed."""
    keys = required_metric_keys()
    openlane = shutil.which("openlane")
    metrics_path = (
        ROOT / "build" / "qor" / "sky130" / args.run_id / "openlane" / "final" / "metrics.json"
    )
    repro = (
        ". tools/env.sh && openlane "
        f"{OPENLANE_CONFIG.relative_to(ROOT)} --run-tag qor-{args.run_id} "
        "&& python3 scripts/run_sky130_qor_baseline.py "
        f"--run-id {args.run_id} --with-openlane --baseline"
    )

    if not metrics_path.is_file():
        if openlane is None:
            row = make_blocked_row(
                design=DESIGN,
                node_id=NODE_ID,
                run_id=args.run_id,
                reason="openlane absent; post-route Sky130 signoff not run",
                proving_command=repro,
            )
            append_row(row)
            print(
                "STATUS: BLOCKED sky130-qor.post-route - openlane missing. "
                f"Recorded fail-closed QoR placeholder. Reproduce: {repro}",
                file=sys.stderr,
            )
            return 2
        row = make_blocked_row(
            design=DESIGN,
            node_id=NODE_ID,
            run_id=args.run_id,
            reason=f"no metrics.json at {metrics_path.relative_to(ROOT)}; "
            "OpenLane signoff not completed in this run dir",
            proving_command=repro,
        )
        append_row(row)
        print(
            "STATUS: BLOCKED sky130-qor.post-route - signoff metrics.json absent. "
            f"Recorded fail-closed placeholder. Reproduce: {repro}",
            file=sys.stderr,
        )
        return 2

    try:
        metrics = collect_metrics(metrics_path, keys)
    except ValueError as exc:
        return fail(str(exc), metrics_json=str(metrics_path))
    row = make_row(
        design=DESIGN,
        node_id=NODE_ID,
        run_id=args.run_id,
        metrics=metrics,
        source=str(metrics_path.relative_to(ROOT)),
        baseline=args.baseline,
    )
    append_row(row)
    print(f"PASS: recorded Sky130 post-route QoR row run_id={args.run_id} baseline={args.baseline}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--feedback", default=None)
    parser.add_argument("--with-openlane", action="store_true")
    parser.add_argument("--clock-period-ns", type=float, default=100.0)
    parser.add_argument(
        "--synth-only",
        action="store_true",
        help="Only run the Liberty-aware synth step (skip post-route recording).",
    )
    args = parser.parse_args()

    feedback_path = None
    if args.feedback:
        feedback_path = Path(args.feedback)
        if not feedback_path.is_absolute():
            feedback_path = (ROOT / args.feedback).resolve()
    feedback = _read_feedback(feedback_path)

    synth_rc = run_synth(args, feedback)
    if synth_rc != 0:
        return synth_rc
    if args.synth_only:
        return 0
    if args.with_openlane:
        return record_post_route(args)

    # Default: synth ran for real; post-route stays fail-closed until requested.
    repro = (
        f"python3 scripts/run_sky130_qor_baseline.py --run-id {args.run_id} "
        "--with-openlane --baseline"
    )
    row = make_blocked_row(
        design=DESIGN,
        node_id=NODE_ID,
        run_id=args.run_id,
        reason="post-route signoff not requested (synth-only baseline run)",
        proving_command=repro,
    )
    append_row(row)
    print(
        "NOTE: Liberty-aware synth completed; post-route QoR row recorded as "
        f"BLOCKED placeholder. Run with --with-openlane to capture real QoR. "
        f"Reproduce: {repro}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
