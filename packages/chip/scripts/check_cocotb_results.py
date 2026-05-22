#!/usr/bin/env python3
import hashlib
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from argparse import ArgumentParser
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RESULT = ROOT / "verify/cocotb/results.xml"
REPORT_DIR = ROOT / "build/reports/cocotb"
MANIFEST = REPORT_DIR / "manifest.json"
PIPELINE_TARGETS = {
    "e1_chip_top_test_e1_chip",
    "e1_linux_soc_contract_test_cpu_mem_intc_contract",
    "e1_npu_test_e1_npu",
    "e1_soc_integrated_tb_test_cross_domain_interfaces",
    "e1_tiny_cpu_contract_tb_test_tiny_cpu_execution",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def result_stats(path: Path) -> dict:
    text = path.read_text(errors="ignore")
    failures = sum(int(value) for value in re.findall(r'failures="(\d+)"', text))
    errors = sum(int(value) for value in re.findall(r'errors="(\d+)"', text))
    failure_elements = len(re.findall(r"<failure\b", text))
    error_elements = len(re.findall(r"<error\b", text))
    testcases = len(re.findall(r"<testcase\b", text))
    testcase_names = []
    try:
        root = ET.fromstring(text)
        for case in root.iter("testcase"):
            classname = case.attrib.get("classname", "")
            name = case.attrib.get("name", "")
            testcase_names.append(f"{classname}.{name}".strip("."))
    except ET.ParseError:
        testcase_names = []
    return {
        "testcases": testcases,
        "failures": failures + failure_elements,
        "errors": errors + error_elements,
        "testcase_names": sorted(name for name in testcase_names if name),
    }


def source_hashes(module: str, top: str) -> dict[str, str]:
    candidates = [
        ROOT / "verify/cocotb/Makefile",
        ROOT / f"verify/cocotb/{module}.py",
        ROOT / "scripts/run_cocotb.sh",
        ROOT / "scripts/check_cocotb_results.py",
        ROOT / "compiler/runtime/e1_npu_runtime.py",
    ]
    if top == "e1_tiny_cpu_contract_tb":
        candidates.append(ROOT / "verify/cocotb/e1_tiny_cpu_contract_tb.sv")
    candidates.extend(sorted((ROOT / "rtl").rglob("*.sv")))
    return {str(path.relative_to(ROOT)): sha256(path) for path in candidates if path.is_file()}


def coverage_artifacts(module: str, top: str) -> dict:
    artifacts = {}
    patterns = [
        f"*{module.replace('test_', '')}*cocotb*.json",
        f"*{top}*{module}*.json",
    ]
    for pattern in patterns:
        for path in sorted((ROOT / "build/reports").glob(pattern)):
            if path.is_file():
                rel = str(path.relative_to(ROOT))
                artifacts[rel] = {
                    "sha256": sha256(path),
                    "bytes": path.stat().st_size,
                }
    return artifacts


def contract_boundary(module: str, top: str) -> str:
    if module == "test_e1_npu":
        return "Directed scalar/GEMM scratchpad ABI checks for e1_npu only; no NNAPI, DMA-fed accelerator, model compiler, or performance closure."
    if module == "test_e1_dma":
        return "Directed byte-copy, AXI-Lite backpressure, partial-strobe, and error-path checks for e1_dma only; no coherent DMA or IOMMU coverage."
    if module == "test_e1_display":
        return "Directed XR24 scanout timing/MMIO checks for e1_display only; no DRM/KMS, HDMI/MIPI, compositor, or display PHY coverage."
    if module == "test_cpu_mem_intc_contract":
        return "Directed CPU memory/interrupt-controller contract checks around the tiny stub harness; not evidence for an application-class CPU subsystem."
    if top == "e1_soc_top" or top == "e1_chip_top":
        return "Directed e1-chip scaffold integration smoke only; not phone-class AP, OS boot, cache coherency, or silicon signoff evidence."
    return "Directed cocotb smoke only; not coverage closure or product-class signoff evidence."


def load_manifest() -> dict:
    if MANIFEST.is_file():
        data = json.loads(MANIFEST.read_text())
        if isinstance(data, dict):
            targets = data.get("targets")
            if isinstance(targets, dict):
                data["targets"] = {
                    name: entry for name, entry in targets.items() if name in PIPELINE_TARGETS
                }
            return data
    return {
        "schema": "e1-chip-cocotb-evidence-v1",
        "generated_at_utc": None,
        "targets": {},
    }


def rebuild_manifest_from_archives(manifest: dict) -> dict:
    targets = {}
    existing_targets = manifest.get("targets")
    if not isinstance(existing_targets, dict):
        existing_targets = {}
    for target in sorted(PIPELINE_TARGETS):
        archived = REPORT_DIR / f"{target}.xml"
        entry = existing_targets.get(target)
        if not archived.is_file() or not isinstance(entry, dict):
            continue
        entry = dict(entry)
        entry["result_xml"] = str(archived.relative_to(ROOT))
        entry["result_sha256"] = sha256(archived)
        entry["stats"] = result_stats(archived)
        targets[target] = entry
    manifest["targets"] = targets
    return manifest


def main() -> int:
    parser = ArgumentParser(description="Validate and archive cocotb result XML.")
    parser.add_argument(
        "--result", default=os.environ.get("COCOTB_RESULTS_FILE", str(DEFAULT_RESULT))
    )
    parser.add_argument("--module", default=os.environ.get("COCOTB_MODULE"))
    parser.add_argument("--top", default=os.environ.get("COCOTB_TOPLEVEL"))
    args = parser.parse_args()

    path = Path(args.result)
    if not path.is_file():
        print(f"{path} missing after cocotb run")
        return 1

    stats = result_stats(path)
    if stats["failures"] or stats["errors"] or not stats["testcases"]:
        print(
            "cocotb XML indicates failure: "
            f"testcases={stats['testcases']} failures={stats['failures']} "
            f"errors={stats['errors']}"
        )
        return 1

    if args.module and args.top:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        target = f"{args.top}_{args.module}"
        archived = REPORT_DIR / f"{target}.xml"
        archived.write_bytes(path.read_bytes())

        manifest = rebuild_manifest_from_archives(load_manifest())
        manifest["generated_at_utc"] = datetime.now(UTC).isoformat()
        manifest.setdefault("targets", {})[target] = {
            "top": args.top,
            "module": args.module,
            "result_xml": str(archived.relative_to(ROOT)),
            "result_sha256": sha256(archived),
            "stats": stats,
            "source_hashes": source_hashes(args.module, args.top),
            "coverage_artifacts": coverage_artifacts(args.module, args.top),
            "coverage": {
                "class": "directed_contract_smoke",
                "release_claim": "blocked_without_functional_coverage",
                "summary": contract_boundary(args.module, args.top),
            },
        }
        MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
