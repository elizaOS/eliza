#!/usr/bin/env python3
"""Build or check the BPU workload-trace provenance manifest.

The large ``external/workload-traces/*.btrace.json`` files are intentionally
kept out of git. This manifest is the committed, hash-checked index that says
which RV64 QEMU traces were present for the latest branch-prediction evidence,
which coverage buckets they exercise, and which production-class external
trace suites are still missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
TRACE_DIR = ROOT / "external/workload-traces"
DEFAULT_MANIFEST = ROOT / "docs/evidence/cpu_ap/bpu-workload-trace-manifest.json"
SCHEMA = "eliza.bpu_workload_trace_manifest.v1"

REQUIRED_LOCAL_TRACES = {
    "agent_decode",
    "agent_loop",
    "audio_frames",
    "browser_layout_proxy",
    "build_compiler_proxy",
    "compression_proxy",
    "crypto_packet_proxy",
    "database_btree_proxy",
    "file_tlv",
    "gc_runtime_proxy",
    "gpu_irq_fence_scheduler_proxy",
    "gpu_control_proxy",
    "gpu_memory_residency_proxy",
    "http_parser",
    "kernel_syscall_proxy",
    "mobile_ui_frame_scheduler_proxy",
    "nn_delegate_fallback_proxy",
    "text_log",
    "video_blocks",
    "wasm_jit_osr_proxy",
}

PRODUCTION_EXTERNAL_SUITES = [
    {
        "name": "spec2017_intrate",
        "status": "missing_external_trace",
        "required_for_claims": ["spec2017_claim", "workload_mpki_claim"],
        "missing_dependency": "SPEC CPU2017 license and RV64 executable traces",
    },
    {
        "name": "aosp_system_server_and_launcher",
        "status": "missing_external_trace",
        "required_for_claims": ["android_claim", "workload_mpki_claim"],
        "missing_dependency": "AOSP/Cuttlefish RV64 system-server, launcher, and app traces",
    },
    {
        "name": "browser_js_engine",
        "status": "missing_external_trace",
        "required_for_claims": ["v8_claim", "workload_mpki_claim"],
        "missing_dependency": "JetStream/Speedometer-class RV64 browser and JS-engine traces",
    },
    {
        "name": "production_gpu_driver_runtime",
        "status": "missing_external_trace",
        "required_for_claims": ["workload_mpki_claim"],
        "missing_dependency": "real mobile GPU driver/runtime command submission traces",
    },
]
REQUIRED_PRODUCTION_EXTERNAL_SUITE_NAMES = {suite["name"] for suite in PRODUCTION_EXTERNAL_SUITES}


def sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_json_metadata_before_branches(path: Path) -> dict[str, Any]:
    """Parse the top-level metadata without materialising the huge branch list."""
    marker = b'"branches"'
    buf = bytearray()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                raise ValueError(f"{path} does not contain a branches field")
            buf.extend(chunk)
            idx = buf.find(marker)
            if idx >= 0:
                prefix = bytes(buf[:idx]).rstrip()
                # The file is a flat object and branches is the final field.
                # Remove the comma before "branches" and close the object.
                if prefix.endswith(b","):
                    prefix = prefix[:-1]
                return json.loads(prefix + b"}")


def _coverage_buckets(name: str, source: dict[str, Any]) -> list[str]:
    buckets: set[str] = {"qemu_rv64"}
    src = str(source.get("src", ""))
    mode = source.get("mode")
    if name.startswith("agent_"):
        buckets.add("agent_runtime")
    if src == "io_stream.c":
        buckets.add("io_media")
    if src == "system_mix.c":
        buckets.add("system_mix_proxy")
    if "gpu" in name:
        buckets.add("gpu_control_proxy")
    if "nn_delegate" in name:
        buckets.add("ml_runtime_proxy")
    if "mobile_ui" in name:
        buckets.add("android_ui_proxy")
    if "wasm" in name:
        buckets.add("browser_js_proxy")
    if "browser" in name:
        buckets.add("browser_layout_proxy")
    if "crypto" in name or "compression" in name:
        buckets.add("data_plane")
    if "kernel" in name or "gc_" in name:
        buckets.add("runtime_os")
    if mode is not None:
        buckets.add(f"mode_{mode}")
    return sorted(buckets)


def build_manifest() -> dict[str, Any]:
    traces = []
    for path in sorted(TRACE_DIR.glob("*.btrace.json")):
        meta = _read_json_metadata_before_branches(path)
        name = path.name[: -len(".btrace.json")]
        source = meta.get("source") if isinstance(meta.get("source"), dict) else {}
        branch_count = int(meta.get("branch_count", 0))
        instruction_count = int(meta.get("instruction_count", 0))
        class_counts = (
            meta.get("class_counts") if isinstance(meta.get("class_counts"), dict) else {}
        )
        traces.append(
            {
                "name": name,
                "filename": path.name,
                "schema": meta.get("schema"),
                "bytes": path.stat().st_size,
                "sha256": sha256_path(path),
                "instruction_count": instruction_count,
                "branch_count": branch_count,
                "class_counts": class_counts,
                "source": source,
                "coverage_buckets": _coverage_buckets(name, source),
                "full_trace_available": branch_count > 0,
                "trace_class": "qemu_rv64_workload",
            }
        )

    names = {trace["name"] for trace in traces}
    missing_required = sorted(REQUIRED_LOCAL_TRACES - names)
    present_required = sorted(REQUIRED_LOCAL_TRACES & names)
    return {
        "schema": SCHEMA,
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "trace_dir": "external/workload-traces",
        "evidence_class": "qemu_rv64_workload_trace_manifest",
        "claim_boundary": (
            "Local QEMU-RV64 workload-trace provenance only. This manifest does "
            "not satisfy SPEC2017, AOSP, browser/JS, or production GPU MPKI claims."
        ),
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "required_local_trace_names": sorted(REQUIRED_LOCAL_TRACES),
        "present_required_local_trace_names": present_required,
        "missing_required_local_trace_names": missing_required,
        "production_external_suites": PRODUCTION_EXTERNAL_SUITES,
        "trace_count": len(traces),
        "total_instruction_count": sum(int(t["instruction_count"]) for t in traces),
        "total_branch_count": sum(int(t["branch_count"]) for t in traces),
        "traces": traces,
    }


def validate_manifest(manifest: dict[str, Any], failures: list[str]) -> None:
    if manifest.get("schema") != SCHEMA:
        failures.append(f"schema must be {SCHEMA}")
    if manifest.get("trace_dir") != "external/workload-traces":
        failures.append("trace_dir must be external/workload-traces")
    if manifest.get("phone_claim_allowed") is not False:
        failures.append("phone_claim_allowed must be false")
    if manifest.get("release_claim_allowed") is not False:
        failures.append("release_claim_allowed must be false")
    missing = manifest.get("missing_required_local_trace_names")
    if missing != []:
        failures.append("missing required local traces: " + ", ".join(missing or []))
    traces = manifest.get("traces")
    if not isinstance(traces, list) or not traces:
        failures.append("traces must be a non-empty list")
        return
    seen: set[str] = set()
    for index, trace in enumerate(traces):
        if not isinstance(trace, dict):
            failures.append(f"traces[{index}] must be an object")
            continue
        name = trace.get("name")
        filename = trace.get("filename")
        prefix = f"traces[{index}]"
        if not isinstance(name, str) or not name:
            failures.append(f"{prefix}.name must be non-empty")
            continue
        if name in seen:
            failures.append(f"{prefix}.name duplicates {name}")
        seen.add(name)
        if not isinstance(filename, str) or filename != f"{name}.btrace.json":
            failures.append(f"{prefix}.filename must be {name}.btrace.json")
            continue
        path = TRACE_DIR / filename
        if not path.is_file():
            failures.append(f"{prefix} missing trace file {path.relative_to(ROOT)}")
            continue
        if trace.get("bytes") != path.stat().st_size:
            failures.append(f"{prefix}.bytes does not match staged trace")
        if trace.get("sha256") != sha256_path(path):
            failures.append(f"{prefix}.sha256 does not match staged trace")
        for field in ("instruction_count", "branch_count"):
            if not isinstance(trace.get(field), int) or int(trace[field]) <= 0:
                failures.append(f"{prefix}.{field} must be a positive integer")
        if trace.get("trace_class") != "qemu_rv64_workload":
            failures.append(f"{prefix}.trace_class must be qemu_rv64_workload")

    suites = manifest.get("production_external_suites")
    if not isinstance(suites, list):
        failures.append("production_external_suites must enumerate blocked external suites")
    else:
        seen_suites: set[str] = set()
        expected_by_name = {suite["name"]: suite for suite in PRODUCTION_EXTERNAL_SUITES}
        for suite in suites:
            if not isinstance(suite, dict):
                failures.append("production_external_suites entries must be objects")
                continue
            name = suite.get("name")
            if not isinstance(name, str) or not name:
                failures.append("production_external_suites entries must have names")
                continue
            if name in seen_suites:
                failures.append(f"external suite {name} is duplicated")
            seen_suites.add(name)
            expected = expected_by_name.get(name)
            if expected is None:
                failures.append(f"external suite {name} is not required by this gate")
                continue
            if suite.get("status") != "missing_external_trace":
                failures.append(f"external suite {name} must remain missing_external_trace")
            if set(suite.get("required_for_claims", [])) != set(expected["required_for_claims"]):
                failures.append(f"external suite {name} required_for_claims drifted")
            missing_dependency = suite.get("missing_dependency")
            if not isinstance(missing_dependency, str) or not missing_dependency.strip():
                failures.append(f"external suite {name} missing_dependency must stay non-empty")
        missing = sorted(REQUIRED_PRODUCTION_EXTERNAL_SUITE_NAMES - seen_suites)
        extra = sorted(seen_suites - REQUIRED_PRODUCTION_EXTERNAL_SUITE_NAMES)
        if missing:
            failures.append(f"production_external_suites missing required suites: {missing}")
        if extra:
            failures.append(f"production_external_suites has unexpected suites: {extra}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--check", action="store_true", help="validate an existing manifest")
    args = ap.parse_args()

    if args.check:
        try:
            manifest = json.loads(args.output.read_text(encoding="utf-8"))
        except FileNotFoundError:
            print(
                f"STATUS: BLOCKED bpu.workload_trace_manifest - missing {args.output}",
                file=sys.stderr,
            )
            return 2
    else:
        manifest = build_manifest()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    failures: list[str] = []
    validate_manifest(manifest, failures)
    if failures:
        for failure in failures:
            print(f"BLOCKED: {failure}", file=sys.stderr)
        print(f"STATUS: BLOCKED bpu.workload_trace_manifest - {args.output}")
        return 2
    print(
        "STATUS: PASS bpu.workload_trace_manifest - "
        f"{manifest.get('trace_count')} traces, "
        f"{manifest.get('total_branch_count')} branches"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
