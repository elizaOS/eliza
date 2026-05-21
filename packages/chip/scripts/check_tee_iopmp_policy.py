#!/usr/bin/env python3
"""Validate the TEE IOPMP source-ID policy."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = REPO_ROOT / "packages/chip/docs/spec-db/tee-confidential-domain-contract.json"
DEFAULT_POLICY = REPO_ROOT / "packages/chip/docs/spec-db/tee-iopmp-source-id-map.json"


def validate(contract: dict[str, object], policy: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if policy.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if policy.get("defaultAction") != "deny":
        errors.append("defaultAction must be deny")

    io_contract = contract.get("io") if isinstance(contract.get("io"), dict) else {}
    required_ids = set(io_contract.get("requiredDmaSourceIds", []))
    masters = policy.get("masters")
    if not isinstance(masters, list) or not masters:
        errors.append("masters must be a non-empty list")
        return errors

    seen_source_ids: set[int] = set()
    seen_master_ids: set[str] = set()
    shared_regions = {
        region.get("id") for region in policy.get("sharedRegions", []) if isinstance(region, dict)
    }

    for index, master in enumerate(masters):
        prefix = f"masters[{index}]"
        if not isinstance(master, dict):
            errors.append(f"{prefix} must be an object")
            continue
        master_id = master.get("id")
        source_id = master.get("sourceId")
        if not isinstance(master_id, str) or not master_id:
            errors.append(f"{prefix}.id must be a non-empty string")
        elif master_id in seen_master_ids:
            errors.append(f"{prefix}.id duplicates {master_id}")
        else:
            seen_master_ids.add(master_id)
        if not isinstance(source_id, int) or source_id < 0:
            errors.append(f"{prefix}.sourceId must be a non-negative integer")
        elif source_id in seen_source_ids:
            errors.append(f"{prefix}.sourceId duplicates {source_id}")
        else:
            seen_source_ids.add(source_id)
        if master.get("canDma") is not True:
            errors.append(f"{prefix}.canDma must be true")
        if master.get("confidentialMemoryDefault") != "deny":
            errors.append(f"{prefix}.confidentialMemoryDefault must be deny")
        allowed_regions = master.get("allowedSharedRegions")
        if not isinstance(allowed_regions, list):
            errors.append(f"{prefix}.allowedSharedRegions must be a list")
        else:
            for region_id in allowed_regions:
                if region_id not in shared_regions:
                    errors.append(
                        f"{prefix}.allowedSharedRegions references unknown region {region_id}"
                    )
        if master_id == "npu-dma":
            if master.get("requiresMeasuredFirmware") is not True:
                errors.append("npu-dma requires measured firmware")
            if master.get("requiresQueueOwnershipCheck") is not True:
                errors.append("npu-dma requires queue ownership checks")
        if (
            master_id == "debug-transport"
            and master.get("requiresProductionLifecycleDisable") is not True
        ):
            errors.append("debug-transport must require production lifecycle disable")

    missing = sorted(required_ids.difference(seen_master_ids))
    if missing:
        errors.append(f"missing required DMA masters: {', '.join(missing)}")

    for index, region in enumerate(policy.get("sharedRegions", [])):
        prefix = f"sharedRegions[{index}]"
        if not isinstance(region, dict):
            errors.append(f"{prefix} must be an object")
            continue
        if region.get("pageState") not in {"shared", "device-assigned"}:
            errors.append(f"{prefix}.pageState must be shared or device-assigned")
        if region.get("scrubOnRevoke") is not True:
            errors.append(f"{prefix}.scrubOnRevoke must be true")

    return errors


def main(argv: list[str]) -> int:
    contract_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_CONTRACT
    policy_path = Path(argv[2]) if len(argv) > 2 else DEFAULT_POLICY
    contract = json.loads(contract_path.read_text())
    policy = json.loads(policy_path.read_text())
    errors = validate(contract, policy)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"TEE IOPMP policy valid: {policy_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
