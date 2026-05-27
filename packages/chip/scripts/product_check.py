import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

parser = argparse.ArgumentParser()
parser.add_argument(
    "--release", action="store_true", help="fail on fabrication/tapeout release blockers"
)
parser.add_argument(
    "--json",
    action="store_true",
    help="also print the final machine-readable product status report",
)
parser.add_argument(
    "--json-only",
    action="store_true",
    help="print only the final machine-readable product status report",
)
args = parser.parse_args()

REPORT = Path("build/reports/product_release_status.json")
MANUFACTURING_REPORT = Path("build/reports/manufacturing_artifacts.json")
REPO_GENERATION_BUCKETS = (
    "repo_generatable_now",
    "blocked_by_external_evidence",
    "blocked_by_live_hardware",
    "blocked_by_release_approval",
)


def write_report(report: dict) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def emit_json(report: dict) -> None:
    if args.json or args.json_only:
        print(json.dumps(report, indent=2, sort_keys=True))


def should_suppress_human_output() -> bool:
    return bool(args.json_only)


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def command_label(command: list[str]) -> str:
    return " ".join(str(part) for part in command[1:])


def has_blocked_status(stdout: str, stderr: str) -> bool:
    combined = f"{stdout}\n{stderr}"
    return "STATUS: BLOCKED" in combined or "release blocked" in combined.lower()


def is_known_blocked_result(result: subprocess.CompletedProcess[str]) -> bool:
    return result.returncode == 2 or has_blocked_status(result.stdout, result.stderr)


def manufacturing_release_blocker_message() -> str:
    fallback = (
        "Manufacturing package/board/SI/PI/current/thermal evidence is incomplete; "
        "run scripts/check_manufacturing_artifacts.py --release for details"
    )
    if not MANUFACTURING_REPORT.is_file():
        return fallback
    try:
        report = json.loads(MANUFACTURING_REPORT.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return fallback

    summary = report.get("summary", {})
    bucket_counts = summary.get("action_buckets", {})
    artifact_state_counts = summary.get("artifact_state_counts", {})
    if not isinstance(bucket_counts, dict) or not bucket_counts:
        return fallback

    def bucket_count(item: tuple[object, object]) -> int:
        try:
            return int(item[1])
        except (TypeError, ValueError):
            return 0

    ordered = sorted(bucket_counts.items(), key=lambda item: (-bucket_count(item), str(item[0])))
    bucket_text = ", ".join(f"{name}={count}" for name, count in ordered[:5])
    state_text = ""
    if isinstance(artifact_state_counts, dict) and artifact_state_counts:
        ordered_states = sorted(
            artifact_state_counts.items(),
            key=lambda item: (-bucket_count(item), str(item[0])),
        )
        state_text = "; " + ", ".join(f"{name}={count}" for name, count in ordered_states[:4])
    blocker_count = summary.get("blockers", "unknown")
    manifest_count = summary.get("blocked_manifest_count", "unknown")
    return (
        "Manufacturing release evidence is structurally blocked "
        f"({blocker_count} blockers across {manifest_count} manifests; {bucket_text}"
        f"{state_text}); "
        "run scripts/check_manufacturing_artifacts.py --release for details"
    )


def load_manufacturing_report() -> dict:
    if not MANUFACTURING_REPORT.is_file():
        return {}
    try:
        report = json.loads(MANUFACTURING_REPORT.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return report if isinstance(report, dict) else {}


def manufacturing_action_details(report: dict | None = None) -> dict[str, object]:
    if report is None:
        report = load_manufacturing_report()
    if not report:
        return {}
    summary = report.get("summary", {})
    matrix = report.get("manifest_unblock_matrix", [])
    state_summary = report.get("artifact_state_summary", {})
    packets = report.get("blocker_execution_packets", [])
    return {
        "report_path": "build/reports/manufacturing_artifacts.json",
        "resolved_manifest": report.get("resolved_manifest"),
        "summary": summary if isinstance(summary, dict) else {},
        "artifact_state_summary": state_summary if isinstance(state_summary, dict) else {},
        "manifest_unblock_matrix": matrix if isinstance(matrix, list) else [],
        "top_blocker_execution_packets": packets[:12] if isinstance(packets, list) else [],
        "acceptance_commands": [
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    }


def detail_failure_lines(detail_checks: dict) -> list[dict]:
    rows: list[dict] = []
    for name, detail in detail_checks.items():
        if name == "release_checks" and isinstance(detail, list):
            for check in detail:
                if not isinstance(check, dict):
                    continue
                script = str(check.get("script", "release_check"))
                for stream in ("stdout", "stderr"):
                    for line in str(check.get(stream, "")).splitlines():
                        stripped = line.strip()
                        if stripped.startswith("- "):
                            rows.append(
                                {
                                    "source": script,
                                    "returncode": check.get("returncode"),
                                    "line": stripped[2:],
                                }
                            )
            continue
        if not isinstance(detail, dict):
            continue
        source = name
        command = detail.get("command")
        if isinstance(command, list) and command:
            source = " ".join(str(part) for part in command)
        for stream in ("stdout", "stderr"):
            for line in str(detail.get(stream, "")).splitlines():
                stripped = line.strip()
                if stripped.startswith("- "):
                    rows.append(
                        {
                            "source": source,
                            "returncode": detail.get("returncode"),
                            "line": stripped[2:],
                        }
                    )
    return rows


def product_next_command(blocker: str) -> str:
    match = re.search(r"run (scripts/[^\s;]+(?:\s+--[^\s;]+)*)", blocker)
    if match:
        return f"python3 {match.group(1)}"
    match = re.search(r":\s*(scripts/[^\s;]+(?:\s+--[^\s;]+)*)", blocker)
    if match:
        command = match.group(1)
        if command == "scripts/check_fpga_release.py":
            command = f"{command} --release"
        if command == "scripts/check_kicad_artifacts.py":
            command = f"{command} --release"
        if command == "scripts/check_manufacturing_artifacts.py":
            command = f"{command} --release"
        if command == "scripts/check_package_cross_probe.py":
            command = f"{command} --release"
        if command == "scripts/check_openlane_run_preflight.py":
            command = f"{command} --release"
        if command == "scripts/check_antenna_metadata.py":
            command = f"{command} --release"
        return f"python3 {command}"
    if blocker.startswith("scripts/"):
        command = re.split(r"\s+(?:reported|exited)\b", blocker, maxsplit=1)[0]
        return f"python3 {command}"
    if blocker.startswith("PD signoff artifacts"):
        return "python3 scripts/check_pd_signoff.py"
    if blocker.startswith("Manufacturing release") or blocker.startswith("Manufacturing package"):
        return "python3 scripts/check_manufacturing_artifacts.py --release"
    if blocker.startswith("FPGA "):
        return "python3 scripts/check_fpga_release.py --release"
    if "docs/board/kicad/e1-demo/fab-notes.md" in blocker:
        return "python3 scripts/check_kicad_artifacts.py --release"
    if "package-vendor" in blocker or "foundry/package-vendor" in blocker:
        return "python3 scripts/check_package_cross_probe.py --release"
    return "python3 scripts/product_check.py --release"


def detail_next_command(source: object) -> str:
    text = str(source or "")
    if text.startswith("scripts/"):
        return f"python3 {text}"
    if text.startswith(sys.executable):
        return text.replace(sys.executable, "python3", 1)
    return "python3 scripts/product_check.py --release"


def blocker_dependency_category(text: object) -> str:
    blob = str(text or "").lower()
    if any(
        token in blob
        for token in (
            "runtime",
            "adb",
            "booted",
            "launcher",
            "system bridge",
            "live marker",
            "device/emulator",
        )
    ):
        return "live_device_validation"
    if any(
        token in blob
        for token in (
            "supplier",
            "approval",
            "first article",
            "first-article",
            "enclosure",
            "mechanical",
            "fabrication",
            "factory",
            "procurement",
            "calibration",
            "external",
        )
    ):
        return "actionable_external_dependency"
    return "repo_artifact_generation"


def dependency_summary(findings: list[dict]) -> dict[str, int]:
    summary = {
        "repo_artifact_generation": 0,
        "live_device_validation": 0,
        "actionable_external_dependency": 0,
    }
    for finding in findings:
        category = effective_blocker_dependency(finding)
        if category in summary:
            summary[category] += 1
    return summary


def effective_blocker_dependency(finding: dict) -> str:
    category = str(finding.get("blocker_dependency", "repo_artifact_generation"))
    if category != "repo_artifact_generation":
        return category
    bucket = repo_generation_bucket_for_finding(finding)
    if bucket == "repo_generatable_now":
        return "repo_artifact_generation"
    if bucket == "blocked_by_live_hardware":
        return "live_device_validation"
    return "actionable_external_dependency"


REPO_ARTIFACT_COMMAND_GUIDANCE = {
    "python3 scripts/check_manufacturing_artifacts.py --release": {
        "family": "manufacturing_release_artifacts",
        "primary_paths": [
            "docs/manufacturing/artifact-manifest.yaml",
            "docs/manufacturing/release-manifest.yaml",
            "docs/manufacturing/evidence/",
            "build/reports/manufacturing_artifacts.json",
        ],
        "generation_commands": [
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_kicad_artifacts.py --release": {
        "family": "kicad_fabrication_artifacts",
        "primary_paths": [
            "board/kicad/e1-demo/artifact-manifest.yaml",
            "board/kicad/e1-demo/",
            "docs/manufacturing/evidence/board/",
            "build/reports/kicad_artifacts.json",
        ],
        "generation_commands": [
            "python3 scripts/check_kicad_artifacts.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_package_cross_probe.py --release": {
        "family": "package_vendor_cross_probe_release",
        "primary_paths": [
            "package/artifact-manifest.yaml",
            "docs/manufacturing/evidence/package/package-vendor-padframe-action-inventory-2026-05-23.yaml",
            "build/reports/package_cross_probe.json",
        ],
        "generation_commands": [
            "python3 scripts/check_package_cross_probe.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_fpga_release.py --release": {
        "family": "fpga_bitstream_artifacts",
        "primary_paths": [
            "board/fpga/artifact-manifest.yaml",
            "board/fpga/e1_demo_fpga.yaml",
            "board/fpga/constraints/e1_demo_ulx3s.lpf",
            "build/reports/fpga_release.json",
        ],
        "generation_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_pd_signoff.py": {
        "family": "pd_signoff_artifacts",
        "primary_paths": [
            "pd/signoff/manifest.yaml",
            "pd/openlane/runs/",
            "build/reports/pd_signoff.json",
        ],
        "generation_commands": [
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_openlane_run_preflight.py --release": {
        "family": "openlane_run_artifacts",
        "primary_paths": [
            "pd/openlane/config*.json",
            "pd/openlane/runs/",
            "build/reports/openlane_run_release_preflight.json",
        ],
        "generation_commands": [
            "python3 scripts/check_openlane_run_preflight.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_antenna_metadata.py --release": {
        "family": "antenna_metadata_artifacts",
        "primary_paths": [
            "docs/pd/e1_chip_top_antenna_metadata_2026-05-18.md",
            "pd/openlane/runs/",
        ],
        "generation_commands": [
            "python3 scripts/check_antenna_metadata.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_pd_release_evidence.py": {
        "family": "pd_release_evidence",
        "primary_paths": [
            "pd/signoff/manifest.yaml",
            "build/reports/pd_release_evidence.json",
        ],
        "generation_commands": [
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_board_package.py": {
        "family": "phone_board_package_release",
        "primary_paths": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "build/reports/e1_phone_board_package.json",
            "board/kicad/e1-phone/production/readiness/fabrication-enclosure-e2e-release-gate-2026-05-22.yaml",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_board_package.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_fabrication_release.py": {
        "family": "phone_fabrication_release_gate",
        "primary_paths": [
            "board/kicad/e1-phone/production/readiness/fabrication-enclosure-e2e-release-gate-2026-05-22.yaml",
            "build/reports/e1_phone_fabrication_release.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_e1_phone_board_package.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_release_approval_signatures.py": {
        "family": "phone_release_approval_signatures",
        "primary_paths": [
            "board/kicad/e1-phone/production/readiness/release-approval-signature-blocker-matrix-2026-05-23.yaml",
            "build/reports/e1_phone_release_approval_signatures.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_release_approval_signatures.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_release_evidence_regeneration.py": {
        "family": "phone_release_evidence_regeneration",
        "primary_paths": [
            "board/kicad/e1-phone/production/readiness/",
            "board/kicad/e1-phone/production/sourcing/readiness/",
            "board/kicad/e1-phone/production/test/readiness/",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_release_evidence_regeneration.py --write-committed",
            "python3 scripts/check_e1_phone_release_evidence_regeneration.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_supplier_return_content.py": {
        "family": "phone_supplier_return_artifacts",
        "primary_paths": [
            "board/kicad/e1-phone/production/sourcing/readiness/supplier-return-evidence-acceptance-matrix-2026-05-22.yaml",
            "build/reports/e1_phone_supplier_return_content.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_routed_output_content.py": {
        "family": "phone_routed_output_artifacts",
        "primary_paths": [
            "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/",
            "build/reports/e1_phone_routed_output_content.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_factory_output_content.py": {
        "family": "phone_factory_output_artifacts",
        "primary_paths": [
            "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml",
            "build/reports/e1_phone_factory_output_content.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_first_article_content.py": {
        "family": "phone_first_article_artifacts",
        "primary_paths": [
            "board/kicad/e1-phone/production/test/readiness/",
            "board/kicad/e1-phone/production/reports/",
            "build/reports/e1_phone_first_article_content.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_first_article_content.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_e1_phone_enclosure_mechanical_content.py": {
        "family": "phone_enclosure_mechanical_release",
        "primary_paths": [
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/enclosure-readiness-gap-map-2026-05-22.yaml",
            "build/reports/e1_phone_enclosure_mechanical_content.json",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/check_phone_runtime_readiness_contract.py": {
        "family": "phone_runtime_readiness_contract",
        "primary_paths": [
            "build/reports/phone_runtime_readiness_contract.json",
            "docs/evidence/android/",
        ],
        "generation_commands": [
            "python3 scripts/check_phone_runtime_readiness_contract.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone",
            "python3 scripts/product_check.py --release",
        ],
    },
    "python3 scripts/product_check.py --release": {
        "family": "product_release_triage",
        "primary_paths": [
            "build/reports/product_release_status.json",
            "scripts/product_check.py",
        ],
        "generation_commands": [
            "python3 scripts/product_check.py --release",
        ],
    },
}


PATH_TOKEN = re.compile(r"(?P<path>(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.@:+-]+(?:\.[A-Za-z0-9_.+-]+)?)")


def paths_from_text(text: object) -> list[str]:
    allowed_prefixes = (
        "board/",
        "build/",
        "docs/",
        "package/",
        "pd/",
    )
    paths: list[str] = []
    seen: set[str] = set()
    for match in PATH_TOKEN.finditer(str(text or "")):
        path = match.group("path").rstrip(".,:;")
        if path.startswith("scripts/"):
            continue
        if not path.startswith(allowed_prefixes):
            continue
        if not ("." in Path(path).name or path.endswith("/") or "/runs/" in path):
            continue
        if path not in seen:
            seen.add(path)
            paths.append(path)
    return paths


def repo_generation_bucket_counts(findings: list[dict]) -> dict[str, int]:
    counts = {bucket: 0 for bucket in REPO_GENERATION_BUCKETS}
    for finding in findings:
        if finding.get("blocker_dependency") != "repo_artifact_generation":
            continue
        counts[repo_generation_bucket_for_finding(finding)] += 1
    return counts


def repo_generation_bucket_for_finding(finding: dict) -> str:
    evidence = finding.get("evidence")
    source = evidence.get("source") if isinstance(evidence, dict) else evidence
    blob = " ".join(
        str(part or "").lower()
        for part in (
            finding.get("message"),
            finding.get("next_step"),
            finding.get("next_command"),
            source,
        )
    )
    if any(
        token in blob
        for token in (
            "repo_generatable_now",
            "can_generate_from_repo_now=true",
            "can generate from repo now",
        )
    ):
        return "repo_generatable_now"
    if any(
        token in blob
        for token in (
            "live",
            "adb",
            "booted",
            "device/emulator",
            "runtime capture",
            "first article",
            "first-article",
            "physical first",
            "bench log",
            "measurement",
            "cmm",
            "fai",
            "traveler",
            "thermal trace",
        )
    ):
        return "blocked_by_live_hardware"
    if any(
        token in blob
        for token in (
            "approval",
            "approved",
            "reviewer",
            "signature",
            "signed",
            "metadata",
            "checksum",
            "disposition",
            "source_revision",
            "dirty working tree",
            "release requires status complete",
            "release requires group status complete",
            "release requires manifest status complete",
            "release gate remains",
        )
    ):
        return "blocked_by_release_approval"
    if any(
        token in blob
        for token in (
            "supplier",
            "vendor",
            "foundry",
            "package-vendor",
            "fabricator",
            "assembler",
            "factory",
            "routed",
            "fabrication",
            "enclosure",
            "mechanical",
            "dfm",
            "toolmaker",
            "quote",
            "rf",
            "antenna",
            "stackup",
            "3d model",
            "external",
        )
    ):
        return "blocked_by_external_evidence"
    return "blocked_by_release_approval"


def _safe_read_json(path: str) -> dict[str, object]:
    file_path = Path(path)
    if not file_path.is_file():
        return {}
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def nested_report_generation_summary(guidance: dict) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for path in guidance.get("primary_paths", []):
        if (
            not isinstance(path, str)
            or not path.startswith("build/reports/")
            or not path.endswith(".json")
        ):
            continue
        report = _safe_read_json(path)
        if not report:
            continue
        summary = report.get("summary")
        row: dict[str, object] = {"report_path": path}
        for key in (
            "repo_artifact_generation_plan",
            "repo_generation_summary",
            "artifact_state_summary",
            "true_missing_generation_plan",
            "routed_step_generation_plan",
            "missing_release_evidence_generation_plan",
            "prioritized_runtime_capture_plan",
            "next_runtime_capture_action",
        ):
            value = report.get(key)
            if isinstance(value, (dict, list)):
                row[key] = value
        if isinstance(summary, dict):
            generation_keys = {
                key: value
                for key, value in summary.items()
                if "repo_generatable" in str(key)
                or "blocked_" in str(key)
                or "true_missing" in str(key)
                or "approval" in str(key)
                or "external" in str(key)
                or "live" in str(key)
                or "blocker" in str(key)
                or "release" in str(key)
                or "runtime" in str(key)
                or "capture" in str(key)
                or "next_" in str(key)
            }
            if generation_keys:
                row["summary_generation_fields"] = generation_keys
        if len(row) > 1:
            summaries.append(row)
    return summaries


def repo_artifact_generation_groups(findings: list[dict]) -> list[dict]:
    groups: dict[str, dict] = {}
    for finding in findings:
        if effective_blocker_dependency(finding) != "repo_artifact_generation":
            continue
        command = str(finding.get("next_command") or "python3 scripts/product_check.py --release")
        guidance = REPO_ARTIFACT_COMMAND_GUIDANCE.get(command, {})
        family = str(guidance.get("family") or code_from_text(command, "repo_artifact_generation"))
        group = groups.setdefault(
            family,
            {
                "family": family,
                "name": family,
                "count": 0,
                "next_command": command,
                "generation_commands": list(guidance.get("generation_commands", [command])),
                "primary_paths": list(guidance.get("primary_paths", [])),
                "source_scripts": [],
                "sample_messages": [],
                "referenced_paths": [],
                "repo_generation_category_counts": {
                    bucket: 0 for bucket in REPO_GENERATION_BUCKETS
                },
                "nested_report_generation_summaries": nested_report_generation_summary(guidance),
            },
        )
        group["count"] += 1
        group["repo_generation_category_counts"][repo_generation_bucket_for_finding(finding)] += 1
        evidence = finding.get("evidence")
        if isinstance(evidence, dict):
            source = str(evidence.get("source") or "")
            if source and source not in group["source_scripts"]:
                group["source_scripts"].append(source)
        message = str(finding.get("message") or "")
        if message and len(group["sample_messages"]) < 8:
            group["sample_messages"].append(message)
        for path in paths_from_text(message):
            if path not in group["referenced_paths"]:
                group["referenced_paths"].append(path)
    return sorted(groups.values(), key=lambda group: (-group["count"], group["family"]))


RELEASE_EXECUTION_PHASES = [
    {
        "phase": "chip_pd_signoff",
        "goal": "Produce release-clean PD evidence for tapeout readiness.",
        "primary_paths": [
            "pd/signoff/manifest.yaml",
            "pd/openlane/runs/",
            "build/reports/pd_signoff.json",
            "build/reports/pd_release_evidence.json",
            "build/reports/openlane_run_release_preflight.json",
            "build/reports/antenna_metadata.json",
        ],
        "commands": {
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/check_openlane_run_preflight.py --release",
            "python3 scripts/check_antenna_metadata.py --release",
        },
        "acceptance_commands": [
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "fpga_board_bitstream_release",
        "goal": "Close exact board revision, final pins, bitstream, timing, route, pack, and tool-version evidence.",
        "primary_paths": [
            "board/fpga/e1_demo_fpga.yaml",
            "board/fpga/release_manifest.yaml",
            "board/fpga/artifact-manifest.yaml",
            "board/fpga/constraints/e1_demo_ulx3s.lpf",
            "build/reports/fpga_release.json",
        ],
        "commands": {
            "python3 scripts/check_fpga_release.py --release",
        },
        "acceptance_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "manufacturing_package_release",
        "goal": "Archive package, board, SI/PI/current/thermal, checksum, and metadata evidence.",
        "primary_paths": [
            "docs/manufacturing/artifact-manifest.yaml",
            "docs/manufacturing/release-manifest.yaml",
            "docs/manufacturing/evidence/",
            "board/kicad/e1-demo/artifact-manifest.yaml",
            "build/reports/manufacturing_artifacts.json",
            "build/reports/kicad_artifacts.json",
        ],
        "commands": {
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/check_kicad_artifacts.py --release",
        },
        "acceptance_commands": [
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/check_kicad_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "package_vendor_cross_probe_release",
        "goal": "Close package-vendor, padframe, bond, footprint, and foundry cross-probe evidence.",
        "primary_paths": [
            "package/artifact-manifest.yaml",
            "package/e1-demo-pinout.yaml",
            "docs/package/e1-demo-package.md",
            "docs/manufacturing/evidence/package/package-vendor-padframe-action-inventory-2026-05-23.yaml",
            "build/reports/package_cross_probe.json",
        ],
        "commands": {
            "python3 scripts/check_package_cross_probe.py --release",
        },
        "acceptance_commands": [
            "python3 scripts/check_package_cross_probe.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "phone_fabrication_enclosure_release",
        "goal": "Close routed production outputs, supplier approvals, factory outputs, FAI logs, and enclosure clearance.",
        "primary_paths": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/production/readiness/fabrication-enclosure-e2e-release-gate-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/",
            "board/kicad/e1-phone/production/sourcing/readiness/",
            "board/kicad/e1-phone/production/test/readiness/",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            "build/reports/e1_phone_board_package.json",
            "build/reports/e1_phone_fabrication_release.json",
            "build/reports/e1_phone_release_approval_signatures.json",
            "build/reports/e1_phone_supplier_return_content.json",
            "build/reports/e1_phone_routed_output_content.json",
            "build/reports/e1_phone_factory_output_content.json",
            "build/reports/e1_phone_first_article_content.json",
            "build/reports/e1_phone_enclosure_mechanical_content.json",
        ],
        "commands": {
            "python3 scripts/check_e1_phone_board_package.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_e1_phone_release_evidence_regeneration.py",
            "python3 scripts/check_e1_phone_release_approval_signatures.py",
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_e1_phone_first_article_content.py",
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        },
        "acceptance_commands": [
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            "python3 scripts/product_check.py --release",
        ],
    },
    {
        "phase": "end_to_end_runtime_release",
        "goal": "Collect live booted-target runtime evidence for phone and Android launcher/agent readiness.",
        "primary_paths": [
            "build/reports/phone_runtime_readiness_contract.json",
            "docs/evidence/android/",
            "docs/evidence/runtime/",
        ],
        "commands": {
            "python3 scripts/check_phone_runtime_readiness_contract.py",
        },
        "acceptance_commands": [
            "python3 scripts/check_phone_runtime_readiness_contract.py",
            "python3 scripts/check_android_release_readiness_contract.py",
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            "python3 scripts/product_check.py --release",
        ],
    },
]


def product_release_execution_plan(
    findings: list[dict],
    manufacturing_details: dict[str, object] | None = None,
) -> list[dict]:
    rows: list[dict] = []
    manufacturing_details = manufacturing_details or manufacturing_action_details()
    for phase in RELEASE_EXECUTION_PHASES:
        commands = set(phase.get("commands", set()))
        categories = set(phase.get("dependency_categories", set()))
        matched = [
            finding
            for finding in findings
            if str(finding.get("next_command")) in commands
            or str(finding.get("blocker_dependency")) in categories
        ]
        if not matched:
            continue
        row = {
            "phase": phase["phase"],
            "goal": phase["goal"],
            "release_credit": False,
            "blocker_count": len(matched),
            "blocker_dependency_counts": dependency_summary(matched),
            "repo_generation_category_counts": repo_generation_bucket_counts(matched),
            "primary_commands": sorted(
                {
                    str(finding.get("next_command"))
                    for finding in matched
                    if finding.get("next_command")
                }
            ),
            "primary_paths": phase.get("primary_paths", []),
            "acceptance_commands": phase["acceptance_commands"],
            "sample_findings": [
                str(finding.get("message")) for finding in matched[:8] if finding.get("message")
            ],
            "nested_report_generation_summaries": nested_report_generation_summary(phase),
        }
        if phase["phase"] == "manufacturing_package_release" and manufacturing_details:
            row["manufacturing_artifact_details"] = manufacturing_details
            artifact_state_summary = manufacturing_details.get("artifact_state_summary")
            if isinstance(artifact_state_summary, dict):
                state_counts = artifact_state_summary.get("state_counts")
                if isinstance(state_counts, dict):
                    row["manufacturing_artifact_state_counts"] = state_counts
                row["nested_report_generation_summaries"] = [
                    summary
                    for summary in row["nested_report_generation_summaries"]
                    if summary.get("report_path") != "build/reports/manufacturing_artifacts.json"
                ]
                row["nested_report_generation_summaries"].insert(
                    0,
                    {
                        "report_path": "build/reports/manufacturing_artifacts.json",
                        "artifact_state_summary": artifact_state_summary,
                        "summary_generation_fields": manufacturing_details.get("summary", {}),
                    },
                )
        rows.append(row)
    return rows


def next_release_action(execution_plan: list[dict]) -> dict[str, object] | None:
    """Return the first non-local release action operators can execute or collect."""
    for phase in execution_plan:
        dependency_counts = phase.get("blocker_dependency_counts")
        if not isinstance(dependency_counts, dict):
            continue
        external_count = int(dependency_counts.get("actionable_external_dependency") or 0)
        live_count = int(dependency_counts.get("live_device_validation") or 0)
        repo_count = int(dependency_counts.get("repo_artifact_generation") or 0)
        if external_count <= 0 and live_count <= 0 and repo_count <= 0:
            continue
        action: dict[str, object] = {
            "phase": phase.get("phase"),
            "goal": phase.get("goal"),
            "release_credit": False,
            "blocker_dependency_counts": dependency_counts,
            "primary_commands": phase.get("primary_commands", []),
            "primary_paths": phase.get("primary_paths", []),
            "acceptance_commands": phase.get("acceptance_commands", []),
            "sample_findings": phase.get("sample_findings", []),
            "claim_boundary": "operator_release_action_only_not_release_evidence",
        }
        for summary in phase.get("nested_report_generation_summaries", []):
            if not isinstance(summary, dict):
                continue
            if isinstance(summary.get("next_runtime_capture_action"), dict):
                action["next_runtime_capture_action"] = summary["next_runtime_capture_action"]
                break
        return action
    return None


def next_runtime_capture_action(execution_plan: list[dict]) -> dict[str, object] | None:
    """Return live-device runtime capture guidance even when another phase is first."""
    for phase in execution_plan:
        if phase.get("phase") != "end_to_end_runtime_release":
            continue
        for summary in phase.get("nested_report_generation_summaries", []):
            if not isinstance(summary, dict):
                continue
            action = summary.get("next_runtime_capture_action")
            if isinstance(action, dict):
                return action
    return None


def structured_findings(release_blockers: list[str], detail_checks: dict) -> list[dict]:
    findings: list[dict] = []
    for blocker in release_blockers:
        findings.append(
            {
                "code": f"product_release_blocker_{code_from_text(blocker, 'blocker')}",
                "severity": "blocker",
                "message": blocker,
                "evidence": "release_blockers",
                "next_step": (
                    "Close the named package, FPGA, KiCad, PD, manufacturing, "
                    "or release-check blocker before making fabrication, tapeout, "
                    "or no-issues product readiness claims."
                ),
                "next_command": product_next_command(blocker),
                "blocker_dependency": blocker_dependency_category(blocker),
            }
        )
    seen: set[str] = set()
    for row in detail_failure_lines(detail_checks):
        line = str(row["line"])
        code = f"product_release_detail_{code_from_text(line, 'detail')}"
        if code in seen:
            continue
        seen.add(code)
        findings.append(
            {
                "code": code,
                "severity": "blocker",
                "message": line,
                "evidence": {
                    "source": row.get("source"),
                    "returncode": row.get("returncode"),
                },
                "next_step": (
                    "Repair or archive the exact release evidence named by this "
                    "detail check and rerun product-release-check."
                ),
                "next_command": detail_next_command(row.get("source")),
                "blocker_dependency": blocker_dependency_category(f"{row.get('source')} {line}"),
            }
        )
    return findings


def annotate_effective_blocker_dependencies(findings: list[dict]) -> list[dict]:
    for finding in findings:
        finding["effective_blocker_dependency"] = effective_blocker_dependency(finding)
    return findings


required = [
    "package/e1-demo-pinout.yaml",
    "docs/package/e1-demo-package.md",
    "docs/package/e1-demo-pad-ring.md",
    "package/wifi-external-interface.yaml",
    "docs/pd/padframe/e1_demo_padframe.md",
    "pd/padframe/e1_demo_padframe.yaml",
    "pd/pin_order.cfg",
    "pd/signoff/manifest.yaml",
    "package/artifact-manifest.yaml",
    "docs/board/README.md",
    "docs/board/fpga/README.md",
    "board/fpga/artifact-manifest.yaml",
    "board/fpga/e1_demo_fpga.yaml",
    "board/fpga/constraints/e1_demo_ulx3s.lpf",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml",
    "board/kicad/e1-phone/routed-release-plan.yaml",
    "docs/board/kicad/e1-demo/fab-notes.md",
    "docs/fw/board-smoke/tests/smoke_plan.md",
    "docs/manufacturing/e1-demo-checklist.md",
    "docs/manufacturing/artifact-manifest.yaml",
    "docs/manufacturing/release-manifest.yaml",
    "docs/manufacturing/real-world-verification-gaps.yaml",
    "docs/manufacturing/physical-closure-work-order.yaml",
    "docs/manufacturing/product-feature-evidence-manifest.yaml",
    "docs/project/product-architecture-security-radio-sensors-optimization-2026-05-17.yaml",
    "docs/pd/e1_chip_top_antenna_metadata_2026-05-18.md",
    "scripts/run_product_evidence_command.py",
]

missing = [p for p in required if not Path(p).exists()]
if missing:
    raise SystemExit("missing product artifacts: " + ", ".join(missing))

release_blockers: list[str] = []
preflight_checks: list[dict] = []
for command in [
    [sys.executable, "package/scripts/validate_pinout_vs_rtl.py"],
    [sys.executable, "scripts/check_fpga_target.py"],
    [sys.executable, "scripts/check_wifi_interface.py"],
    [sys.executable, "scripts/check_padframe_contract.py"],
    [sys.executable, "scripts/check_physical_closure_work_order.py"],
    [sys.executable, "scripts/check_package_cross_probe.py"],
    [sys.executable, "scripts/check_kicad_artifacts.py"],
    [sys.executable, "scripts/check_fpga_release.py"],
    [sys.executable, "scripts/check_openlane_run_preflight.py"],
    [sys.executable, "scripts/check_antenna_metadata.py"],
    [sys.executable, "scripts/check_pd_signoff.py", "--manifest-only"],
    [sys.executable, "scripts/check_manufacturing_artifacts.py"],
    [sys.executable, "scripts/check_real_world_gates.py"],
    [sys.executable, "scripts/check_product_feature_gates.py"],
    [sys.executable, "scripts/check_product_architecture_optimization.py"],
    [sys.executable, "scripts/run_product_evidence_command.py", "--list"],
]:
    result = subprocess.run(command, check=False, text=True, capture_output=True)
    check_row = {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "blocked_status": is_known_blocked_result(result),
    }
    preflight_checks.append(check_row)
    if result.returncode != 0:
        state = "reported blocked state" if check_row["blocked_status"] else "failed"
        release_blockers.append(f"product preflight check {state}: {command_label(command)}")

pinout = yaml.safe_load(Path("package/e1-demo-pinout.yaml").read_text())
package_name = str(pinout.get("package", ""))
pinout_notes = "\n".join(str(note) for note in pinout.get("notes", []))
if "placeholder" in package_name.lower() or "placeholder" in pinout_notes.lower():
    release_blockers.append("package pinout still declares a placeholder package")

for path in [
    "docs/package/e1-demo-package.md",
    "docs/package/e1-demo-pad-ring.md",
]:
    text = Path(path).read_text().lower()
    if (
        "placeholder" in text
        or "not a foundry-approved" in text
        or "does not instantiate foundry pad cells" in text
    ):
        release_blockers.append(f"{path} is still a placeholder/draft artifact")

fab_notes_text = Path("docs/board/kicad/e1-demo/fab-notes.md").read_text().lower()
fab_note_block_markers = [
    "release status: `blocked`",
    "fabrication release: `prohibited`",
    "release credit: `none`",
    "foundry approval: `missing`",
    "package-vendor land-pattern approval: `missing`",
]
if all(marker in fab_notes_text for marker in fab_note_block_markers):
    release_blockers.append(
        "docs/board/kicad/e1-demo/fab-notes.md records non-release KiCad status: "
        "foundry/package-vendor approvals, release-credit fabrication outputs, "
        "DFM, enclosure-fit, and first-article evidence are missing"
    )
elif (
    "placeholder" in fab_notes_text
    or "not a foundry-approved" in fab_notes_text
    or "does not instantiate foundry pad cells" in fab_notes_text
):
    release_blockers.append(
        "docs/board/kicad/e1-demo/fab-notes.md still lacks a fail-closed "
        "foundry/vendor approval and release-credit evidence record"
    )

kicad_dir = Path("board/kicad/e1-demo")
kicad_required = {
    "project": list(kicad_dir.glob("*.kicad_pro")),
    "schematic": list(kicad_dir.glob("*.kicad_sch")),
    "pcb": list(kicad_dir.glob("*.kicad_pcb")),
}
for artifact, matches in kicad_required.items():
    if not matches:
        release_blockers.append(f"missing KiCad {artifact} artifact under {kicad_dir}")

fpga = yaml.safe_load(Path("board/fpga/e1_demo_fpga.yaml").read_text())
if fpga.get("status") != "release_ready":
    release_blockers.append(f"FPGA target status is {fpga.get('status')}, not release_ready")
if fpga.get("board", {}).get("exact_revision") in {None, "", "unassigned"}:
    release_blockers.append("FPGA board exact_revision is unassigned")
if fpga.get("constraints", {}).get("bitstream_release_blocked_until_pins_assigned") is True:
    release_blockers.append("FPGA bitstream release is explicitly blocked until pins are assigned")

constraint_path = Path(fpga["constraints"]["skeleton_lpf"])
assigned_locs = [
    line
    for line in constraint_path.read_text().splitlines()
    if line.strip().startswith("LOCATE COMP") and not line.lstrip().startswith("#")
]
if not assigned_locs:
    release_blockers.append(f"{constraint_path} has no concrete FPGA LOCATE COMP assignments")

pd_signoff = subprocess.run(
    [sys.executable, "scripts/check_pd_signoff.py"],
    check=False,
    text=True,
    capture_output=True,
)
pd_signoff_blocked = is_known_blocked_result(pd_signoff)
if pd_signoff.returncode != 0 or pd_signoff_blocked:
    release_blockers.append(
        "PD signoff artifacts/gates are incomplete; run scripts/check_pd_signoff.py for details"
    )

manufacturing_release = subprocess.run(
    [sys.executable, "scripts/check_manufacturing_artifacts.py", "--release"],
    check=False,
    text=True,
    capture_output=True,
)
manufacturing_release_blocked = is_known_blocked_result(manufacturing_release)
manufacturing_release_report = load_manufacturing_report()
if manufacturing_release.returncode != 0 or manufacturing_release_blocked:
    release_blockers.append(manufacturing_release_blocker_message())

release_check_outputs: list[dict] = []
release_check_commands = [
    [sys.executable, "scripts/check_package_cross_probe.py", "--release"],
    [sys.executable, "scripts/check_kicad_artifacts.py", "--release"],
    [sys.executable, "scripts/check_fpga_release.py", "--release"],
    [sys.executable, "scripts/check_openlane_run_preflight.py", "--release"],
    [sys.executable, "scripts/check_antenna_metadata.py", "--release"],
    [sys.executable, "scripts/check_pd_release_evidence.py"],
    [sys.executable, "scripts/check_e1_phone_board_package.py"],
    [sys.executable, "scripts/check_e1_phone_fabrication_release.py"],
    [sys.executable, "scripts/check_e1_phone_release_evidence_regeneration.py"],
    [sys.executable, "scripts/check_e1_phone_release_approval_signatures.py"],
    [sys.executable, "scripts/check_e1_phone_supplier_return_content.py"],
    [sys.executable, "scripts/check_e1_phone_routed_output_content.py"],
    [sys.executable, "scripts/check_e1_phone_factory_output_content.py"],
    [sys.executable, "scripts/check_e1_phone_first_article_content.py"],
    [sys.executable, "scripts/check_e1_phone_enclosure_mechanical_content.py"],
    [sys.executable, "scripts/check_phone_runtime_readiness_contract.py"],
]
for release_check in release_check_commands:
    result = subprocess.run(
        release_check,
        check=False,
        text=True,
        capture_output=True,
    )
    blocked = is_known_blocked_result(result)
    if result.returncode != 0 or blocked:
        label = command_label(release_check)
        reason = "reported blocked state" if blocked else f"exited {result.returncode}"
        release_blockers.append(f"{label} {reason}")
        release_check_outputs.append(
            {
                "command": release_check,
                "returncode": result.returncode,
                "script": label,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "blocked_status": blocked,
            }
        )

if release_blockers:
    detail_checks = {
        "pd_signoff": {
            "command": [sys.executable, "scripts/check_pd_signoff.py"],
            "returncode": pd_signoff.returncode,
            "stdout": pd_signoff.stdout,
            "stderr": pd_signoff.stderr,
            "blocked_status": pd_signoff_blocked,
        },
        "manufacturing_release": {
            "command": [
                sys.executable,
                "scripts/check_manufacturing_artifacts.py",
                "--release",
            ],
            "returncode": manufacturing_release.returncode,
            "stdout": manufacturing_release.stdout,
            "stderr": manufacturing_release.stderr,
            "blocked_status": manufacturing_release_blocked,
        },
        "release_checks": [dict(check) for check in release_check_outputs],
    }
    findings = annotate_effective_blocker_dependencies(
        structured_findings(release_blockers, detail_checks)
    )
    manufacturing_details = manufacturing_action_details(manufacturing_release_report)
    execution_plan = product_release_execution_plan(findings, manufacturing_details)
    release_action = next_release_action(execution_plan)
    runtime_capture_action = next_runtime_capture_action(execution_plan)
    report = {
        "schema": "eliza.product_release_status.v1",
        "status": "blocked",
        "release_mode": args.release,
        "claim_boundary": "product/package/board/PD scaffold only; not fabrication, bitstream, tapeout, or manufacturing release evidence",
        "release_blockers": release_blockers,
        "detail_checks": detail_checks,
        "preflight_checks": preflight_checks,
        "findings": findings,
        "blocker_dependency_counts": dependency_summary(findings),
        "repo_artifact_generation_groups": repo_artifact_generation_groups(findings),
        "release_execution_plan": execution_plan,
        "next_release_action": release_action,
        "next_runtime_capture_action": runtime_capture_action,
        "manufacturing_artifact_details": manufacturing_details,
        "next_step": "close package/FPGA/KiCad/PD/manufacturing release blockers or keep product claim below fabrication",
    }
    write_report(report)
    if not args.release:
        emit_json(report)
        if args.json or args.json_only:
            raise SystemExit(0)
        print("product scaffold check ok; release blockers remain documented")
        print("run `make product-release-check` for fail-closed fabrication/tapeout gating")
        raise SystemExit(0)

    emit_json(report)
    if args.json or args.json_only:
        raise SystemExit(1)
    if should_suppress_human_output():
        raise SystemExit(1)
    print(
        "STATUS: BLOCKED product release check "
        f"release_blockers={len(release_blockers)} "
        f"detail_checks={len(detail_checks['release_checks'])}"
    )
    print("product release check failed:")
    for blocker in release_blockers:
        print(f"  - {blocker}")
    for check in preflight_checks:
        if check["stdout"]:
            print(f"\n{command_label(check['command'])} preflight detail:")
            print(check["stdout"].rstrip())
        if check["stderr"]:
            print(check["stderr"].rstrip(), file=sys.stderr)
    if pd_signoff.stdout:
        print("\nPD signoff detail:")
        print(pd_signoff.stdout.rstrip())
    if pd_signoff.stderr:
        print(pd_signoff.stderr.rstrip(), file=sys.stderr)
    if manufacturing_release.stdout:
        print("\nManufacturing artifact detail:")
        print(manufacturing_release.stdout.rstrip())
    if manufacturing_release.stderr:
        print(manufacturing_release.stderr.rstrip(), file=sys.stderr)
    for check in release_check_outputs:
        if check["stdout"]:
            print(f"\n{check['script']} detail:")
            print(str(check["stdout"]).rstrip())
        if check["stderr"]:
            print(str(check["stderr"]).rstrip(), file=sys.stderr)
    raise SystemExit(1)

report = {
    "schema": "eliza.product_release_status.v1",
    "status": "pass",
    "release_mode": args.release,
    "claim_boundary": "all configured product/package/board/PD release checks passed",
    "release_blockers": [],
    "detail_checks": {},
    "next_step": "none",
}
write_report(report)
emit_json(report)
if not should_suppress_human_output():
    print("product release check ok")
