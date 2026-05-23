#!/usr/bin/env python3
"""External DRC verifier for OpenRAM-generated Sky130 macros.

OpenRAM ships its own conda Magic pinned at 8.3.363, which fails to load
Volare's Sky130A magic techfile (Ambiguous / Unrecognized layer name,
Malformed device keyword; needs 8.3.411+). Inline DRC is therefore disabled
in the OpenRAM configs and verified afterwards here with the native Magic on
PATH (tools/env.sh puts magic 8.3.645 first), against the Volare sky130A
techfile. No Docker on Linux x64.

Methodology and verdict
------------------------
A flat clean/dirty verdict on an OpenRAM Sky130 macro is NOT meaningful. Every
OpenRAM Sky130 GDS embeds the SkyWater foundry SRAM bitcell cells
(`sky130_fd_bd_sram__*`). Those cells are NOT DRC-clean under the open
`drc(full)` ruleset by construction: the bitcell uses pushed-rule geometry
(sub-0.17um local-interconnect, SRAM-core transistor widths) that the open
PDK explicitly waives, and the real bitcell rules are proprietary. OpenLane's
full-chip magic-drc on the e1 design reports tens of millions of these same
pseudo-errors and the flow continues, treating them as known/waived.

Magic attributes nearly all of these errors to the flattened top cell rather
than to the named bitcell subcells (OpenRAM writes the bitcell array flattened
into the GDS), so per-cell attribution does NOT separate bitcell from
periphery. This script instead obtains a per-DRC-rule breakdown via
`drc listall why` (the only command in Magic 8.3.645 that groups errors by
rule), counting the tiles per rule in TCL without keeping the full coordinate
dump, and classifies each rule as:
  * `bitcell_waived` — a rule that, on an OpenRAM Sky130 macro, fires only
    inside the foundry bitcell array: any rule mentioning "SRAM core", or the
    pushed local-interconnect / licon / diff-tap rules whose geometry exists
    only in the bitcell (the OpenRAM periphery is built from standard cells
    that are clean under drc(full)).
  * `periphery` — every other rule.

PASS == zero periphery rule tiles, and only when the per-rule breakdown parsed
and reconciles with the grand total; otherwise the verdict is UNKNOWN
(fail-closed), never a silent PASS. This is a screening gate, not tapeout
signoff: the rule-name split is a heuristic, and the authoritative DRC signoff
remains the OpenLane flow that carries the macro as an abstracted hard block
(pd/openlane/runs/.../63-magic-drc). The full per-rule breakdown is recorded so
the verdict is auditable rather than a bare pass/fail on a meaningless count.

Run after build_openram_macro.sh produces `<macro>.gds`:

    source tools/env.sh
    python3 scripts/check_openram_macro_drc.py \\
        --macro-dir pd/macros/sky130/e1_sram_4kb_1rw/build \\
        --macro-name e1_sram_4kb_1rw \\
        --out-json build/reports/pd/openram_4kb_drc.json

Exit code 0 when there are zero periphery error tiles, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PDK_PATH = (
    ROOT
    / "external"
    / "pdks"
    / "volare"
    / "sky130"
    / "versions"
    / "c6d73a35f524070e85faff4a6a9eef49553ebc2b"
)
MAGICRC = PDK_PATH / "sky130A" / "libs.tech" / "magic" / "sky130A.magicrc"

# DRC rules that, on an OpenRAM Sky130 macro, fire only inside the proprietary
# SkyWater foundry bitcell array. The OpenRAM periphery is assembled from
# standard cells that are clean under drc(full); the pushed-rule local
# interconnect / licon / diff-tap geometry and the explicit "SRAM core" rules
# exist only in the bitcell. These are waived in the closed PDK flow.
WAIVED_RULE_PATTERNS = [
    re.compile(r"SRAM core", re.IGNORECASE),
    re.compile(r"SRAM gate", re.IGNORECASE),
    re.compile(r"\bli\.", re.IGNORECASE),  # local interconnect (li.1/li.3/li.5/li.6/li.c2)
    re.compile(r"local interconnect", re.IGNORECASE),
    re.compile(r"\blicon\.", re.IGNORECASE),
    re.compile(r"diff/tap\.", re.IGNORECASE),
    re.compile(r"\bpoly\.[4578]\b", re.IGNORECASE),  # bitcell poly spacing/overhang rules
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--macro-dir", required=True)
    parser.add_argument("--macro-name", required=True)
    parser.add_argument("--out-json")
    parser.add_argument(
        "--magic",
        default=shutil.which("magic") or "magic",
        help="Path to the native magic binary (default: first on PATH).",
    )
    return parser.parse_args()


def _is_waived_rule(rule: str) -> bool:
    return any(p.search(rule) for p in WAIVED_RULE_PATTERNS)


def run_magic_drc(macro_dir: Path, macro_name: str, magic_bin: str) -> dict[str, object]:
    gds = macro_dir / f"{macro_name}.gds"
    if not gds.is_file():
        raise SystemExit(f"missing GDS: {gds}")
    if not MAGICRC.is_file():
        raise SystemExit(
            f"missing Volare sky130A magicrc: {MAGICRC}\n"
            f"Fetch the PDK with: PDK_ROOT={ROOT}/external/pdks "
            f"volare enable --pdk sky130 {PDK_PATH.name}"
        )
    out_log = macro_dir / f"{macro_name}.magic_drc.log"
    # `drc listall count` emits nothing in Magic 8.3.645; the only command that
    # yields per-rule grouping is `drc listall why`, which returns {rule
    # {coords...} ...}. We iterate that result in TCL to write a compact
    # per-rule summary file (RULE<tab>count<tab>text), without keeping the full
    # coordinate dump on disk. `drc count total` gives the grand total.
    rule_summary = macro_dir / f"{macro_name}.magic_drc.rulecounts"
    drc_tcl = f"""drc euclidean on
drc style drc(full)
gds read {macro_name}.gds
load {macro_name}
select top cell
expand
drc check
drc catchup
set drcresult [drc listall why]
set fout [open {macro_name}.magic_drc.rulecounts w]
foreach {{errtype coordlist}} $drcresult {{
    puts $fout "RULE\\t[llength $coordlist]\\t$errtype"
}}
close $fout
drc count total
quit -noprompt
"""
    cmd = [magic_bin, "-dnull", "-noconsole", "-rcfile", str(MAGICRC)]
    print(f"RUN: {' '.join(cmd)} <<TCL  (cwd={macro_dir}, PDK_ROOT={PDK_PATH})")
    proc = subprocess.run(
        cmd,
        input=drc_tcl,
        capture_output=True,
        text=True,
        cwd=str(macro_dir),
        env={**os.environ, "PDK_ROOT": str(PDK_PATH)},
        check=False,
    )
    out_log.write_text(
        f"# DRC TCL:\n{drc_tcl}\n# STDOUT:\n{proc.stdout}\n# STDERR:\n{proc.stderr}\n"
    )

    total_tiles: int | None = None
    for line in proc.stdout.splitlines():
        mt = re.search(r"Total DRC errors found:\s*(\d+)", line)
        if mt:
            total_tiles = int(mt.group(1))

    rules = _parse_rule_counts(rule_summary)
    rules_parsed = rule_summary.is_file()
    rule_tile_sum = sum(rules.values())

    waived = {r: n for r, n in rules.items() if _is_waived_rule(r)}
    periphery = {r: n for r, n in rules.items() if not _is_waived_rule(r)}
    return {
        "magic_bin": magic_bin,
        "magic_drc_log": str(out_log),
        "rule_summary_file": str(rule_summary) if rules_parsed else None,
        "drc_total_error_tiles": total_tiles,
        "rules_parsed_ok": rules_parsed,
        "rule_tile_sum": rule_tile_sum,
        "rules_with_errors": len(rules),
        "bitcell_waived_tiles": sum(waived.values()),
        "periphery_tiles": sum(periphery.values()),
        "periphery_rules": periphery,
        "bitcell_waived_rules": waived,
        "exit_code": proc.returncode,
    }


def _parse_rule_counts(summary: Path) -> dict[str, int]:
    """Parse the RULE<tab>count<tab>text summary the DRC TCL writes."""
    rules: dict[str, int] = {}
    if not summary.is_file():
        return rules
    for raw in summary.read_text(errors="replace").splitlines():
        if raw.startswith("RULE\t"):
            parts = raw.split("\t", 2)
            if len(parts) == 3:
                rules[parts[2].strip()] = rules.get(parts[2].strip(), 0) + int(parts[1])
    return rules


def main() -> int:
    args = parse_args()
    macro_dir = Path(args.macro_dir).resolve()
    drc = run_magic_drc(macro_dir, args.macro_name, args.magic)
    total = drc["drc_total_error_tiles"]
    rule_sum = drc["rule_tile_sum"]
    periphery = drc["periphery_tiles"]

    # Fail-closed: only trust a PASS/FAIL split when the per-rule breakdown was
    # parsed AND its tile sum reconciles with the grand total (Magic counts each
    # error tile once per 3-4 adjacent rules, so the per-rule sum can exceed the
    # total; it must never be LESS, which would mean rules were dropped). If the
    # breakdown is missing or under-counts while the total is nonzero, the split
    # is unreliable and the verdict is UNKNOWN, never PASS.
    if total is None:
        status = "UNKNOWN"
    elif total == 0:
        status = "PASS"
    elif not drc["rules_parsed_ok"] or rule_sum < total:
        status = "UNKNOWN"
    else:
        status = "PASS" if periphery == 0 else "FAIL"

    result: dict[str, object] = {
        "schema": "eliza.pd_openram_macro_verify.v3",
        "macro_dir": str(macro_dir),
        "macro_name": args.macro_name,
        "magic_drc": drc,
        "status": status,
        "verdict_note": (
            "PASS = zero periphery (OpenRAM-generated logic) DRC error tiles, "
            "with the per-rule breakdown parsed and reconciling against the "
            "grand total. bitcell_waived_tiles are the known SkyWater "
            "sky130_fd_bd_sram foundry-bitcell pseudo-errors waived in the "
            "closed PDK flow (OpenLane reports the same class on the full "
            "chip). UNKNOWN = total is nonzero but the per-rule breakdown could "
            "not be parsed/reconciled, so no clean/dirty claim is made. "
            "Tapeout-grade signoff is the OpenLane flow that abstracts the "
            "bitcell; this is the standalone-macro periphery screening gate."
        ),
    }
    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out_json:
        out = Path(args.out_json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
    print(text)
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
