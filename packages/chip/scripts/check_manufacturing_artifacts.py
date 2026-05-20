#!/usr/bin/env python3
import hashlib
import json
import re
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFESTS = [
    "docs/manufacturing/artifact-manifest.yaml",
    "package/artifact-manifest.yaml",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml",
    "board/fpga/artifact-manifest.yaml",
]
ALLOWED_STATUS = {"missing", "draft", "complete"}
ALLOWED_MANIFEST_STATUS = {
    "missing",
    "draft",
    "scaffold",
    "pipeline_scaffold",
    "release_blocked",
    "complete",
}
REQUIRED_KICAD_COMMANDS = {"erc", "drc", "gerbers", "drill", "bom", "position"}
REQUIRED_FPGA_COMMANDS = {"synth", "place_route", "pack"}
ALLOWED_RELEASE_GATES = {"pd_release", "tapeout_release", "board_fabrication_release"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CHECKSUM_METADATA_RE = re.compile(r"(^|_)checksum$")
DIRTY_SOURCE_RE = re.compile(r"(\+working-tree|dirty|uncommitted)", re.I)
REQUIRED_GROUP_ARTIFACT_ALIASES = {
    "manufacturing_physical_evidence": {
        "kicad_project": [
            {"kicad_project", "project"},
            {"kicad_schematic", "schematic"},
            {"kicad_pcb", "pcb"},
            {"kicad_symbol_and_footprint_libraries", "vendor_derived_footprint"},
        ],
        "kicad_fabrication_outputs": [
            {"erc_transcript", "erc_report"},
            {"drc_transcript", "drc_report"},
            {"gerber_archive", "gerbers"},
            {"drill_archive", "drill"},
            {"fabrication_bom", "bom"},
            {"pick_and_place", "position"},
        ],
    },
    "e1_demo_kicad_board_evidence": {
        "kicad_sources": [
            {"project", "kicad_project"},
            {"schematic", "kicad_schematic"},
            {"pcb", "kicad_pcb"},
            {"vendor_derived_footprint", "kicad_symbol_and_footprint_libraries"},
        ],
        "kicad_cli_outputs": [
            {"erc_report", "erc_transcript"},
            {"drc_report", "drc_transcript"},
            {"gerbers", "gerber_archive"},
            {"drill", "drill_archive"},
            {"bom", "fabrication_bom"},
            {"pick_and_place", "position"},
        ],
    },
    "e1_demo_fpga_bitstream_evidence": {
        "target_contract": [
            {"fpga_target_contract"},
            {"pin_constraints", "final_pin_constraints"},
        ],
        "bitstream_release": [
            {"bitstream", "ecppack_bitstream"},
            {"nextpnr_timing_report", "nextpnr_timing"},
            {"nextpnr_route_report", "nextpnr_route"},
            {"ecppack_transcript", "pack_transcript"},
            {"fpga_tool_versions", "tool_versions"},
        ],
    },
}


def as_list(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def repo_path(value: str) -> Path:
    return ROOT / value


def validate_schema_ref(manifest_name: str, schema_ref: object, failures: list[str]) -> None:
    if not isinstance(schema_ref, str) or not schema_ref:
        failures.append(f"{manifest_name}: missing schema")
        return
    path = Path(schema_ref)
    if path.is_absolute() or ".." in path.parts:
        failures.append(f"{manifest_name}: schema must be a relative repo path: {schema_ref}")
    elif not repo_path(schema_ref).is_file():
        failures.append(f"{manifest_name}: referenced schema is missing: {schema_ref}")


def validate_globs(field: str, globs: object, failures: list[str]) -> list[str]:
    glob_list = as_list(globs)
    if not glob_list:
        failures.append(f"{field}: missing globs")
        return []
    for pattern in glob_list:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{field}: glob must be a relative repo path: {pattern}")
    return glob_list


def validate_metadata(
    field: str,
    artifact: dict,
    status: object,
    release: bool,
    failures: list[str],
) -> None:
    required_metadata = artifact.get("required_metadata", [])
    required_keys = as_list(required_metadata)
    if required_metadata and not required_keys:
        failures.append(f"{field}: required_metadata must be a list of strings")
        return

    metadata = artifact.get("metadata", {})
    if metadata and not isinstance(metadata, dict):
        failures.append(f"{field}: metadata must be a mapping")
        metadata = {}
    if isinstance(metadata, dict):
        for key, value in metadata.items():
            if not isinstance(key, str) or not key:
                failures.append(f"{field}: metadata keys must be non-empty strings")
            if value is None or value == "":
                failures.append(f"{field}.metadata.{key}: metadata value must be non-empty")

    metadata_globs = artifact.get("metadata_globs", [])
    metadata_glob_list = as_list(metadata_globs)
    if metadata_globs and not metadata_glob_list:
        failures.append(f"{field}: metadata_globs must be a list of strings")
    for pattern in metadata_glob_list:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{field}: metadata glob must be a relative repo path: {pattern}")

    if required_keys and (release or status == "complete"):
        metadata_keys = set(metadata) if isinstance(metadata, dict) else set()
        missing_keys = sorted(set(required_keys) - metadata_keys)
        metadata_files = matching_files(metadata_glob_list)
        if missing_keys and not metadata_files:
            mode = "release" if release else "status complete"
            failures.append(
                f"{field}: {mode} requires metadata fields or metadata_globs for: "
                + ", ".join(missing_keys)
            )

    if isinstance(metadata, dict):
        for key in sorted(k for k in required_keys if CHECKSUM_METADATA_RE.search(k)):
            value = metadata.get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                failures.append(
                    f"{field}.metadata.{key}: checksum must be a lowercase sha256 hex digest"
                )
        source_revision = metadata.get("source_revision")
        if (
            (release or status == "complete")
            and isinstance(source_revision, str)
            and DIRTY_SOURCE_RE.search(source_revision)
        ):
            failures.append(
                f"{field}.metadata.source_revision: release/status complete cannot "
                "reference a dirty working tree revision"
            )

    checksum_manifest = artifact.get("checksum_manifest")
    if checksum_manifest is not None:
        if not isinstance(checksum_manifest, str) or not checksum_manifest:
            failures.append(f"{field}: checksum_manifest must be a repo-relative path")
        else:
            path = Path(checksum_manifest)
            if path.is_absolute() or ".." in path.parts:
                failures.append(
                    f"{field}: checksum_manifest must be a relative repo path: {checksum_manifest}"
                )
            elif release and not repo_path(checksum_manifest).is_file():
                failures.append(
                    f"{field}: release checksum_manifest is missing: {checksum_manifest}"
                )


def matching_files(globs: list[str]) -> list[Path]:
    files: list[Path] = []
    for pattern in globs:
        files.extend(sorted(path for path in ROOT.glob(pattern) if path.is_file()))
    return files


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def check_report_markers(
    artifact_name: str, artifact: dict, files: list[Path], failures: list[str]
) -> None:
    fail_regex = artifact.get("fail_regex")
    clean_regex = artifact.get("clean_regex")
    fail_pattern = re.compile(fail_regex) if isinstance(fail_regex, str) and fail_regex else None
    clean_pattern = (
        re.compile(clean_regex) if isinstance(clean_regex, str) and clean_regex else None
    )
    for path in files:
        text = path.read_text(errors="ignore")
        rel = path.relative_to(ROOT)
        if fail_pattern and fail_pattern.search(text):
            failures.append(f"{artifact_name}: report matched failure regex: {rel}")
        if clean_pattern and not clean_pattern.search(text):
            failures.append(f"{artifact_name}: report missing clean marker: {rel}")


def validate_required_artifact_names(
    manifest_name: str,
    group_name: str,
    artifacts: list[object],
    failures: list[str],
) -> None:
    required_by_group = REQUIRED_GROUP_ARTIFACT_ALIASES.get(manifest_name, {})
    required_aliases = required_by_group.get(group_name)
    if not required_aliases:
        return

    names = {
        artifact.get("name")
        for artifact in artifacts
        if isinstance(artifact, dict) and isinstance(artifact.get("name"), str)
    }
    missing = [
        "/".join(sorted(aliases)) for aliases in required_aliases if names.isdisjoint(aliases)
    ]
    if missing:
        failures.append(
            f"{manifest_name}.{group_name}: missing required artifact names: " + ", ".join(missing)
        )


def validate_artifact(
    manifest_name: str,
    group_name: str,
    artifact: object,
    release: bool,
    failures: list[str],
) -> None:
    field = f"{manifest_name}.{group_name}"
    if not isinstance(artifact, dict):
        failures.append(f"{field}: artifact must be a mapping")
        return
    name = artifact.get("name")
    if not isinstance(name, str) or not name:
        failures.append(f"{field}: artifact missing name")
        name = "unnamed"
    status = artifact.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(f"{field}.{name}: status must be missing, draft, or complete")
    globs = validate_globs(f"{field}.{name}", artifact.get("globs"), failures)

    metadata = artifact.get("required_metadata", [])
    if metadata and not as_list(metadata):
        failures.append(f"{field}.{name}: required_metadata must be a list of strings")
    validate_metadata(f"{field}.{name}", artifact, status, release, failures)

    files = matching_files(globs)
    if status == "complete" and not files:
        failures.append(f"{field}.{name}: status complete but artifact files are missing")
    if status == "missing" and files:
        failures.append(f"{field}.{name}: status missing but artifact files exist")
    if release:
        if status != "complete":
            failures.append(f"{field}.{name}: release requires status complete, got {status}")
        if not files:
            failures.append(f"{field}.{name}: release artifact files are missing")
        check_report_markers(name, artifact, files, failures)


def resolved_manifest(manifest_paths: list[str]) -> dict:
    manifests: list[dict] = []
    for manifest in manifest_paths:
        path = repo_path(manifest)
        if not path.is_file():
            manifests.append({"path": manifest, "exists": False, "artifact_groups": []})
            continue
        data = yaml.safe_load(path.read_text())
        if not isinstance(data, dict):
            manifests.append(
                {
                    "path": manifest,
                    "exists": True,
                    "parseable": False,
                    "artifact_groups": [],
                }
            )
            continue

        groups_out: list[dict] = []
        if data.get("schema") == "eliza.e1_phone_board_artifact_manifest.v1":
            groups = data.get("current_artifacts", {})
            if isinstance(groups, dict):
                for group_name in sorted(str(name) for name in groups):
                    paths = as_list(groups[group_name])
                    artifacts_out: list[dict[str, object]] = []
                    for rel_path in paths:
                        path_obj = repo_path(rel_path)
                        files = []
                        if path_obj.is_file():
                            files.append(
                                {
                                    "path": rel_path,
                                    "sha256": file_sha256(path_obj),
                                    "size_bytes": path_obj.stat().st_size,
                                }
                            )
                        artifacts_out.append(
                            {
                                "name": rel_path,
                                "status": "draft" if files else "missing",
                                "globs": [rel_path],
                                "files": files,
                            }
                        )
                    groups_out.append(
                        {
                            "name": group_name,
                            "status": "draft",
                            "artifacts": artifacts_out,
                        }
                    )
        groups = data.get("artifact_groups", {})
        if not groups_out and isinstance(groups, dict):
            for group_name in sorted(str(name) for name in groups):
                group = groups[group_name]
                if not isinstance(group, dict):
                    continue
                artifacts_out: list[dict[str, object]] = []
                artifacts = group.get("artifacts", [])
                if isinstance(artifacts, list):
                    for artifact in artifacts:
                        if not isinstance(artifact, dict):
                            continue
                        globs = as_list(artifact.get("globs"))
                        files = [
                            {
                                "path": relative(file_path),
                                "sha256": file_sha256(file_path),
                                "size_bytes": file_path.stat().st_size,
                            }
                            for file_path in matching_files(globs)
                        ]
                        artifacts_out.append(
                            {
                                "name": artifact.get("name"),
                                "status": artifact.get("status"),
                                "globs": sorted(globs),
                                "files": files,
                            }
                        )
                groups_out.append(
                    {
                        "name": group_name,
                        "status": group.get("status"),
                        "artifacts": sorted(
                            artifacts_out, key=lambda item: str(item.get("name") or "")
                        ),
                    }
                )
        manifests.append(
            {
                "path": manifest,
                "exists": True,
                "parseable": True,
                "manifest": data.get("manifest"),
                "status": data.get("status"),
                "artifact_groups": groups_out,
            }
        )

    return {
        "schema": "eliza.manufacturing.resolved_artifact_manifest.v1",
        "claim": "deterministic local file inventory only; not release readiness",
        "manifests": manifests,
    }


def validate_e1_phone_manifest(path: Path, release: bool) -> list[str]:
    failures: list[str] = []
    rel_manifest = path.relative_to(ROOT).as_posix()
    try:
        manifest = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{rel_manifest}: invalid YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{rel_manifest}: manifest must be a mapping"]
    if manifest.get("schema") != "eliza.e1_phone_board_artifact_manifest.v1":
        failures.append(f"{rel_manifest}: unexpected phone manifest schema")
    status = manifest.get("status")
    if status != "blocked_not_fabrication_ready":
        failures.append(f"{rel_manifest}: phone manifest must remain blocked, got {status}")
    if release:
        failures.append(
            f"{rel_manifest}: release requires routed/fabrication/enclosure evidence, got {status}"
        )

    target = manifest.get("design_target", {})
    expected_target = {
        "usb_c_ports": 1,
        "side_buttons": ["power", "volume_up", "volume_down"],
        "board_bbox_mm": {"width": 64.0, "height": 132.0},
        "battery_window_mm": {"width": 64.0, "height": 87.0},
    }
    if not isinstance(target, dict):
        failures.append(f"{rel_manifest}: missing design_target")
        target = {}
    for key, expected in expected_target.items():
        if target.get(key) != expected:
            failures.append(
                f"{rel_manifest}: design_target.{key} expected {expected}, got {target.get(key)}"
            )
    radios = target.get("radios", [])
    for radio in ["5g_redcap_cellular", "wifi_6e", "bluetooth_5_3"]:
        if radio not in radios:
            failures.append(f"{rel_manifest}: design target missing radio {radio}")

    groups = manifest.get("current_artifacts")
    if not isinstance(groups, dict):
        failures.append(f"{rel_manifest}: missing current_artifacts")
        groups = {}
    required_groups = {
        "planning",
        "package_bindings",
        "schematic_scaffold",
        "kicad_concept",
        "preview_artifacts",
    }
    missing_groups = sorted(required_groups - set(groups))
    if missing_groups:
        failures.append(
            f"{rel_manifest}: missing current_artifacts groups: {', '.join(missing_groups)}"
        )
    required_paths = {
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/procurement-readiness.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
        "board/kicad/e1-phone/preview/kicad-cli-mainboard.svg",
        "board/kicad/e1-phone/preview/kicad-cli-mainboard.png",
    }
    all_paths = {item for paths in groups.values() for item in as_list(paths)}
    for required in sorted(required_paths):
        if required not in all_paths:
            failures.append(f"{rel_manifest}: current_artifacts missing {required}")
    for rel_path in sorted(all_paths):
        path_obj = repo_path(rel_path)
        if not path_obj.is_file():
            failures.append(f"{rel_manifest}: current artifact file is missing: {rel_path}")
            continue
        if path_obj.suffix in {".yaml", ".yml"}:
            try:
                yaml.safe_load(path_obj.read_text())
            except yaml.YAMLError as exc:
                failures.append(f"{rel_manifest}: current artifact YAML invalid {rel_path}: {exc}")

    gates = manifest.get("release_gates", {})
    if not isinstance(gates, dict):
        failures.append(f"{rel_manifest}: release_gates must be a mapping")
        gates = {}
    required_gates = {
        "schematic",
        "routed_pcb",
        "enclosure",
        "power_thermal",
        "rf_si",
        "manufacturing",
    }
    missing_gates = sorted(required_gates - set(gates))
    if missing_gates:
        failures.append(f"{rel_manifest}: missing release gates: {', '.join(missing_gates)}")
    for gate_name, gate in gates.items():
        if not isinstance(gate, dict):
            failures.append(f"{rel_manifest}.release_gates.{gate_name}: gate must be a mapping")
            continue
        if gate.get("status") != "missing":
            failures.append(
                f"{rel_manifest}.release_gates.{gate_name}: expected missing, got {gate.get('status')}"
            )
        evidence = gate.get("required_evidence", [])
        if not as_list(evidence):
            failures.append(f"{rel_manifest}.release_gates.{gate_name}: missing required_evidence")
        if release:
            failures.append(
                f"{rel_manifest}.release_gates.{gate_name}: release gate remains missing"
            )

    routed_plan_path = repo_path("board/kicad/e1-phone/routed-release-plan.yaml")
    if routed_plan_path.is_file():
        routed_plan = yaml.safe_load(routed_plan_path.read_text())
        if (
            routed_plan.get("status")
            != "blocked_routed_release_requires_real_route_and_supplier_outputs"
        ):
            failures.append(f"{rel_manifest}: routed release plan status is not fail-closed")
        outputs = routed_plan.get("required_release_output_manifest", {})
        if not isinstance(outputs, dict) or len(outputs) < 20:
            failures.append(
                f"{rel_manifest}: routed release plan must track at least 20 release outputs"
            )
        else:
            for output_name, output in outputs.items():
                if not isinstance(output, dict):
                    failures.append(
                        f"{rel_manifest}: routed output {output_name} must be a mapping"
                    )
                    continue
                if output.get("present") is not False or output.get("release_required") is not True:
                    failures.append(
                        f"{rel_manifest}: routed output {output_name} must be blocked and required"
                    )
                if release:
                    failures.append(
                        f"{rel_manifest}: release output remains missing: {output_name}"
                    )
    else:
        failures.append(f"{rel_manifest}: routed release plan is missing")

    forbidden = manifest.get("forbidden_claims_while_status_blocked", [])
    for claim in [
        "board_fabrication_ready",
        "enclosure_ready",
        "production_bom_ready",
        "rf_ready",
        "power_thermal_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in forbidden:
            failures.append(f"{rel_manifest}: missing forbidden claim {claim}")
    return failures


def validate_manifest(path: Path, release: bool) -> list[str]:
    failures: list[str] = []
    try:
        manifest = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{path.relative_to(ROOT)}: invalid YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{path.relative_to(ROOT)}: manifest must be a mapping"]
    if manifest.get("schema") == "eliza.e1_phone_board_artifact_manifest.v1":
        return validate_e1_phone_manifest(path, release)

    manifest_name = str(manifest.get("manifest") or path.relative_to(ROOT))
    release_gate = manifest.get("release_gate")
    if release_gate is not None and release_gate not in ALLOWED_RELEASE_GATES:
        failures.append(
            f"{manifest_name}: release_gate must be one of "
            + ", ".join(sorted(ALLOWED_RELEASE_GATES))
        )
    status = manifest.get("status")
    if not isinstance(status, str) or not status:
        failures.append(f"{manifest_name}: missing status")
    elif status not in ALLOWED_MANIFEST_STATUS:
        failures.append(
            f"{manifest_name}: status must be one of " + ", ".join(sorted(ALLOWED_MANIFEST_STATUS))
        )
    if release and status != "complete":
        failures.append(f"{manifest_name}: release requires manifest status complete, got {status}")
    validate_schema_ref(manifest_name, manifest.get("schema"), failures)

    referenced = as_list(manifest.get("artifact_manifests", []))
    for ref in referenced:
        ref_path = Path(ref)
        if ref_path.is_absolute() or ".." in ref_path.parts:
            failures.append(f"{manifest_name}: artifact manifest path must be relative: {ref}")
        elif not repo_path(ref).is_file():
            failures.append(f"{manifest_name}: referenced artifact manifest is missing: {ref}")

    gates = manifest.get("release_gates", {})
    if gates:
        if not isinstance(gates, dict):
            failures.append(f"{manifest_name}: release_gates must be a mapping")
        else:
            for gate_name, gate in gates.items():
                if not isinstance(gate, dict):
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: gate must be a mapping"
                    )
                    continue
                if not isinstance(gate.get("blocked"), bool):
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: blocked must be true or false"
                    )
                if release and gate.get("blocked") is True:
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: release gate remains blocked"
                    )
                if not isinstance(gate.get("reason"), str) or not gate["reason"]:
                    failures.append(f"{manifest_name}.release_gates.{gate_name}: missing reason")

    groups = manifest.get("artifact_groups")
    if not isinstance(groups, dict) or not groups:
        failures.append(f"{manifest_name}: missing artifact_groups")
        return failures
    required_groups = set(REQUIRED_GROUP_ARTIFACT_ALIASES.get(manifest_name, {}))
    missing_groups = sorted(required_groups - set(groups))
    if missing_groups:
        failures.append(
            f"{manifest_name}: missing required artifact_groups: " + ", ".join(missing_groups)
        )

    for group_name, group in groups.items():
        if not isinstance(group, dict):
            failures.append(f"{manifest_name}.{group_name}: group must be a mapping")
            continue
        group_status = group.get("status")
        if group_status not in ALLOWED_STATUS:
            failures.append(
                f"{manifest_name}.{group_name}: status must be missing, draft, or complete"
            )
        if release and group_status != "complete":
            failures.append(
                f"{manifest_name}.{group_name}: release requires group status complete, got {group_status}"
            )

        commands = group.get("cli_commands", {})
        if commands:
            if not isinstance(commands, dict):
                failures.append(f"{manifest_name}.{group_name}: cli_commands must be a mapping")
            elif "kicad" in group_name:
                missing_commands = sorted(REQUIRED_KICAD_COMMANDS - set(commands))
                if missing_commands:
                    failures.append(
                        f"{manifest_name}.{group_name}: missing KiCad CLI commands: "
                        + ", ".join(missing_commands)
                    )
            elif "bitstream" in group_name or "fpga" in group_name:
                missing_commands = sorted(REQUIRED_FPGA_COMMANDS - set(commands))
                if missing_commands:
                    failures.append(
                        f"{manifest_name}.{group_name}: missing FPGA CLI commands: "
                        + ", ".join(missing_commands)
                    )
            if isinstance(commands, dict):
                for command_name, command in commands.items():
                    if not isinstance(command, str) or not command:
                        failures.append(
                            f"{manifest_name}.{group_name}.{command_name}: CLI command must be a string"
                        )

        artifacts = group.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            failures.append(f"{manifest_name}.{group_name}: missing artifacts")
            continue
        validate_required_artifact_names(manifest_name, str(group_name), artifacts, failures)
        for artifact in artifacts:
            validate_artifact(manifest_name, str(group_name), artifact, release, failures)

    return failures


def main() -> int:
    parser = ArgumentParser(
        description="Validate package, board, SI/PI, current, thermal, and KiCad evidence manifests."
    )
    parser.add_argument(
        "--manifest",
        action="append",
        dest="manifests",
        help="manifest path to check; may be repeated",
    )
    parser.add_argument("--release", action="store_true", help="require complete release evidence")
    parser.add_argument(
        "--resolved-manifest",
        metavar="PATH",
        help="write a deterministic JSON inventory of matched artifact files and sha256 hashes",
    )
    args = parser.parse_args()

    failures: list[str] = []
    manifests = args.manifests or DEFAULT_MANIFESTS
    for manifest in manifests:
        path = repo_path(manifest)
        if not path.is_file():
            failures.append(f"missing manifest: {manifest}")
            continue
        failures.extend(validate_manifest(path, args.release))

    if args.resolved_manifest:
        out_path = repo_path(args.resolved_manifest)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(resolved_manifest(manifests), indent=2, sort_keys=True) + "\n"
        )

    if failures:
        mode = "release" if args.release else "preflight"
        print(f"manufacturing artifact {mode} check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    mode = "release" if args.release else "preflight"
    print(f"manufacturing artifact {mode} check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
