#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_per_layer_vector_codegen.json"

WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
VECTOR_TEMPLATE = ROOT / "build/reports/e1x_vector_kernel_template.json"
LOOP_SKELETON = ROOT / "build/reports/e1x_looped_vector_kernel_skeleton.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def build_codegen_records(
    workplan: dict, template: dict, skeleton: dict
) -> tuple[list[dict], list[str]]:
    template_summary = template.get("summary", {})
    skeleton_summary = skeleton.get("summary", {})
    template_words = int(template_summary.get("template_instruction_words", 0))
    skeleton_words = int(skeleton_summary.get("skeleton_instruction_words", 0))
    template_sha = str(template_summary.get("template_sha256", ""))
    skeleton_sha = str(skeleton_summary.get("skeleton_sha256", ""))
    records: list[dict] = []
    mismatches: list[str] = []
    for layer in workplan.get("summary", {}).get("sampled_workplan_records", []):
        # The workplan report intentionally stores only a sample; use it for
        # smoke coverage but require the aggregate counts from the report below.
        if not isinstance(layer, dict):
            mismatches.append("malformed-sampled-layer")
            continue
    full_records = workplan.get("summary", {}).get("all_workplan_records")
    if full_records is None:
        # Older workplan reports expose only sampled records. Reconstruct full
        # records from the workplan evidence is deliberately not hidden here:
        # this gate requires the compact full record list to make per-layer
        # codegen auditable.
        mismatches.append("missing-all_workplan_records")
        return records, mismatches
    for layer in full_records:
        if not isinstance(layer, dict):
            mismatches.append("malformed-layer")
            continue
        layer_index = int(layer.get("layer_index", -1))
        rows = int(layer.get("rows", 0))
        vector_word_ops = int(layer.get("vector_word_ops", 0))
        if rows <= 0 or vector_word_ops <= 0:
            mismatches.append(f"empty-layer:{layer_index}")
        # Skeleton has four inner-loop control words per vector op and three
        # outer-loop/control words per output row, matching the skeleton gate.
        loop_control_words = vector_word_ops * 4 + rows * 3
        template_body_words = vector_word_ops * template_words
        total_words = loop_control_words + template_body_words
        record = {
            "layer_index": layer_index,
            "layer_name": str(layer.get("layer_name", "")),
            "kind": str(layer.get("kind", "")),
            "routing_color": int(layer.get("routing_color", -1)),
            "rows": rows,
            "cols": int(layer.get("cols", 0)),
            "assigned_cores": int(layer.get("assigned_cores", 0)),
            "vector_word_ops": vector_word_ops,
            "template_body_words": template_body_words,
            "loop_control_words": loop_control_words,
            "total_kernel_words": total_words,
            "template_sha256": template_sha,
            "skeleton_sha256": skeleton_sha,
            "max_core_shard_bytes": int(layer.get("max_core_shard_bytes", 0)),
            "usable_bytes_per_core": int(layer.get("usable_bytes_per_core", 0)),
        }
        records.append(record)
    if template_words != 54:
        mismatches.append("template-word-count")
    if skeleton_words != 11:
        mismatches.append("skeleton-word-count")
    return records, mismatches


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (WORKPLAN, VECTOR_TEMPLATE, LOOP_SKELETON)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "per-layer vector-codegen inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_per_layer_vector_codegen_inputs_present", "status": status, "detail": detail}
    )

    workplan = load_json(WORKPLAN) if WORKPLAN.is_file() else {}
    template = load_json(VECTOR_TEMPLATE) if VECTOR_TEMPLATE.is_file() else {}
    skeleton = load_json(LOOP_SKELETON) if LOOP_SKELETON.is_file() else {}

    deps_ok = (
        workplan.get("status") == "PASS"
        and template.get("status") == "PASS"
        and skeleton.get("status") == "PASS"
    )
    status, detail = pass_fail(
        deps_ok,
        "full-output workplan, vector template, and loop skeleton reports are PASS",
        "dependency report missing or failing",
    )
    checks.append(
        {"id": "e1x_per_layer_vector_codegen_dependencies_pass", "status": status, "detail": detail}
    )

    records, mismatches = build_codegen_records(workplan, template, skeleton)
    total_template_words = sum(int(record["template_body_words"]) for record in records)
    total_loop_words = sum(int(record["loop_control_words"]) for record in records)
    total_kernel_words = sum(int(record["total_kernel_words"]) for record in records)
    codegen_sha256 = canonical_sha256(records)
    colors = {int(record["routing_color"]) for record in records}
    aggregate_ok = (
        not mismatches
        and len(records) == 283
        and total_template_words == 87_876_679_680
        and total_loop_words == 6_517_209_600
        and total_kernel_words == 94_393_889_280
        and len(colors) == 24
    )
    status, detail = pass_fail(
        aggregate_ok,
        f"per-layer vector codegen records cover {len(records)} layers and {total_kernel_words} estimated words",
        "per-layer vector codegen mismatch: " + ", ".join(mismatches[:8]),
    )
    checks.append(
        {
            "id": "e1x_per_layer_vector_codegen_records_cover_workplan",
            "status": status,
            "detail": detail,
        }
    )

    sram_ok = bool(records) and all(
        int(record["max_core_shard_bytes"]) <= int(record["usable_bytes_per_core"])
        for record in records
    )
    status, detail = pass_fail(
        sram_ok,
        "per-layer vector codegen records preserve per-core SRAM fit",
        "per-layer vector codegen record exceeds usable SRAM",
    )
    checks.append(
        {
            "id": "e1x_per_layer_vector_codegen_preserves_sram_fit",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "codegen_layer_count": len(records),
        "template_body_instruction_estimate": total_template_words,
        "loop_control_instruction_estimate": total_loop_words,
        "total_kernel_instruction_estimate": total_kernel_words,
        "routing_color_count": len(colors),
        "per_layer_codegen_sha256": codegen_sha256,
        "template_sha256": str(template.get("summary", {}).get("template_sha256", "")),
        "skeleton_sha256": str(skeleton.get("summary", {}).get("skeleton_sha256", "")),
        "sampled_codegen_records": records[:8],
        "residual_blocker": "full_output_vector_kernel_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-per-layer-vector-codegen",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Per-layer vector-kernel codegen metadata combining the full-output "
            "workplan, concrete vector-word template, and loop skeleton for every "
            "scheduled layer. This is deterministic codegen accounting, not RTL/PE "
            "execution of every generated instruction and not a full-output checksum."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_vector_kernel_template.json",
            "build/reports/e1x_looped_vector_kernel_skeleton.json",
            "scripts/check_e1x_per_layer_vector_codegen.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X per-layer vector codegen failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X per-layer vector codegen; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
