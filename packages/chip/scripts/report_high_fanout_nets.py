#!/usr/bin/env python3
import json
import re
import sys
from argparse import ArgumentParser
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LARGE_NET_RE = re.compile(r"\[DRT-0120\]\s+Large net\s+(\S+)\s+has\s+(\d+)\s+pins")
INSTANCE_RE = re.compile(
    r"^\s*([A-Za-z0-9_$\\.\[\]:]+)\s+([A-Za-z0-9_$\\.\[\]:]+)\s*\((.*?)\);\s*$",
    re.MULTILINE | re.DOTALL,
)
CONNECTION_RE = re.compile(r"\.([A-Za-z0-9_$\\]+)\s*\(\s*([^)]+?)\s*\)")
OUTPUT_PORTS = {"X", "Y", "Q", "Q_N", "LO", "HI", "COUT"}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def newest_run() -> Path:
    run_root = ROOT / "pd/openlane/runs"
    runs = sorted((path for path in run_root.glob("RUN_*") if path.is_dir()), key=lambda p: p.name)
    if not runs:
        raise SystemExit("no OpenLane run directories found under pd/openlane/runs")
    return runs[-1]


def read_large_net_warnings(run: Path) -> dict[str, int]:
    warnings: dict[str, int] = {}
    for path in [run / "warning.log", *run.glob("*detailedrouting*/openroad-detailedrouting.log")]:
        if not path.is_file():
            continue
        for match in LARGE_NET_RE.finditer(path.read_text(errors="replace")):
            warnings[match.group(1)] = int(match.group(2))
    return warnings


def parse_verilog_net_pins(netlist: Path) -> dict[str, list[dict[str, str]]]:
    text = netlist.read_text(errors="replace")
    pins: dict[str, list[dict[str, str]]] = defaultdict(list)
    for match in INSTANCE_RE.finditer(text):
        cell_type, inst_name, body = match.groups()
        for port, net_expr in CONNECTION_RE.findall(body):
            net = net_expr.strip()
            if not net or "'" in net or "{" in net or "," in net:
                continue
            direction = "driver" if port in OUTPUT_PORTS else "load"
            pins[net].append(
                {
                    "instance": inst_name,
                    "cell_type": cell_type,
                    "port": port,
                    "direction": direction,
                }
            )
    return pins


def classify_net(name: str, pins: list[dict[str, str]]) -> tuple[str, str]:
    ports = Counter(pin["port"] for pin in pins)
    cells = Counter(pin["cell_type"] for pin in pins)
    if ports.get("RESET_B", 0) or "rst" in name.lower() or "reset" in name.lower():
        return (
            "reset_distribution",
            "Large routed reset branch. Likely driven by rst_n_sync through OpenROAD-inserted max-cap buffers.",
        )
    if ports.get("CLK", 0) or "clk" in name.lower():
        return (
            "clock_distribution",
            "Clock-tree distribution; should be handled by CTS, not by data-net fanout fixes.",
        )
    if ports.get("DIODE", 0) and cells.get("sky130_fd_sc_hd__diode_2", 0):
        return (
            "antenna_diode_load",
            "Net includes antenna diode pins; count may be inflated by route repair, but still consumes routing resources.",
        )
    if name.startswith("mmio_wdata"):
        return (
            "mmio_write_data_fanout",
            "Debug/MMIO write-data bit fans into many register write enables or mux terms.",
        )
    if name.startswith("$abc") or name.startswith("_"):
        return (
            "synthesis_generated_logic",
            "ABC-generated combinational net. Use synthesis JSON source context and downstream cell names to localize.",
        )
    return ("data_or_control", "Ordinary data/control net; inspect sink pins and source context.")


def load_synthesis_fanout(json_path: Path, threshold: int) -> list[dict[str, object]]:
    if not json_path.is_file():
        return []
    design = json.loads(json_path.read_text())
    module = design["modules"].get("e1_chip_top")
    if module is None:
        return []

    bit_names: dict[int, list[str]] = defaultdict(list)
    bit_srcs: dict[int, list[str]] = defaultdict(list)
    for name, net in module.get("netnames", {}).items():
        src = net.get("attributes", {}).get("src", "")
        for bit in net.get("bits", []):
            if isinstance(bit, int):
                bit_names[bit].append(name)
                if src:
                    bit_srcs[bit].append(src)

    loads: Counter[int] = Counter()
    sample_sinks: dict[int, list[str]] = defaultdict(list)
    drivers: Counter[int] = Counter()
    for cell_name, cell in module.get("cells", {}).items():
        directions = cell.get("port_directions", {})
        for port, bits in cell.get("connections", {}).items():
            direction = directions.get(port)
            for bit in bits:
                if not isinstance(bit, int):
                    continue
                if direction in {"input", "inout"}:
                    loads[bit] += 1
                    if len(sample_sinks[bit]) < 6:
                        sample_sinks[bit].append(f"{cell_name}.{port}")
                if direction in {"output", "inout"}:
                    drivers[bit] += 1

    rows = []
    for bit, load_count in loads.most_common():
        if load_count < threshold:
            break
        names = sorted(
            bit_names.get(bit, [str(bit)]), key=lambda name: (name.startswith("$"), len(name), name)
        )
        srcs = sorted(set(bit_srcs.get(bit, [])))
        kind, note = classify_net(names[0], [])
        rows.append(
            {
                "net": names[0],
                "aliases": names[1:5],
                "load_pins": load_count,
                "driver_pins": drivers[bit],
                "source": srcs[0] if srcs else "",
                "sample_sinks": sample_sinks[bit],
                "classification": kind,
                "note": note,
            }
        )
    return rows


def find_default_paths(run: Path) -> tuple[Path, Path]:
    netlist_candidates = [
        run / "final/nl/e1_chip_top.nl.v",
        *sorted(run.glob("*detailedrouting*/e1_chip_top.nl.v"), reverse=True),
    ]
    json_candidates = [
        run / "06-yosys-synthesis/e1_chip_top.nl.v.json",
        *sorted(run.glob("*/e1_chip_top.nl.v.json"), reverse=True),
    ]
    netlist = next((path for path in netlist_candidates if path.is_file()), None)
    synth_json = next((path for path in json_candidates if path.is_file()), None)
    if netlist is None:
        raise SystemExit(f"no routed/final e1_chip_top netlist found under {rel(run)}")
    if synth_json is None:
        raise SystemExit(f"no synthesis JSON found under {rel(run)}")
    return netlist, synth_json


def render_markdown(
    run: Path,
    netlist: Path,
    synth_json: Path,
    routed_rows: list[dict],
    synth_rows: list[dict],
    threshold: int,
) -> str:
    lines = [
        "# High-Fanout Routing Pressure Report",
        "",
        f"- Run: `{rel(run)}`",
        f"- Routed netlist: `{rel(netlist)}`",
        f"- Synthesis JSON: `{rel(synth_json)}`",
        f"- Reporting threshold: `{threshold}` load pins",
        "",
        "## Routed Large-Net Warnings",
        "",
    ]
    if routed_rows:
        lines.extend(
            [
                "| Net | Router pins | Parsed pins | Loads | Drivers | Dominant ports | Classification | Likely RTL / action |",
                "|---|---:|---:|---:|---:|---|---|---|",
            ]
        )
        for row in routed_rows:
            dominant_ports = ", ".join(f"{name}:{count}" for name, count in row["ports"][:5])
            lines.append(
                "| {net} | {router_pins} | {parsed_pins} | {loads} | {drivers} | {dominant_ports} | {classification} | {note} |".format(
                    **row, dominant_ports=dominant_ports.replace("|", "\\|")
                )
            )
    else:
        lines.append("No `[DRT-0120] Large net` warnings were found in the selected run logs.")

    lines.extend(
        [
            "",
            "## Synthesis-Level Fanout Hotspots",
            "",
            "| Net | Load pins | Drivers | Source | Classification | Sample sinks |",
            "|---|---:|---:|---|---|---|",
        ]
    )
    for row in synth_rows[:40]:
        sample = "<br>".join(row["sample_sinks"])
        source = row["source"] or "generated/no source attribute"
        lines.append(
            f"| `{row['net']}` | {row['load_pins']} | {row['driver_pins']} | `{source}` | {row['classification']} | `{sample}` |"
        )

    lines.extend(
        [
            "",
            "## Workstream Assignments",
            "",
            "1. Reset tree subagent: replace the single SoC reset distribution with module-local reset branches or a PD reset-tree strategy, then rerun OpenLane and confirm no `[DRT-0120]` reset net remains.",
            "2. MMIO/data fanout subagent: reduce write-data broadcast pressure by staging debug MMIO write data near register banks or by narrowing decoded write strobes per target.",
            "3. NPU/generated-logic subagent: inspect ABC-generated hotspots without source attributes, correlate sink clusters to `rtl/npu/e1_npu.sv`, and split wide mux/decode cones if they remain above threshold after reset fixes.",
            "4. PD constraints subagent: evaluate OpenROAD reset buffering constraints or custom post-synthesis repair scripts before declaring RTL-level reset replication necessary.",
            "",
            "## Notes",
            "",
            "- Clock fanout is reported separately and should be handled by CTS.",
            "- This report is diagnostic evidence, not release signoff. A clean route still needs antenna, STA/DRV, LVS/DRC, and full signoff gates closed.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = ArgumentParser(description="Report high-fanout OpenLane nets and likely RTL sources.")
    parser.add_argument(
        "--run", type=Path, default=None, help="OpenLane run directory; defaults to newest RUN_*"
    )
    parser.add_argument(
        "--threshold", type=int, default=100, help="load-pin threshold for synthesis report"
    )
    parser.add_argument("--output", type=Path, default=None, help="write markdown report")
    parser.add_argument(
        "--json-output", type=Path, default=None, help="write machine-readable JSON report"
    )
    args = parser.parse_args()

    run = args.run if args.run is not None else newest_run()
    if not run.is_absolute():
        run = ROOT / run
    if not run.is_dir():
        raise SystemExit(f"run directory does not exist: {run}")
    netlist, synth_json = find_default_paths(run)

    large_warnings = read_large_net_warnings(run)
    parsed_pins = parse_verilog_net_pins(netlist)
    routed_rows = []
    for net, router_pins in sorted(large_warnings.items(), key=lambda item: (-item[1], item[0])):
        pins = parsed_pins.get(net, [])
        ports = Counter(pin["port"] for pin in pins).most_common()
        drivers = sum(1 for pin in pins if pin["direction"] == "driver")
        loads = sum(1 for pin in pins if pin["direction"] == "load")
        classification, note = classify_net(net, pins)
        routed_rows.append(
            {
                "net": net,
                "router_pins": router_pins,
                "parsed_pins": len(pins),
                "loads": loads,
                "drivers": drivers,
                "ports": ports,
                "classification": classification,
                "note": note,
            }
        )

    synth_rows = load_synthesis_fanout(synth_json, args.threshold)
    report = {
        "run": rel(run),
        "netlist": rel(netlist),
        "synthesis_json": rel(synth_json),
        "threshold": args.threshold,
        "routed_large_net_warnings": routed_rows,
        "synthesis_high_fanout": synth_rows,
    }

    markdown = render_markdown(run, netlist, synth_json, routed_rows, synth_rows, args.threshold)
    if args.output:
        output = args.output if args.output.is_absolute() else ROOT / args.output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(markdown)
    else:
        print(markdown, end="")
    if args.json_output:
        output = args.json_output if args.json_output.is_absolute() else ROOT / args.json_output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
