#!/usr/bin/env python3
import json
import re
import sys
from argparse import ArgumentParser
from pathlib import Path

import check_pd_closure
import yaml
from yaml.nodes import MappingNode, ScalarNode

REQUIRED_ARTIFACTS = {
    "run_manifest": ".yaml",
    "gds": ".gds",
    "def": ".def",
    "gate_netlist": ".v",
    "corner_manifest": ".yaml",
    "sdc": ".sdc",
    "spef": ".spef",
    "sdf": ".sdf",
    "drc_report": ".rpt",
    "klayout_drc_report": ".rpt",
    "lvs_report": ".rpt",
    "antenna_report": ".rpt",
    "sta_report": ".rpt",
    "utilization_report": ".rpt",
    "congestion_report": ".rpt",
    "density_fill_report": ".rpt",
    "tool_versions": ".txt",
}

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/pd_signoff.json"
MANIFEST_REPORT = ROOT / "build/reports/pd_signoff_manifest.json"
SCHEMA = "eliza.pd_signoff.v1"
CLAIM_BOUNDARY = "pd_signoff_artifact_validation_only_not_tapeout_release_evidence"

ARTIFACT_LABELS = {
    "run_manifest": "run manifest",
    "gds": "GDS layout",
    "def": "DEF layout",
    "gate_netlist": "gate-level netlist",
    "corner_manifest": "corner manifest",
    "sdc": "SDC constraints",
    "spef": "SPEF parasitics",
    "sdf": "SDF backannotation",
    "drc_report": "DRC report",
    "klayout_drc_report": "KLayout DRC report",
    "lvs_report": "LVS report",
    "antenna_report": "antenna report",
    "sta_report": "STA report",
    "utilization_report": "utilization report",
    "congestion_report": "congestion report",
    "density_fill_report": "density/fill report",
    "tool_versions": "tool-version report",
}

ARTIFACT_BLOCKER_CLASSES = {
    "run_manifest": "release_manifest",
    "gds": "layout_database",
    "def": "layout_database",
    "gate_netlist": "netlist",
    "corner_manifest": "timing_corners",
    "sdc": "timing_constraints",
    "spef": "timing_parasitics",
    "sdf": "timing_backannotation",
    "drc_report": "drc",
    "klayout_drc_report": "drc",
    "lvs_report": "lvs",
    "antenna_report": "antenna",
    "sta_report": "timing",
    "utilization_report": "physical_metrics",
    "congestion_report": "routing_drv",
    "density_fill_report": "density_fill",
    "tool_versions": "reproducibility",
}

RUN_OUTPUT_SPECS = {
    "gds": (".gds", "GDS layout"),
    "def": (".def", "DEF layout"),
    "gate_netlist": (".v", "gate-level netlist"),
    "corner_manifest": (".yaml", "corner manifest"),
    "sdc": (".sdc", "SDC constraints"),
    "spef": (".spef", "SPEF parasitics"),
    "sdf": (".sdf", "SDF backannotation"),
    "tool_versions": (".txt", "tool-version report"),
}

REQUIRED_BLOCKED_GATES = {
    "pd_release",
    "tapeout_release",
    "board_fabrication_release",
}

REQUIRED_READINESS_SECTIONS = {
    "si_pi",
    "pdn_current_budget",
    "padframe_package",
    "thermal_package_board",
}

ALLOWED_READINESS_STATUS = {
    "blocked",
    "incomplete",
    "required_for_release",
}

REQUIRED_RUN_MANIFEST_FIELDS = {
    "run_id",
    "design",
    "flow",
    "pdk",
    "std_cell_library",
    "openlane_image",
    "openlane_image_digest",
    "volare_pdk_digest",
    "klayout_digest",
    "magic_digest",
    "netgen_digest",
    "openroad_digest",
    "yosys_digest",
    "abc_digest",
    "antenna_deck_digest",
    "started_at",
    "completed_at",
    "status",
    "corners",
    "inputs",
    "outputs",
    "checks",
    "psm_ir_drop_report",
    "pdn_topology",
}

# Tool-digest fields that must each be either a `sha256:<hex>` string OR the
# literal `unavailable` with a paired `<tool>_unavailable_reason` string.
# Closes Workstream E reproducibility blocker (research/00_integration_shortlist.md H-4).
TOOL_DIGEST_FIELDS = {
    "volare_pdk_digest",
    "klayout_digest",
    "magic_digest",
    "netgen_digest",
    "openroad_digest",
    "yosys_digest",
    "abc_digest",
    "antenna_deck_digest",
}

SHA256_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

REQUIRED_PDN_TOPOLOGY_FIELDS = {
    "vertical_layer",
    "horizontal_layer",
    "vpitch_um",
    "hpitch_um",
    "vwidth_um",
    "hwidth_um",
    "vspacing_um",
    "hspacing_um",
    "core_ring",
    "report",
}

REQUIRED_PDN_CORE_RING_FIELDS = {
    "enabled",
    "vwidth_um",
    "hwidth_um",
    "voffset_um",
    "hoffset_um",
    "vspacing_um",
    "hspacing_um",
}

REQUIRED_RUN_CHECKS = {
    "drc",
    "lvs",
    "antenna",
    "sta",
    "utilization",
    "congestion",
    "density_fill",
}

PLACEHOLDERS = {"", "tbd", "todo", "placeholder", "none", "n/a", "unknown"}
RELEASE_FAIL_CLOSED_KEYS = {
    "QUIT_ON_TIMING_VIOLATIONS",
    "QUIT_ON_MAGIC_DRC",
    "QUIT_ON_LVS_ERROR",
    "QUIT_ON_SLEW_VIOLATIONS",
}


def write_report(
    status: str,
    mode: str,
    manifest: Path,
    findings: list[str],
    report_path: Path | None = None,
    diagnostics: dict | None = None,
) -> None:
    blocker_classes = diagnostics.get("blocker_classes", {}) if isinstance(diagnostics, dict) else {}
    artifact_gap = diagnostics.get("artifact_gap", {}) if isinstance(diagnostics, dict) else {}
    closest_run = artifact_gap.get("closest_run", {}) if isinstance(artifact_gap, dict) else {}
    try:
        evidence = manifest.relative_to(ROOT).as_posix()
    except ValueError:
        evidence = str(manifest)
    payload = {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": mode,
        "manifest": evidence,
        "summary": {
            "release_ready": status == "pass" and mode == "artifacts",
            "release_credit": False,
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
            "selected_run": blocker_classes.get("selected_run"),
            "closest_run": closest_run.get("run") if isinstance(closest_run, dict) else None,
            "closest_run_missing_artifact_count": (
                closest_run.get("missing_count") if isinstance(closest_run, dict) else None
            ),
            "blocked_release_gate_count": (
                len(blocker_classes.get("blocked_release_gates", []))
                if isinstance(blocker_classes, dict)
                else 0
            ),
        },
        "findings": [
            {
                "code": f"pd_signoff_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "evidence": evidence,
                "next_step": (
                    "Archive a complete PD signoff run with clean or formally waived "
                    "DRC, LVS, antenna, STA, IR, EM, density, and tool-version evidence."
                ),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    if diagnostics is not None:
        payload["diagnostics"] = diagnostics
        payload["release_unblock_plan"] = release_unblock_plan(diagnostics)
        payload["repo_artifact_generation_plan"] = repo_artifact_generation_plan(diagnostics)
    destination = report_path or (MANIFEST_REPORT if mode == "manifest" else REPORT)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def as_list(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def artifact_label(name: str) -> str:
    label = ARTIFACT_LABELS.get(name, name)
    return f"{label} ({name})"


def artifact_list(names: list[str]) -> str:
    return ", ".join(artifact_label(name) for name in names)


def artifact_gap_rows(manifest: dict, names: list[str]) -> list[dict]:
    required = manifest.get("required_artifacts", {})
    rows = []
    for name in sorted(names):
        spec = required.get(name, {}) if isinstance(required, dict) else {}
        rows.append(
            {
                "artifact": name,
                "label": ARTIFACT_LABELS.get(name, name),
                "blocker_class": ARTIFACT_BLOCKER_CLASSES.get(name, "artifact"),
                "expected_globs": as_list(spec.get("globs")) if isinstance(spec, dict) else [],
                "producer_command": "scripts/run_openlane.sh --release",
                "validation_command": "python3 scripts/check_pd_signoff.py",
                "accepted_exit_code": 0,
                "expected_output": "PD signoff gate accepts the artifact class from one complete e1_chip_top run.",
                "release_credit": False,
            }
        )
    return rows


def release_unblock_plan(diagnostics: dict | None) -> dict:
    artifact_gap = diagnostics.get("artifact_gap", {}) if isinstance(diagnostics, dict) else {}
    closest = artifact_gap.get("closest_run", {}) if isinstance(artifact_gap, dict) else {}
    blocker_classes = diagnostics.get("blocker_classes", {}) if isinstance(diagnostics, dict) else {}
    missing_artifacts = (
        closest.get("missing_artifact_classes", []) if isinstance(closest, dict) else []
    )
    blocked_gates = (
        blocker_classes.get("blocked_release_gates", [])
        if isinstance(blocker_classes, dict)
        else []
    )
    return {
        "release_credit": False,
        "claim_boundary": (
            "Unblock plan is diagnostic only; release credit requires a clean or formally "
            "waived complete PD signoff run plus closed release gates."
        ),
        "closest_run": closest.get("run") if isinstance(closest, dict) else None,
        "missing_artifact_count": len(missing_artifacts),
        "blocked_release_gate_count": len(blocked_gates),
        "missing_artifacts": missing_artifacts,
        "blocked_release_gates": blocked_gates,
        "next_commands": [
            "scripts/run_openlane.sh --release",
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
        ],
    }


def repo_artifact_generation_plan(diagnostics: dict | None) -> dict:
    artifact_gap = diagnostics.get("artifact_gap", {}) if isinstance(diagnostics, dict) else {}
    closest = artifact_gap.get("closest_run", {}) if isinstance(artifact_gap, dict) else {}
    blocker_classes = diagnostics.get("blocker_classes", {}) if isinstance(diagnostics, dict) else {}
    missing_artifacts = (
        closest.get("missing_artifact_classes", []) if isinstance(closest, dict) else []
    )
    blocked_gates = (
        blocker_classes.get("blocked_release_gates", [])
        if isinstance(blocker_classes, dict)
        else []
    )
    artifact_rows = [
        {
            "artifact": row.get("artifact"),
            "label": row.get("label"),
            "blocker_class": row.get("blocker_class"),
            "expected_globs": row.get("expected_globs", []),
            "producer_command": row.get("producer_command"),
            "validation_command": row.get("validation_command"),
            "repo_generatable_now": False,
            "can_close_release_from_current_repo": False,
            "blocked_by": [
                "missing_clean_release_signoff_replay",
                "blocked_release_gates",
                "external_review_or_formal_waiver_evidence",
            ],
            "release_credit": False,
        }
        for row in missing_artifacts
    ]
    gate_rows = [
        {
            "gate": gate.get("gate"),
            "reason": gate.get("reason"),
            "evidence_manifest": gate.get("evidence_manifest"),
            "unblock_requires": gate.get("unblock_requires", []),
            "repo_generatable_now": False,
            "can_close_release_from_current_repo": False,
            "blocked_by": [
                "external_release_evidence",
                "clean_or_formally_waived_signoff",
            ],
            "release_credit": False,
        }
        for gate in blocked_gates
    ]
    return {
        "release_credit": False,
        "claim_boundary": (
            "This plan classifies release-credit closure only. A repo command may "
            "regenerate diagnostics, but it cannot close PD signoff until a complete "
            "clean/formally waived release run and blocked release gates are resolved."
        ),
        "repo_generatable_now_count": 0,
        "can_close_from_current_repo_count": 0,
        "blocked_missing_artifact_count": len(artifact_rows),
        "blocked_release_gate_count": len(gate_rows),
        "blocked_generation_count": len(artifact_rows) + len(gate_rows),
        "missing_artifacts": artifact_rows,
        "blocked_release_gates": gate_rows,
        "next_commands": [
            "scripts/run_openlane.sh --release",
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
        ],
    }


def is_placeholder(value: object) -> bool:
    return not isinstance(value, str) or value.strip().lower() in PLACEHOLDERS


def validate_no_duplicate_yaml_keys(text: str) -> list[str]:
    failures: list[str] = []
    root = yaml.compose(text)
    if root is None:
        return failures

    def visit(node: object, path: str) -> None:
        if isinstance(node, MappingNode):
            seen: dict[str, int] = {}
            for key_node, value_node in node.value:
                if isinstance(key_node, ScalarNode):
                    key = str(key_node.value)
                    if key in seen:
                        failures.append(
                            f"duplicate YAML key at {path}: {key} "
                            f"(first line {seen[key]}, duplicate line {key_node.start_mark.line + 1})"
                        )
                    else:
                        seen[key] = key_node.start_mark.line + 1
                    child_path = f"{path}.{key}" if path else key
                else:
                    child_path = path
                visit(value_node, child_path)

    visit(root, "")
    return failures


def matched_files(root: Path, globs: list[str]) -> list[Path]:
    matches: list[Path] = []
    for pattern in globs:
        matches.extend(sorted(root.glob(pattern)))
    return [path for path in matches if path.is_file()]


def validate_relative_globs(section: str, name: str, globs: object, failures: list[str]) -> None:
    glob_list = as_list(globs)
    if not glob_list:
        failures.append(f"{section}.{name}: missing globs")
        return
    for pattern in glob_list:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{section}.{name}: glob must be a relative repo path: {pattern}")


def validate_relative_file(root: Path, field: str, value: object, failures: list[str]) -> None:
    if not isinstance(value, str) or not value:
        failures.append(f"{field}: missing evidence_manifest")
        return
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        failures.append(f"{field}: evidence_manifest must be a relative repo path: {value}")
        return
    if not (root / path).is_file():
        failures.append(f"{field}: evidence_manifest points at missing file: {value}")


def validate_blocked_gates(root: Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    gates = manifest.get("blocked_gates")
    if not isinstance(gates, dict):
        return ["manifest must list blocked_gates"]

    missing = sorted(REQUIRED_BLOCKED_GATES - set(gates))
    if missing:
        failures.append("blocked_gates missing gates: " + ", ".join(missing))

    for gate_name, gate in gates.items():
        if not isinstance(gate, dict):
            failures.append(f"blocked_gates.{gate_name}: gate spec must be a mapping")
            continue
        if not isinstance(gate.get("blocked"), bool):
            failures.append(f"blocked_gates.{gate_name}: blocked must be true or false")
        if gate.get("blocked") is False:
            approvals = as_list(gate.get("approvals"))
            evidence = as_list(gate.get("evidence"))
            if not approvals or not evidence:
                failures.append(
                    f"blocked_gates.{gate_name}: unblocked gates require approvals and evidence"
                )
        if not isinstance(gate.get("reason"), str) or not gate["reason"]:
            failures.append(f"blocked_gates.{gate_name}: missing reason")
        validate_relative_file(
            root, f"blocked_gates.{gate_name}", gate.get("evidence_manifest"), failures
        )
        if not as_list(gate.get("unblock_requires")):
            failures.append(f"blocked_gates.{gate_name}: missing unblock_requires")
    return failures


def validate_readiness_sections(manifest: dict) -> list[str]:
    failures: list[str] = []
    missing = sorted(REQUIRED_READINESS_SECTIONS - set(manifest))
    if missing:
        failures.append("manifest missing readiness sections: " + ", ".join(missing))

    for section_name in sorted(REQUIRED_READINESS_SECTIONS & set(manifest)):
        section = manifest[section_name]
        if not isinstance(section, dict):
            failures.append(f"{section_name}: readiness section must be a mapping")
            continue
        status = section.get("status")
        if status not in ALLOWED_READINESS_STATUS:
            failures.append(
                f"{section_name}: status must be one of "
                + ", ".join(sorted(ALLOWED_READINESS_STATUS))
            )
        if not isinstance(section.get("release_blocking"), bool):
            failures.append(f"{section_name}: release_blocking must be true or false")
        if section.get("release_blocking") is True and not as_list(section.get("blockers")):
            failures.append(f"{section_name}: release-blocking sections require blockers")

        required_artifacts = section.get("required_artifacts")
        if not isinstance(required_artifacts, list) or not required_artifacts:
            failures.append(f"{section_name}: missing required_artifacts")
            continue
        for index, artifact in enumerate(required_artifacts):
            artifact_name = f"required_artifacts[{index}]"
            if not isinstance(artifact, dict):
                failures.append(f"{section_name}.{artifact_name}: artifact must be a mapping")
                continue
            if not isinstance(artifact.get("name"), str) or not artifact["name"]:
                failures.append(f"{section_name}.{artifact_name}: missing name")
            validate_relative_globs(
                section_name, artifact.get("name", artifact_name), artifact.get("globs"), failures
            )
            artifact_status = artifact.get("status")
            if artifact_status not in {"missing", "draft", "complete"}:
                failures.append(
                    f"{section_name}.{artifact.get('name', artifact_name)}: "
                    "status must be missing, draft, or complete"
                )
    return failures


def validate_openlane_configs(root: Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    configs = manifest.get("openlane_configs")
    if not isinstance(configs, dict):
        return ["manifest must list openlane_configs.release and openlane_configs.exploratory"]

    release_configs = as_list(configs.get("release"))
    exploratory_configs = as_list(configs.get("exploratory"))
    if not release_configs:
        failures.append("openlane_configs.release must list fail-closed release configs")
    if not exploratory_configs:
        failures.append(
            "openlane_configs.exploratory must list non-release local iteration configs"
        )

    def load_config(mode: str, entry: str) -> dict | None:
        path = Path(entry)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"openlane_configs.{mode}: config path must be relative: {entry}")
            return None
        full_path = root / path
        if not full_path.is_file():
            failures.append(f"openlane_configs.{mode}: missing config: {entry}")
            return None
        try:
            payload = json.loads(full_path.read_text())
        except json.JSONDecodeError as exc:
            failures.append(f"openlane_configs.{mode}: invalid JSON in {entry}: {exc}")
            return None
        if not isinstance(payload, dict):
            failures.append(f"openlane_configs.{mode}: config must be a JSON object: {entry}")
            return None
        return payload

    for entry in release_configs:
        payload = load_config("release", entry)
        if payload is None:
            continue
        fail_open = sorted(key for key in RELEASE_FAIL_CLOSED_KEYS if payload.get(key) is not True)
        if fail_open:
            failures.append(
                f"openlane_configs.release: {entry} must set fail-closed keys true: "
                + ", ".join(fail_open)
            )

    for entry in exploratory_configs:
        payload = load_config("exploratory", entry)
        if payload is None:
            continue
        if entry.endswith(".exploratory.json"):
            explicit_fail_open = [
                key for key in RELEASE_FAIL_CLOSED_KEYS if payload.get(key) is False
            ]
            if not explicit_fail_open:
                failures.append(
                    f"openlane_configs.exploratory: {entry} should explicitly differ from release fail-closed configs"
                )
    return failures


def check_reports(
    paths: list[Path], fail_regex: str | None, pass_regex: str | None
) -> tuple[list[str], list[str]]:
    dirty: list[str] = []
    missing_clean_marker: list[str] = []
    fail_pattern = None if not fail_regex else re.compile(fail_regex)
    pass_pattern = re.compile(pass_regex) if pass_regex else None
    for path in paths:
        text = path.read_text(errors="ignore")
        if fail_pattern and fail_pattern.search(text):
            dirty.append(str(path))
        if pass_pattern and not pass_pattern.search(text):
            missing_clean_marker.append(str(path))
    return dirty, missing_clean_marker


def validate_manifest(manifest_path: Path, manifest: dict) -> list[str]:
    failures: list[str] = []
    root = manifest_path.parents[2]
    run_roots = as_list(manifest.get("run_roots"))
    required = manifest.get("required_artifacts")
    runner = manifest.get("runner")

    if not isinstance(manifest.get("signoff"), str) or not manifest["signoff"]:
        failures.append("manifest must name signoff")
    run_manifest_schema = manifest.get("run_manifest_schema")
    if not isinstance(run_manifest_schema, str) or not run_manifest_schema:
        failures.append("manifest must list run_manifest_schema")
    else:
        schema_path = Path(run_manifest_schema)
        if schema_path.is_absolute() or ".." in schema_path.parts:
            failures.append(
                f"run_manifest_schema must be a relative repo path: {run_manifest_schema}"
            )
        elif not (root / schema_path).is_file():
            failures.append(f"run_manifest_schema points at missing file: {run_manifest_schema}")
    if not isinstance(runner, dict):
        failures.append("manifest must list runner metadata")
    else:
        image = runner.get("openlane_image")
        digest = runner.get("openlane_image_digest")
        if not isinstance(image, str) or not image:
            failures.append("runner.openlane_image must be a non-empty string")
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            failures.append("runner.openlane_image_digest must be a sha256 digest")
        if runner.get("require_pinned_runner_for_release") is not True:
            failures.append("runner.require_pinned_runner_for_release must be true")
    if not run_roots:
        failures.append("manifest must list run_roots")
    if not isinstance(required, dict):
        return failures + ["manifest has no required_artifacts"]

    missing = sorted(set(REQUIRED_ARTIFACTS) - set(required))
    extra = sorted(set(required) - set(REQUIRED_ARTIFACTS))
    if missing:
        failures.append("manifest missing required artifact classes: " + ", ".join(missing))
    if extra:
        failures.append("manifest has unknown artifact classes: " + ", ".join(extra))

    for run_root in run_roots:
        if Path(run_root).is_absolute() or ".." in Path(run_root).parts:
            failures.append(f"run_root must be a relative repo path: {run_root}")

    for name, spec in required.items():
        if not isinstance(spec, dict):
            failures.append(f"{name}: artifact spec must be a mapping")
            continue
        globs = as_list(spec.get("globs"))
        if not globs:
            failures.append(f"{name}: missing globs")
            continue
        extension = REQUIRED_ARTIFACTS.get(name)
        for pattern in globs:
            path = Path(pattern)
            if path.is_absolute() or ".." in path.parts:
                failures.append(f"{name}: glob must be a relative repo path: {pattern}")
            if run_roots and not any(
                pattern.startswith(f"{run_root.rstrip('/')}/*/") for run_root in run_roots
            ):
                failures.append(
                    f"{name}: glob must be scoped to one configured run root: {pattern}"
                )
            if extension and not pattern.endswith(extension):
                failures.append(f"{name}: glob must match {extension} files: {pattern}")
        if name.endswith("_report"):
            if not isinstance(spec.get("fail_regex"), str) or not spec["fail_regex"]:
                failures.append(f"{name}: report artifacts require fail_regex")
            if not isinstance(spec.get("pass_regex"), str) or not spec["pass_regex"]:
                failures.append(f"{name}: report artifacts require pass_regex")
        min_bytes = spec.get("min_bytes", 1)
        if not isinstance(min_bytes, int) or min_bytes < 1:
            failures.append(f"{name}: min_bytes must be a positive integer")

    waivers = manifest.get("waivers", {})
    if waivers and not isinstance(waivers, dict):
        failures.append("waivers must be a mapping")
    elif waivers:
        for pattern in as_list(waivers.get("globs")):
            path = Path(pattern)
            if path.is_absolute() or ".." in path.parts:
                failures.append(f"waiver glob must be a relative repo path: {pattern}")

    if manifest_path.name != "manifest.yaml":
        failures.append("signoff manifest file must be named manifest.yaml")
    failures.extend(validate_blocked_gates(root, manifest))
    failures.extend(validate_readiness_sections(manifest))
    failures.extend(validate_openlane_configs(root, manifest))
    return failures


def _validate_tool_digests(rel_manifest: Path, payload: dict) -> list[str]:
    failures: list[str] = []
    for field in sorted(TOOL_DIGEST_FIELDS):
        value = payload.get(field)
        if not isinstance(value, str) or not value:
            failures.append(
                f"run_manifest: {rel_manifest} {field} must be a sha256 digest or the literal 'unavailable'"
            )
            continue
        if value == "unavailable":
            reason_field = field.removesuffix("_digest") + "_unavailable_reason"
            reason = payload.get(reason_field)
            if not isinstance(reason, str) or not reason.strip():
                failures.append(
                    f"run_manifest: {rel_manifest} {field}='unavailable' requires {reason_field} (non-empty string)"
                )
            continue
        if not SHA256_DIGEST_RE.match(value):
            failures.append(
                f"run_manifest: {rel_manifest} {field} must match sha256:<64 hex chars>"
            )
    return failures


def _validate_psm_ir_drop_report(run_dir: Path, rel_manifest: Path, payload: dict) -> list[str]:
    failures: list[str] = []
    report = payload.get("psm_ir_drop_report")
    if not isinstance(report, str) or not report:
        failures.append(
            f"run_manifest: {rel_manifest} psm_ir_drop_report must be a non-empty path inside the run directory"
        )
        return failures
    report_path = (run_dir / report).resolve()
    try:
        report_path.relative_to(run_dir.resolve())
    except ValueError:
        failures.append(
            f"run_manifest: {rel_manifest} psm_ir_drop_report must stay inside the run directory: {report}"
        )
        return failures
    if not report_path.is_file():
        failures.append(
            f"run_manifest: {rel_manifest} psm_ir_drop_report missing PSM static IR-drop report: {report}"
        )
    return failures


def _validate_pdn_topology(run_dir: Path, rel_manifest: Path, payload: dict) -> list[str]:
    failures: list[str] = []
    topology = payload.get("pdn_topology")
    if not isinstance(topology, dict):
        failures.append(
            f"run_manifest: {rel_manifest} pdn_topology must be a mapping describing the PDN topology"
        )
        return failures
    missing = sorted(REQUIRED_PDN_TOPOLOGY_FIELDS - set(topology))
    if missing:
        failures.append(
            f"run_manifest: {rel_manifest} pdn_topology missing fields: {', '.join(missing)}"
        )
    for field in ("vertical_layer", "horizontal_layer"):
        value = topology.get(field)
        if not isinstance(value, str) or not value:
            failures.append(
                f"run_manifest: {rel_manifest} pdn_topology.{field} must be a non-empty string"
            )
    for field in (
        "vpitch_um",
        "hpitch_um",
        "vwidth_um",
        "hwidth_um",
        "vspacing_um",
        "hspacing_um",
    ):
        value = topology.get(field)
        if not isinstance(value, (int, float)) or value <= 0:
            failures.append(
                f"run_manifest: {rel_manifest} pdn_topology.{field} must be a positive number"
            )
    core_ring = topology.get("core_ring")
    if not isinstance(core_ring, dict):
        failures.append(f"run_manifest: {rel_manifest} pdn_topology.core_ring must be a mapping")
    else:
        missing_ring = sorted(REQUIRED_PDN_CORE_RING_FIELDS - set(core_ring))
        if missing_ring:
            failures.append(
                f"run_manifest: {rel_manifest} pdn_topology.core_ring missing fields: "
                + ", ".join(missing_ring)
            )
        if "enabled" in core_ring and not isinstance(core_ring["enabled"], bool):
            failures.append(
                f"run_manifest: {rel_manifest} pdn_topology.core_ring.enabled must be a boolean"
            )
        for field in (
            "vwidth_um",
            "hwidth_um",
            "voffset_um",
            "hoffset_um",
            "vspacing_um",
            "hspacing_um",
        ):
            if field in core_ring and (
                not isinstance(core_ring[field], (int, float)) or core_ring[field] < 0
            ):
                failures.append(
                    f"run_manifest: {rel_manifest} pdn_topology.core_ring.{field} must be a non-negative number"
                )
    report = topology.get("report")
    if isinstance(report, str) and report:
        report_path = (run_dir / report).resolve()
        try:
            report_path.relative_to(run_dir.resolve())
        except ValueError:
            failures.append(
                f"run_manifest: {rel_manifest} pdn_topology.report must stay inside the run directory: {report}"
            )
        else:
            if not report_path.is_file():
                failures.append(
                    f"run_manifest: {rel_manifest} pdn_topology.report missing pdngen topology dump: {report}"
                )
    elif "report" not in REQUIRED_PDN_TOPOLOGY_FIELDS or report is not None:
        failures.append(
            f"run_manifest: {rel_manifest} pdn_topology.report must be a non-empty path inside the run directory"
        )
    return failures


def validate_run_manifest(root: Path, run_dir: Path, run_manifest: Path) -> list[str]:
    failures: list[str] = []
    rel_manifest = run_manifest.relative_to(root)
    try:
        payload = yaml.safe_load(run_manifest.read_text())
    except yaml.YAMLError as exc:
        return [f"run_manifest: invalid YAML in {rel_manifest}: {exc}"]

    if not isinstance(payload, dict):
        return [f"run_manifest: {rel_manifest} must be a YAML mapping"]

    missing = sorted(REQUIRED_RUN_MANIFEST_FIELDS - set(payload))
    if missing:
        failures.append(f"run_manifest: {rel_manifest} missing fields: {', '.join(missing)}")

    if payload.get("design") != "e1_chip_top":
        failures.append(f"run_manifest: {rel_manifest} design must be e1_chip_top")
    for field in ("flow", "pdk", "std_cell_library", "openlane_image"):
        if is_placeholder(payload.get(field)):
            failures.append(
                f"run_manifest: {rel_manifest} {field} must not be empty or placeholder"
            )
    if payload.get("status") != "complete":
        failures.append(f"run_manifest: {rel_manifest} status must be complete")
    digest = payload.get("openlane_image_digest")
    if not isinstance(digest, str) or not SHA256_DIGEST_RE.match(digest):
        failures.append(
            f"run_manifest: {rel_manifest} openlane_image_digest must be a sha256 digest"
        )
    failures.extend(_validate_tool_digests(rel_manifest, payload))
    failures.extend(_validate_psm_ir_drop_report(run_dir, rel_manifest, payload))
    failures.extend(_validate_pdn_topology(run_dir, rel_manifest, payload))
    if not isinstance(payload.get("corners"), list) or not payload["corners"]:
        failures.append(f"run_manifest: {rel_manifest} corners must be a non-empty list")

    checks = payload.get("checks")
    if not isinstance(checks, dict):
        failures.append(f"run_manifest: {rel_manifest} checks must be a mapping")
    else:
        missing_checks = sorted(REQUIRED_RUN_CHECKS - set(checks))
        if missing_checks:
            failures.append(
                f"run_manifest: {rel_manifest} missing checks: {', '.join(missing_checks)}"
            )
        for check_name in sorted(REQUIRED_RUN_CHECKS & set(checks)):
            check = checks[check_name]
            if not isinstance(check, dict):
                failures.append(
                    f"run_manifest: {rel_manifest} checks.{check_name} must be a mapping"
                )
                continue
            if check.get("status") not in {"blocked", "clean", "waived"}:
                failures.append(
                    f"run_manifest: {rel_manifest} checks.{check_name}.status must be blocked, clean, or waived"
                )
            if check.get("status") == "waived":
                waiver = check.get("waiver")
                if not isinstance(waiver, str) or not waiver:
                    failures.append(
                        f"run_manifest: {rel_manifest} checks.{check_name}.waiver is required for waived checks"
                    )
            if check.get("status") == "blocked":
                reason = check.get("reason")
                if not isinstance(reason, str) or not reason:
                    failures.append(
                        f"run_manifest: {rel_manifest} checks.{check_name}.reason is required for blocked checks"
                    )
                else:
                    failures.append(
                        f"run_manifest: {rel_manifest} checks.{check_name} is blocked: {reason}"
                    )
            report = check.get("report")
            if not isinstance(report, str) or not report:
                failures.append(
                    f"run_manifest: {rel_manifest} checks.{check_name}.report is required"
                )
            else:
                report_path = (run_dir / report).resolve()
                try:
                    report_path.relative_to(run_dir.resolve())
                except ValueError:
                    failures.append(
                        f"run_manifest: {rel_manifest} checks.{check_name}.report must stay inside the run directory"
                    )
                if not report_path.is_file():
                    failures.append(
                        f"run_manifest: {rel_manifest} checks.{check_name}.report missing: {report}"
                    )

    for section_name in ("inputs", "outputs"):
        section = payload.get(section_name)
        if not isinstance(section, dict):
            failures.append(f"run_manifest: {rel_manifest} {section_name} must be a mapping")
            continue
        for item_name, value in section.items():
            if isinstance(value, str):
                values = [value]
            elif isinstance(value, list) and all(isinstance(item, str) for item in value):
                values = value
            else:
                failures.append(
                    f"run_manifest: {rel_manifest} {section_name}.{item_name} must be a path string or list of path strings"
                )
                continue
            for entry in values:
                entry_path = (run_dir / entry).resolve()
                try:
                    entry_path.relative_to(run_dir.resolve())
                except ValueError:
                    failures.append(
                        f"run_manifest: {rel_manifest} {section_name}.{item_name} must stay inside the run directory: {entry}"
                    )
                if section_name == "outputs" and not entry_path.is_file():
                    label = ARTIFACT_LABELS.get(item_name, item_name)
                    failures.append(
                        f"run_manifest: {rel_manifest} outputs.{item_name} missing {label}: {entry}"
                    )

    outputs = payload.get("outputs")
    if isinstance(outputs, dict):
        missing_outputs = sorted(set(RUN_OUTPUT_SPECS) - set(outputs))
        if missing_outputs:
            failures.append(
                f"run_manifest: {rel_manifest} outputs missing required artifacts: "
                + artifact_list(missing_outputs)
            )
        for item_name, (extension, label) in RUN_OUTPUT_SPECS.items():
            value = outputs.get(item_name)
            if isinstance(value, str):
                values = [value]
            elif isinstance(value, list):
                values = value
            else:
                values = []
            if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
                continue
            for entry in values:
                if not entry.endswith(extension):
                    failures.append(
                        f"run_manifest: {rel_manifest} outputs.{item_name} must point to {extension} {label}: {entry}"
                    )

    return failures


def run_dirs(root: Path, run_roots: list[str]) -> list[Path]:
    dirs: list[Path] = []
    for run_root in run_roots:
        base = root / run_root
        if base.is_dir():
            dirs.extend(sorted(path for path in base.iterdir() if path.is_dir()))
    return dirs


def files_for_run(run_dir: Path, run_root: str, globs: list[str]) -> list[Path]:
    files: list[Path] = []
    prefix = f"{run_root.rstrip('/')}/*/"
    for pattern in globs:
        if pattern.startswith(prefix):
            files.extend(
                sorted(path for path in run_dir.glob(pattern[len(prefix) :]) if path.is_file())
            )
    return files


def release_manifest_files(root: Path, run_dir: Path, files: list[Path]) -> list[Path]:
    eligible: list[Path] = []
    for path in files:
        try:
            payload = yaml.safe_load(path.read_text())
        except yaml.YAMLError:
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("design") == "e1_chip_top" and payload.get("status") == "complete":
            eligible.append(path)
    return eligible


def choose_complete_run(
    root: Path, manifest: dict
) -> tuple[Path | None, dict[str, list[Path]], dict[Path, list[str]]]:
    required = manifest["required_artifacts"]
    run_roots = as_list(manifest["run_roots"])
    best_run: Path | None = None
    best_artifacts: dict[str, list[Path]] = {}
    missing_by_run: dict[Path, list[str]] = {}

    for run_dir in run_dirs(root, run_roots):
        run_root = str(run_dir.parent.relative_to(root))
        artifacts: dict[str, list[Path]] = {}
        missing: list[str] = []
        for name, spec in required.items():
            files = files_for_run(run_dir, run_root, spec["globs"])
            if name == "run_manifest":
                files = release_manifest_files(root, run_dir, files)
            if files:
                artifacts[name] = files
            else:
                missing.append(name)
        missing_by_run[run_dir] = missing
        if best_run is None or len(missing) < len(missing_by_run[best_run]):
            best_run = run_dir
            best_artifacts = artifacts
        if not missing:
            return run_dir, artifacts, missing_by_run
    return None, best_artifacts, missing_by_run


def closest_run_diagnostics(root: Path, manifest: dict, missing_by_run: dict[Path, list[str]]) -> dict:
    required = manifest.get("required_artifacts", {})
    required_count = len(required) if isinstance(required, dict) else 0
    rows = []
    for run_dir, missing in missing_by_run.items():
        rows.append(
            {
                "run": run_dir.relative_to(root).as_posix(),
                "present_count": required_count - len(missing),
                "missing_count": len(missing),
                "missing_artifact_classes": artifact_gap_rows(manifest, missing),
                "next_command": (
                    "scripts/run_openlane.sh --release && "
                    "python3 scripts/check_pd_signoff.py"
                ),
                "release_credit": False,
            }
        )
    rows.sort(key=lambda item: (-item["present_count"], item["missing_count"], item["run"]))
    closest = rows[0] if rows else None
    return {
        "release_credit": False,
        "claim_boundary": (
            "Closest-run matching is an artifact-presence diagnostic only. It does not "
            "waive dirty reports and does not prove DRC, LVS, antenna, timing, or DRV closure."
        ),
        "required_artifact_count": required_count,
        "closest_run": closest,
        "closest_runs": rows[:8],
        "required_next_commands": [
            "scripts/run_openlane.sh --release",
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/openlane_pd_blocker_summary.py --write-report",
        ],
    }


def report_blocker_diagnostics(root: Path, manifest: dict, complete_run: Path | None) -> dict:
    artifact_paths = {
        "drc": ["drc_report", "klayout_drc_report"],
        "lvs": ["lvs_report"],
        "antenna": ["antenna_report"],
        "timing": ["sta_report", "spef", "sdf", "corner_manifest", "sdc"],
        "drv": ["congestion_report", "utilization_report"],
    }
    blocked_release_gates = []
    gates = manifest.get("blocked_gates", {})
    if isinstance(gates, dict):
        for gate_name, gate in sorted(gates.items()):
            if isinstance(gate, dict) and gate.get("blocked") is True:
                blocked_release_gates.append(
                    {
                        "gate": gate_name,
                        "reason": gate.get("reason"),
                        "evidence_manifest": gate.get("evidence_manifest"),
                        "unblock_requires": gate.get("unblock_requires", []),
                        "release_credit": False,
                    }
                )
    return {
        "release_credit": False,
        "claim_boundary": (
            "These blocker classes are derived from manifest artifacts and parsed reports. "
            "They are diagnostics only; release still requires clean or formally waived signoff."
        ),
        "selected_run": complete_run.relative_to(root).as_posix() if complete_run else None,
        "blocked_release_gates": blocked_release_gates,
        "blocked_release_gate_count": len(blocked_release_gates),
        "blocker_classes": {
            class_name: {
                "artifact_classes": names,
                "expected_artifact_paths": artifact_gap_rows(manifest, names),
                "next_command": (
                    "scripts/run_openlane.sh --release && "
                    "python3 scripts/check_pd_signoff.py"
                ),
                "release_credit": False,
            }
            for class_name, names in artifact_paths.items()
        },
    }


def validate_release_closure_metrics(run_dir: Path) -> list[str]:
    metrics, failures = check_pd_closure.load_metrics(run_dir)
    if metrics:
        failures.extend(check_pd_closure.check_metrics(metrics))
    failures.extend(check_pd_closure.check_run_manifest(run_dir))
    failures.extend(check_pd_closure.check_waivers(run_dir))
    return failures


def main() -> int:
    parser = ArgumentParser(description="Validate PD signoff artifact manifest.")
    parser.add_argument("--manifest", default="pd/signoff/manifest.yaml")
    parser.add_argument(
        "--manifest-only",
        action="store_true",
        help="validate manifest shape without requiring run artifacts",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    manifest_path = root / args.manifest
    manifest_text = manifest_path.read_text()
    duplicate_key_failures = validate_no_duplicate_yaml_keys(manifest_text)
    if duplicate_key_failures:
        write_report("fail", "manifest", manifest_path, duplicate_key_failures)
        print("PD signoff artifact check failed:")
        for failure in duplicate_key_failures:
            print(f"  - {failure}")
        return 1

    manifest = yaml.safe_load(manifest_text)
    if not isinstance(manifest, dict):
        write_report("fail", "manifest", manifest_path, ["manifest must be a YAML mapping"])
        print("PD signoff artifact check failed:")
        print("  - manifest must be a YAML mapping")
        return 1

    required = manifest.get("required_artifacts", {})
    failures = validate_manifest(manifest_path, manifest)
    dirty_reports: list[str] = []
    missing_clean_markers: list[str] = []

    if args.manifest_only or failures:
        if failures:
            write_report("fail", "manifest", manifest_path, failures)
            print("PD signoff artifact check failed:")
            for failure in failures:
                print(f"  - {failure}")
            return 1
        write_report("pass", "manifest", manifest_path, [])
        print("PD signoff manifest check ok")
        return 0

    run_roots = as_list(manifest["run_roots"])
    complete_run, artifacts, missing_by_run = choose_complete_run(root, manifest)
    if not missing_by_run:
        failures.append("no PD run directories found under run_roots: " + ", ".join(run_roots))
    elif complete_run is None:
        best_run = min(missing_by_run, key=lambda run: len(missing_by_run[run]))
        failures.append(
            "no single PD run contains all required signoff artifacts; "
            f"closest run {best_run.relative_to(root)} is missing "
            f"{len(missing_by_run[best_run])} required artifact class(es): "
            + artifact_list(missing_by_run[best_run])
        )
    else:
        print(f"Checking PD signoff run: {complete_run.relative_to(root)}")
        for name, files in artifacts.items():
            spec = required[name]
            min_bytes = spec.get("min_bytes", 1)
            empty = [path for path in files if path.stat().st_size < min_bytes]
            for path in empty:
                failures.append(
                    f"{name}: artifact is smaller than min_bytes={min_bytes}: {path.relative_to(root)}"
                )
            if name.endswith("_report"):
                dirty, missing_clean = check_reports(
                    files, spec.get("fail_regex"), spec.get("pass_regex")
                )
                dirty_reports.extend(dirty)
                missing_clean_markers.extend(missing_clean)
                for report_path in missing_clean:
                    failures.append(f"{name}: report missing required clean marker: {report_path}")
        for run_manifest in artifacts.get("run_manifest", []):
            failures.extend(validate_run_manifest(root, complete_run, run_manifest))
        failures.extend(validate_release_closure_metrics(complete_run))

    waiver_spec = manifest.get("waivers", {})
    waivers = matched_files(root, waiver_spec.get("globs", []))
    blocked_gates = manifest.get("blocked_gates", {})
    if isinstance(blocked_gates, dict):
        for gate_name, gate in blocked_gates.items():
            if isinstance(gate, dict) and gate.get("blocked") is True:
                failures.append(f"release gate remains blocked: {gate_name}: {gate.get('reason')}")
    if dirty_reports and waiver_spec.get("required_if_any_report_dirty", False) and not waivers:
        failures.append("dirty signoff reports found but no waiver file is present")
        for report_path in dirty_reports:
            failures.append(f"signoff report matched failure regex: {report_path}")
        for report_path in missing_clean_markers:
            failures.append(f"signoff report missing required clean marker: {report_path}")

    if failures:
        diagnostics = {
            "artifact_gap": closest_run_diagnostics(root, manifest, missing_by_run),
            "blocker_classes": report_blocker_diagnostics(root, manifest, complete_run),
        }
        write_report("blocked", "artifacts", manifest_path, failures, diagnostics=diagnostics)
        print("STATUS: BLOCKED PD signoff artifact check")
        print("PD signoff artifact check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 2

    mode = "manifest" if args.manifest_only else "artifacts"
    write_report("pass", mode, manifest_path, [])
    print(f"PD signoff {mode} check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
