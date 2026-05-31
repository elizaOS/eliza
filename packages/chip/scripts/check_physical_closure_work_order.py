#!/usr/bin/env python3
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORK_ORDER = ROOT / "docs/manufacturing/physical-closure-work-order.yaml"
GAP_MANIFEST = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"

REQUIRED_GATES = {"pd_release", "tapeout_release", "board_fabrication_release"}
REQUIRED_ITEM_FIELDS = {
    "id",
    "gate",
    "owner",
    "artifact_names",
    "evidence_paths",
    "acceptance_criteria",
}
FORBIDDEN_LOCAL_CLAIMS = {
    "Tapeout ready.",
    "Board fabrication ready.",
    "Foundry padframe approved.",
    "Package vendor approved.",
    "Lab verified.",
    "SI/PI closed.",
    "IR-drop or EM closed.",
    "Thermal closed.",
}
REQUIRED_CAPTURE_WORK_ORDERS = {
    "fpga_bitstream_evidence_capture",
    "kicad_fab_package_capture",
    "package_vendor_review_capture",
    "si_pi_current_thermal_capture",
}
REQUIRED_CLAIM_POLICY_FALSE_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "tapeout_claim_allowed",
    "board_fabrication_claim_allowed",
    "physical_signoff_claim_allowed",
    "lab_validation_claim_allowed",
}


def load_yaml(path: Path) -> dict:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise SystemExit(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def is_relative_path_like(value: str) -> bool:
    path = Path(value.replace("<selected-run>", "selected-run"))
    return not path.is_absolute() and ".." not in path.parts


def validate_text_list(label: str, value: object, min_len: int, failures: list[str]) -> list[str]:
    if not isinstance(value, list) or len(value) < min_len:
        failures.append(f"{label} must list at least {min_len} item(s)")
        return []
    strings = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            failures.append(f"{label}[{index}] must be a non-empty string")
        else:
            strings.append(item)
    return strings


def manifest_command_ids(manifest_path: str, failures: list[str]) -> set[str]:
    path = ROOT / manifest_path
    if not path.is_file():
        return set()
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        failures.append(f"{manifest_path} must be a YAML mapping")
        return set()
    manifest_name = str(data.get("manifest") or manifest_path)
    groups = data.get("artifact_groups", {})
    if not isinstance(groups, dict):
        return set()
    command_ids: set[str] = set()
    for group_name, group in groups.items():
        if not isinstance(group, dict):
            continue
        commands = group.get("cli_commands", {})
        if not isinstance(commands, dict):
            continue
        for command_name in commands:
            command_ids.add(f"{manifest_name}.{group_name}.{command_name}")
    return command_ids


def validate_capture_work_orders(work_order: dict, failures: list[str]) -> None:
    orders = work_order.get("evidence_capture_work_orders")
    if not isinstance(orders, list) or not orders:
        failures.append("work order must list evidence_capture_work_orders")
        return

    seen_ids: set[str] = set()
    for index, order in enumerate(orders):
        label = f"evidence_capture_work_orders[{index}]"
        if not isinstance(order, dict):
            failures.append(f"{label} must be a mapping")
            continue
        order_id = order.get("id")
        if not isinstance(order_id, str) or not order_id:
            failures.append(f"{label}.id must be a non-empty string")
            order_id = label
        if order_id in seen_ids:
            failures.append(f"{label} duplicate id: {order_id}")
        seen_ids.add(order_id)

        if order.get("gate") not in REQUIRED_GATES:
            failures.append(f"{order_id}: invalid gate")
        if not isinstance(order.get("owner"), str) or not order["owner"]:
            failures.append(f"{order_id}: missing owner")

        manifest = order.get("manifest")
        if not isinstance(manifest, str) or not manifest:
            failures.append(f"{order_id}: missing manifest")
        elif not is_relative_path_like(manifest) or not (ROOT / manifest).is_file():
            failures.append(f"{order_id}.manifest must point at an existing repo file: {manifest}")

        command_ids = order.get("local_command_ids")
        if not isinstance(command_ids, list) or not all(
            isinstance(item, str) for item in command_ids
        ):
            failures.append(f"{order_id}.local_command_ids must be a list of strings")
            command_ids = []
        elif isinstance(manifest, str) and (ROOT / manifest).is_file():
            available_command_ids = manifest_command_ids(manifest, failures)
            missing_command_ids = sorted(set(command_ids) - available_command_ids)
            if missing_command_ids:
                failures.append(
                    f"{order_id}.local_command_ids missing from {manifest}: "
                    + ", ".join(missing_command_ids)
                )

        output_roots = validate_text_list(
            f"{order_id}.output_roots", order.get("output_roots"), 1, failures
        )
        for output_root in output_roots:
            if not is_relative_path_like(output_root):
                failures.append(f"{order_id}.output_roots must be relative: {output_root}")

        blockers = validate_text_list(
            f"{order_id}.blocked_until", order.get("blocked_until"), 1, failures
        )
        if not any("archived" in blocker.lower() for blocker in blockers):
            failures.append(f"{order_id}.blocked_until must require archived evidence")

    missing = sorted(REQUIRED_CAPTURE_WORK_ORDERS - seen_ids)
    if missing:
        failures.append("missing evidence_capture_work_orders: " + ", ".join(missing))


def main() -> int:
    failures: list[str] = []
    work_order = load_yaml(WORK_ORDER)
    gap_manifest = load_yaml(GAP_MANIFEST)

    if work_order.get("status") != "release_blocked":
        failures.append(
            "work order status must stay release_blocked until physical evidence is archived"
        )
    if (
        work_order.get("source_gap_manifest")
        != "docs/manufacturing/real-world-verification-gaps.yaml"
    ):
        failures.append(
            "work order must point at docs/manufacturing/real-world-verification-gaps.yaml"
        )

    claim_policy = work_order.get("claim_policy")
    if not isinstance(claim_policy, dict):
        failures.append("work order must define claim_policy")
    else:
        for key in REQUIRED_CLAIM_POLICY_FALSE_FLAGS:
            if claim_policy.get(key) is not False:
                failures.append(f"claim_policy.{key} must be false")
        allowed = validate_text_list(
            "claim_policy.allowed_local_claims",
            claim_policy.get("allowed_local_claims"),
            2,
            failures,
        )
        forbidden = set(
            validate_text_list(
                "claim_policy.forbidden_claims_until_evidence_archived",
                claim_policy.get("forbidden_claims_until_evidence_archived"),
                4,
                failures,
            )
        )
        missing_forbidden = sorted(FORBIDDEN_LOCAL_CLAIMS - forbidden)
        if missing_forbidden:
            failures.append(
                "claim_policy missing forbidden claims: " + ", ".join(missing_forbidden)
            )
        if not any("Machine checks prove only" in item for item in allowed):
            failures.append("claim_policy must limit local machine-check claims")

    validate_text_list("global_acceptance", work_order.get("global_acceptance"), 4, failures)
    validate_capture_work_orders(work_order, failures)

    gaps = gap_manifest.get("gaps")
    if not isinstance(gaps, list):
        failures.append("gap manifest must list gaps")
        gaps = []
    gap_by_id: dict[str, dict] = {}
    for gap in gaps:
        if isinstance(gap, dict):
            gap_id = gap.get("id")
            if isinstance(gap_id, str):
                gap_by_id[gap_id] = gap

    items = work_order.get("items")
    if not isinstance(items, list) or not items:
        failures.append("work order must list items")
        items = []

    seen_ids: set[str] = set()
    for index, item in enumerate(items):
        label = f"items[{index}]"
        if not isinstance(item, dict):
            failures.append(f"{label} must be a mapping")
            continue
        missing_fields = sorted(REQUIRED_ITEM_FIELDS - set(item))
        if missing_fields:
            failures.append(f"{label} missing fields: " + ", ".join(missing_fields))

        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            failures.append(f"{label}.id must be a non-empty string")
            item_id = label
        if item_id in seen_ids:
            failures.append(f"{label} duplicate item id: {item_id}")
        seen_ids.add(item_id)

        gap = gap_by_id.get(item_id)
        if gap is None:
            failures.append(f"{item_id}: no matching gap in real-world verification manifest")
        elif item.get("gate") != gap.get("release_gate"):
            failures.append(
                f"{item_id}: gate must match gap release_gate {gap.get('release_gate')}"
            )

        if item.get("gate") not in REQUIRED_GATES:
            failures.append(f"{item_id}: invalid gate")

        artifact_names = validate_text_list(
            f"{item_id}.artifact_names", item.get("artifact_names"), 2, failures
        )
        for artifact in artifact_names:
            if any(token in artifact.upper() for token in ("TBD", "TODO", "PLACEHOLDER")):
                failures.append(
                    f"{item_id}.artifact_names must not contain placeholder token: {artifact}"
                )

        evidence_paths = validate_text_list(
            f"{item_id}.evidence_paths", item.get("evidence_paths"), 1, failures
        )
        for evidence_path in evidence_paths:
            if not is_relative_path_like(evidence_path):
                failures.append(
                    f"{item_id}.evidence_paths must be relative repo paths: {evidence_path}"
                )

        criteria = validate_text_list(
            f"{item_id}.acceptance_criteria", item.get("acceptance_criteria"), 2, failures
        )
        if not any(
            (
                "clean" in criterion.lower()
                or "waiv" in criterion.lower()
                or "pass" in criterion.lower()
            )
            for criterion in criteria
        ):
            failures.append(
                f"{item_id}.acceptance_criteria must include pass, clean, or waiver language"
            )

    missing_items = sorted(set(gap_by_id) - seen_ids)
    extra_items = sorted(seen_ids - set(gap_by_id))
    if missing_items:
        failures.append("work order missing gap item(s): " + ", ".join(missing_items))
    if extra_items:
        failures.append("work order contains non-gap item(s): " + ", ".join(extra_items))

    if failures:
        print("Physical closure work-order check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("physical closure work order ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
