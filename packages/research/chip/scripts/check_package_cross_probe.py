#!/usr/bin/env python3
import json
import re
import sys
from argparse import ArgumentParser
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/package_cross_probe.json"
MANIFEST = ROOT / "package/artifact-manifest.yaml"
SCHEMA = "eliza.package_cross_probe.v1"
CLAIM_BOUNDARY = "package_padframe_board_cross_probe_only_not_vendor_package_release_evidence"
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "package_vendor_release_claim_allowed": False,
    "padframe_claim_allowed": False,
    "board_fabrication_claim_allowed": False,
    "cross_probe_signoff_claim_allowed": False,
    "foundry_io_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
CROSS_PROBE_DRAFT = (
    ROOT / "docs/manufacturing/evidence/package/"
    "package-vendor-padframe-action-inventory-2026-05-23.yaml"
)
VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)([0-9]+)$")
RELEASE_REQUIRED_GROUPS = {"package_vendor_release", "bond_and_cross_probe"}
RELEASE_REQUIRED_ARTIFACTS = {
    "vendor_package_drawing",
    "land_pattern_or_footprint_source",
    "package_material_assembly_constraints",
    "bond_diagram",
    "package_padframe_board_cross_probe",
}


def logical_name(name: str) -> str:
    match = VECTOR_PIN_RE.match(name)
    return match.group(1) if match else name


_POWER_PIN_GUARDS = {"USE_POWER_PINS"}


def parse_ports(path: Path) -> set[str]:
    text = path.read_text()
    module = re.search(r"module\s+e1_chip_top\s*\((.*?)\);", text, re.S)
    if not module:
        raise SystemExit("e1_chip_top module header not found")
    ports: set[str] = set()
    skipping: list[str] = []
    for raw in module.group(1).splitlines():
        line = raw.split("//", 1)[0].strip().rstrip(",")
        if not line:
            continue
        # Skip Verilog preprocessor directives and macros guarded by
        # USE_POWER_PINS — VPWR/VGND belong to the PDN, not the functional
        # board-side pinout.
        if line.startswith("`"):
            tokens = line.split()
            directive = tokens[0]
            if directive in {"`ifdef", "`ifndef"}:
                macro = tokens[1] if len(tokens) > 1 else ""
                skipping.append(macro)
            elif directive == "`endif":
                if skipping:
                    skipping.pop()
            continue
        if any(guard in _POWER_PIN_GUARDS for guard in skipping):
            continue
        ports.add(line.split()[-1].split("[", 1)[0])
    return ports


def board_nets_from_kicad(board_dir: Path) -> set[str]:
    nets: set[str] = set()
    for path in sorted(board_dir.glob("*.kicad_sch")) + sorted(board_dir.glob("*.kicad_pcb")):
        text = path.read_text(errors="ignore")
        nets.update(re.findall(r'\(net\s+\d+\s+"([^"]+)"\)', text))
        nets.update(re.findall(r'\(label\s+"([^"]+)"\)', text))
        nets.update(re.findall(r'\(global_label\s+"([^"]+)"', text))
    return nets


def as_list(value: object) -> list[str]:
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return value
    if isinstance(value, str) and value:
        return [value]
    return []


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def matching_files(patterns: list[str]) -> list[str]:
    files: list[str] = []
    for pattern in patterns:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            continue
        files.extend(rel(match) for match in sorted(ROOT.glob(pattern)) if match.is_file())
    return sorted(set(files))


def blocker_bucket(blocker: str) -> str:
    if "vendor package drawing" in blocker or "vendor_package_drawing" in blocker:
        return "vendor_package_drawing"
    if "land_pattern_or_footprint_source" in blocker or "footprint" in blocker:
        return "vendor_footprint_source"
    if "bond_diagram" in blocker or "Bond diagram" in blocker:
        return "bond_diagram"
    if "package_padframe_board_cross_probe" in blocker or "cross-probe" in blocker:
        return "package_padframe_board_cross_probe"
    if "padframe" in blocker or "DRC/LVS" in blocker or "foundry" in blocker:
        return "foundry_padframe_signoff"
    if "release requires" in blocker:
        return "manifest_promotion"
    return "other_package_release_blocker"


def next_step_for_bucket(bucket: str) -> str:
    steps = {
        "vendor_package_drawing": (
            "Attach the approved package-vendor drawing with revision, checksum, pin-1 "
            "orientation, and signed source metadata."
        ),
        "vendor_footprint_source": (
            "Regenerate the board land pattern from the approved vendor drawing and archive "
            "the source drawing checksum."
        ),
        "bond_diagram": (
            "Archive the package/foundry-approved bond diagram mapping die pads to package pins."
        ),
        "package_padframe_board_cross_probe": (
            "Regenerate and review the package pinout, padframe, bond map, KiCad symbol, "
            "footprint, and board-net cross-probe from release-source evidence."
        ),
        "foundry_padframe_signoff": (
            "Close foundry IO-cell, ESD/corner-cell, and padframe-inclusive DRC/LVS signoff."
        ),
        "manifest_promotion": (
            "Promote manifest rows only after every referenced artifact, checksum manifest, "
            "and required metadata field is backed by approved release evidence."
        ),
        "other_package_release_blocker": (
            "Resolve the named package/vendor padframe blocker and rerun this checker."
        ),
    }
    return steps[bucket]


def blocker_class(blocker: str) -> str:
    """Classify release blockers by evidence state, not only artifact name."""
    lower = blocker.lower()
    if "missing from rtl" in lower or "missing from package pinout" in lower:
        return "package_pinout_padframe_mismatch"
    if "kicad files are missing package board nets" in lower:
        return "package_pinout_padframe_mismatch"
    if "placeholder" in lower or "draft package artifact" in lower:
        return "present_local_planning_evidence"
    if "artifact files are missing" in lower:
        return "missing_vendor_evidence"
    if "checksum_manifest is missing" in lower:
        return "missing_vendor_evidence"
    if "requires metadata fields" in lower:
        return "missing_vendor_evidence"
    if "status complete, got missing" in lower:
        return "missing_vendor_evidence"
    if "group status complete, got missing" in lower:
        return "missing_vendor_evidence"
    if "release-required artifact is missing" in lower:
        return "missing_vendor_evidence"
    if "release-required group is missing" in lower:
        return "missing_vendor_evidence"
    if "release_credit: false" in lower or "release_credit false" in lower:
        return "release_credit_false_artifact"
    if "release requires manifest status complete, got scaffold" in lower:
        return "present_local_planning_evidence"
    if "padframe release gate" in lower:
        return "missing_vendor_evidence"
    return "other_release_blocker"


def blocker_class_counts(blockers: list[str]) -> dict[str, int]:
    classes = {
        "package_pinout_padframe_mismatch": 0,
        "missing_vendor_evidence": 0,
        "present_local_planning_evidence": 0,
        "release_credit_false_artifact": 0,
        "other_release_blocker": 0,
    }
    counts = Counter(blocker_class(blocker) for blocker in blockers)
    classes.update({key: counts.get(key, 0) for key in classes})
    return classes


def collect_local_planning_evidence(
    manifest_path: Path, draft_path: Path
) -> list[dict[str, object]]:
    evidence: list[dict[str, object]] = []
    if manifest_path.is_file():
        try:
            manifest = yaml.safe_load(manifest_path.read_text())
        except yaml.YAMLError:
            manifest = None
        if isinstance(manifest, dict):
            groups = manifest.get("artifact_groups")
            if isinstance(groups, dict):
                for group_name, group in groups.items():
                    if not isinstance(group, dict) or group_name != "local_planning_scaffolds":
                        continue
                    artifacts = group.get("artifacts", [])
                    if not isinstance(artifacts, list):
                        continue
                    for artifact in artifacts:
                        if not isinstance(artifact, dict):
                            continue
                        files = matching_files(as_list(artifact.get("globs")))
                        evidence.append(
                            {
                                "name": artifact.get("name", "unnamed"),
                                "group": group_name,
                                "status": artifact.get("status"),
                                "release_use": (
                                    artifact.get("metadata", {}).get("release_use")
                                    if isinstance(artifact.get("metadata"), dict)
                                    else None
                                ),
                                "release_credit": False,
                                "present_files": files,
                                "present_file_count": len(files),
                            }
                        )
    if draft_path.is_file():
        try:
            draft = yaml.safe_load(draft_path.read_text())
        except yaml.YAMLError:
            draft = None
        if isinstance(draft, dict):
            evidence.append(
                {
                    "name": "package_vendor_padframe_action_inventory",
                    "status": draft.get("status"),
                    "release_use": draft.get("release_use"),
                    "release_credit": draft.get("release_credit"),
                    "present_files": [rel(draft_path)],
                    "present_file_count": 1,
                    "action_count": len(draft.get("action_inventory", []))
                    if isinstance(draft.get("action_inventory"), list)
                    else 0,
                }
            )
    return evidence


def release_credit_false_artifacts(
    local_evidence: list[dict[str, object]],
) -> list[dict[str, object]]:
    return [
        {
            "name": str(row.get("name")),
            "status": row.get("status"),
            "release_use": row.get("release_use"),
            "present_file_count": row.get("present_file_count", 0),
        }
        for row in local_evidence
        if row.get("release_credit") is False or row.get("release_use") == "prohibited"
    ]


def release_action_inventory(blockers: list[str]) -> list[dict[str, object]]:
    counts = Counter(blocker_bucket(blocker) for blocker in blockers)
    first_seen: dict[str, list[str]] = {}
    for blocker in blockers:
        bucket = blocker_bucket(blocker)
        first_seen.setdefault(bucket, [])
        if len(first_seen[bucket]) < 4:
            first_seen[bucket].append(blocker)
    return [
        {
            "bucket": bucket,
            "count": counts[bucket],
            "release_credit": False,
            "next_step": next_step_for_bucket(bucket),
            "sample_blockers": first_seen[bucket],
            "validation_commands": [
                "python3 scripts/check_package_cross_probe.py --release",
                "python3 scripts/check_manufacturing_artifacts.py --release",
                "python3 scripts/check_padframe_contract.py",
            ],
        }
        for bucket in sorted(counts, key=lambda key: (-counts[key], key))
    ]


def release_artifact_contract(manifest_path: Path) -> list[dict[str, object]]:
    if not manifest_path.is_file():
        return [
            {
                "artifact": "package_manifest",
                "status": "missing",
                "source_manifest": rel(manifest_path),
                "release_credit": False,
                "next_step": "Add package/artifact-manifest.yaml with release-required package/vendor evidence groups.",
            }
        ]
    try:
        manifest = yaml.safe_load(manifest_path.read_text())
    except yaml.YAMLError as exc:
        return [
            {
                "artifact": "package_manifest",
                "status": "invalid_yaml",
                "source_manifest": rel(manifest_path),
                "release_credit": False,
                "next_step": f"Fix YAML parse error before release artifact validation can continue: {exc}",
            }
        ]
    groups = manifest.get("artifact_groups", {}) if isinstance(manifest, dict) else {}
    rows: list[dict[str, object]] = []
    for artifact_name in sorted(RELEASE_REQUIRED_ARTIFACTS):
        found = False
        iterable_groups = groups.items() if isinstance(groups, dict) else []
        for group_name, group in iterable_groups:
            artifacts = group.get("artifacts", []) if isinstance(group, dict) else []
            if not isinstance(artifacts, list):
                continue
            for artifact in artifacts:
                if not isinstance(artifact, dict) or artifact.get("name") != artifact_name:
                    continue
                found = True
                globs = as_list(artifact.get("globs"))
                files = matching_files(globs)
                checksum = artifact.get("checksum_manifest")
                required_metadata = set(as_list(artifact.get("required_metadata")))
                metadata = artifact.get("metadata")
                metadata_keys = set(metadata) if isinstance(metadata, dict) else set()
                missing_metadata = sorted(required_metadata - metadata_keys)
                rows.append(
                    {
                        "artifact": artifact_name,
                        "group": group_name,
                        "status": artifact.get("status"),
                        "source_manifest": rel(manifest_path),
                        "expected_globs": globs,
                        "present_files": files,
                        "present_file_count": len(files),
                        "checksum_manifest": checksum,
                        "checksum_manifest_present": (
                            isinstance(checksum, str)
                            and bool(checksum)
                            and (ROOT / checksum).is_file()
                        ),
                        "missing_metadata": missing_metadata,
                        "release_credit": False,
                        "next_step": next_step_for_bucket(blocker_bucket(artifact_name)),
                        "validation_command": "python3 scripts/check_package_cross_probe.py --release",
                    }
                )
        if not found:
            rows.append(
                {
                    "artifact": artifact_name,
                    "status": "missing_from_manifest",
                    "source_manifest": rel(manifest_path),
                    "release_credit": False,
                    "next_step": next_step_for_bucket(blocker_bucket(artifact_name)),
                    "validation_command": "python3 scripts/check_package_cross_probe.py --release",
                }
            )
    return rows


def collect_manifest_release_blockers(manifest_path: Path) -> list[str]:
    blockers: list[str] = []
    if not manifest_path.is_file():
        return [f"{rel(manifest_path)} is missing"]
    try:
        manifest = yaml.safe_load(manifest_path.read_text())
    except yaml.YAMLError as exc:
        return [f"{rel(manifest_path)} is not parseable YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{rel(manifest_path)} must be a mapping"]

    manifest_name = str(manifest.get("manifest") or rel(manifest_path))
    status = manifest.get("status")
    if status != "complete":
        blockers.append(f"{manifest_name}: release requires manifest status complete, got {status}")

    groups = manifest.get("artifact_groups")
    if not isinstance(groups, dict):
        return blockers + [f"{manifest_name}: artifact_groups must be a mapping"]
    missing_groups = sorted(RELEASE_REQUIRED_GROUPS - set(groups))
    for group_name in missing_groups:
        blockers.append(f"{manifest_name}.{group_name}: release-required group is missing")

    seen_artifacts: set[str] = set()
    for group_name, group in groups.items():
        if not isinstance(group, dict):
            blockers.append(f"{manifest_name}.{group_name}: group must be a mapping")
            continue
        group_status = group.get("status")
        if group_name in RELEASE_REQUIRED_GROUPS and group_status != "complete":
            blockers.append(
                f"{manifest_name}.{group_name}: release requires group status complete, got {group_status}"
            )
        artifacts = group.get("artifacts", [])
        if not isinstance(artifacts, list):
            blockers.append(f"{manifest_name}.{group_name}: artifacts must be a list")
            continue
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                blockers.append(f"{manifest_name}.{group_name}: artifact row must be a mapping")
                continue
            name = str(artifact.get("name") or "unnamed")
            seen_artifacts.add(name)
            if name not in RELEASE_REQUIRED_ARTIFACTS:
                continue
            field = f"{manifest_name}.{group_name}.{name}"
            artifact_status = artifact.get("status")
            if artifact_status != "complete":
                blockers.append(f"{field}: release requires status complete, got {artifact_status}")
            globs = as_list(artifact.get("globs"))
            files = matching_files(globs)
            if not files:
                blockers.append(f"{field}: release artifact files are missing")
            checksum_manifest = artifact.get("checksum_manifest")
            if (
                isinstance(checksum_manifest, str)
                and checksum_manifest
                and not (ROOT / checksum_manifest).is_file()
            ):
                blockers.append(
                    f"{field}: release checksum_manifest is missing: {checksum_manifest}"
                )
            required_metadata = set(as_list(artifact.get("required_metadata")))
            metadata = artifact.get("metadata")
            metadata_keys = set(metadata) if isinstance(metadata, dict) else set()
            metadata_globs = as_list(artifact.get("metadata_globs"))
            missing_metadata = sorted(required_metadata - metadata_keys)
            if missing_metadata and not matching_files(metadata_globs):
                blockers.append(
                    f"{field}: release requires metadata fields or metadata_globs for: "
                    + ", ".join(missing_metadata)
                )

    missing_artifacts = sorted(RELEASE_REQUIRED_ARTIFACTS - seen_artifacts)
    for artifact_name in missing_artifacts:
        blockers.append(f"{manifest_name}: release-required artifact is missing: {artifact_name}")
    return blockers


def collect_draft_cross_probe_blockers(path: Path) -> list[str]:
    if not path.is_file():
        return [
            f"{rel(path)} is missing; no fail-closed package cross-probe action inventory exists"
        ]
    try:
        report = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{rel(path)} is not parseable YAML: {exc}"]
    if not isinstance(report, dict):
        return [f"{rel(path)} must be a mapping"]
    blockers: list[str] = []
    if report.get("release_credit") is not False:
        blockers.append(f"{rel(path)} must explicitly carry release_credit: false")
    if report.get("status") not in {"blocked", "draft"}:
        blockers.append(f"{rel(path)} must remain blocked/draft until vendor evidence is approved")
    if report.get("release_use") != "prohibited":
        blockers.append(f"{rel(path)} must declare release_use: prohibited")
    actions = report.get("action_inventory")
    if not isinstance(actions, list) or not actions:
        blockers.append(f"{rel(path)} must list package/vendor cross-probe unblock actions")
    else:
        for index, action in enumerate(actions, start=1):
            if not isinstance(action, dict):
                blockers.append(f"{rel(path)}.action_inventory[{index}] must be a mapping")
                continue
            if action.get("release_credit") is not False:
                blockers.append(
                    f"{rel(path)}.action_inventory[{index}] must carry release_credit: false"
                )
            if not action.get("required_evidence"):
                blockers.append(
                    f"{rel(path)}.action_inventory[{index}] must name required_evidence"
                )
    return blockers


def write_report(status: str, mode: str, failures: list[str], blockers: list[str]) -> None:
    action_inventory = release_action_inventory(blockers)
    local_evidence = collect_local_planning_evidence(MANIFEST, CROSS_PROBE_DRAFT)
    release_credit_false = release_credit_false_artifacts(local_evidence)
    class_counts = blocker_class_counts(failures + blockers)
    payload = {
        "schema": SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "mode": mode,
        "release_ready": status == "pass" and mode == "release",
        "release_credit": status == "pass" and mode == "release",
        "summary": {
            "failures": len(failures),
            "blockers": len(blockers),
            "release_credit": status == "pass" and mode == "release",
            "action_buckets": {row["bucket"]: row["count"] for row in action_inventory},
            "blocker_classes": class_counts,
            "package_pinout_padframe_mismatch_count": class_counts[
                "package_pinout_padframe_mismatch"
            ],
            "missing_vendor_evidence_count": class_counts["missing_vendor_evidence"],
            "present_local_planning_evidence_count": len(local_evidence),
            "release_credit_false_artifact_count": len(release_credit_false),
        },
        "source_evidence": {
            "pinout": "package/e1-demo-pinout.yaml",
            "padframe_contract": "pd/padframe/e1_demo_padframe.yaml",
            "artifact_manifest": "package/artifact-manifest.yaml",
            "fail_closed_action_inventory": rel(CROSS_PROBE_DRAFT),
        },
        "failures": failures,
        "blockers": blockers,
        "blocker_dependency_counts": {
            "actionable_external_dependency": len(blockers) if status == "blocked" else 0,
            "repo_artifact_generation": 0,
            "live_device_validation": 0,
        },
        "next_command_by_dependency": {
            "actionable_external_dependency": [
                "python3 scripts/check_package_cross_probe.py --release",
                "python3 scripts/check_manufacturing_artifacts.py --release",
                "python3 scripts/check_padframe_contract.py",
            ]
        }
        if status == "blocked" and blockers
        else {},
        "blocker_class_counts": class_counts,
        "present_local_planning_evidence": local_evidence,
        "release_credit_false_artifacts": release_credit_false,
        "release_unblock_action_inventory": action_inventory,
        "release_artifact_contract": release_artifact_contract(MANIFEST),
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def main() -> int:
    parser = ArgumentParser(description="Cross-probe package, padframe, RTL, and board nets.")
    parser.add_argument(
        "--release", action="store_true", help="require board/KiCad cross-probe evidence"
    )
    args = parser.parse_args()

    pinout = yaml.safe_load((ROOT / "package/e1-demo-pinout.yaml").read_text())
    padframe = yaml.safe_load((ROOT / "pd/padframe/e1_demo_padframe.yaml").read_text())
    ports = parse_ports(ROOT / padframe["rtl_top"])

    failures: list[str] = []
    blockers: list[str] = []
    pin_entries = pinout.get("pins", [])
    logical_pins = {
        logical_name(pin["name"])
        for pin in pin_entries
        if not str(pin["name"]).startswith(("VDD", "VSS", "NC"))
    }
    board_nets = {
        str(pin.get("board_net", ""))
        for pin in pin_entries
        if pin.get("board_net") not in {None, "", "NC"}
    }

    missing_rtl = sorted((logical_pins - ports) - {"NC"})
    extra_rtl = sorted(ports - logical_pins)
    if missing_rtl:
        failures.append("package pinout logical names missing from RTL: " + ", ".join(missing_rtl))
    if extra_rtl:
        failures.append("RTL ports missing from package pinout: " + ", ".join(extra_rtl))

    required = set(padframe.get("required_pins", []))
    missing_required = sorted(required - logical_pins - {"VDDIO", "VSSIO", "VDDCORE", "VSSCORE"})
    if missing_required:
        failures.append(
            "padframe required pins missing from package pinout: " + ", ".join(missing_required)
        )

    artifact_paths = padframe.get("package_artifacts", {})
    for name, artifact in artifact_paths.items():
        path = ROOT / artifact
        if not path.is_file():
            failures.append(f"padframe package_artifacts.{name} points at missing file: {artifact}")

    board_dir = ROOT / "board/kicad/e1-demo"
    kicad_files = list(board_dir.glob("*.kicad_sch")) + list(board_dir.glob("*.kicad_pcb"))
    if not kicad_files:
        blockers.append("no KiCad schematic/PCB is available for board-net cross-probe")
    else:
        kicad_nets = board_nets_from_kicad(board_dir)
        missing_board_nets = sorted(board_nets - kicad_nets)
        if missing_board_nets:
            blockers.append(
                "KiCad files are missing package board nets: " + ", ".join(missing_board_nets)
            )

    if "placeholder" in str(pinout.get("package", "")).lower():
        blockers.append("package pinout still uses a placeholder package name")
    for path in (
        ROOT / "docs/package/e1-demo-package.md",
        ROOT / "docs/package/e1-demo-pad-ring.md",
    ):
        text = path.read_text(errors="ignore").lower()
        if "placeholder" in text or "not a foundry-approved" in text:
            blockers.append(
                f"{path.relative_to(ROOT)} is still a placeholder/draft package artifact"
            )

    release_blockers = collect_manifest_release_blockers(MANIFEST)
    release_blockers.extend(collect_draft_cross_probe_blockers(CROSS_PROBE_DRAFT))
    padframe_gates = padframe.get("release_gates", {})
    if isinstance(padframe_gates, dict):
        for gate_name, gate in padframe_gates.items():
            if isinstance(gate, dict) and gate.get("blocked") is True:
                reason = gate.get("reason", "missing release evidence")
                release_blockers.append(
                    f"padframe release gate {gate_name} remains blocked: {reason}"
                )

    if failures:
        write_report("fail", "release" if args.release else "preflight", failures, blockers)
        print("Package cross-probe check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    all_blockers = blockers + release_blockers
    mode = "release" if args.release else "preflight"
    if all_blockers:
        write_report("blocked", mode, [], all_blockers)
        print(
            "STATUS: BLOCKED package/vendor padframe cross-probe release evidence "
            f"blockers={len(all_blockers)} release_credit=false"
        )
        print("Package cross-probe release blockers:")
        for blocker in all_blockers:
            print(f"  - {blocker}")
        if args.release:
            return 2
        print("Package/RTL scaffold cross-probe passed; board/package release evidence is blocked.")
        return 0

    write_report("pass", mode, [], [])
    print("Package cross-probe check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
