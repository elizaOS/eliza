#!/usr/bin/env python3
"""Validate the OTP fuse-map model (R4, pure-software subset).

Pure-Python invariant check on docs/spec-db/tee-otp-fuse-map.json. It is NOT the
RTL OTP controller (rtl/security/otp/e1_otp_map.sv, BLOCKED) and proves none of
the silicon read/write behavior; it enforces the structural fuse-map invariants
the RTL and provisioning flow must later satisfy:

  - non-overlapping, in-bounds, word-aligned partitions;
  - every secret partition is write-lockable and not readable in production;
  - a rollback index partition exists and is monotonic;
  - a 2-of-3 majority read is declared (parity/fault tolerance).

Positive and negative vectors live in test_otp_fuse_map.py.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chip_utils import load_json_object, require  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FUSE_MAP = REPO_ROOT / "packages/chip/docs/spec-db/tee-otp-fuse-map.json"
REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "silicon_otp_claim_allowed",
    "provisioning_claim_allowed",
    "secure_boot_claim_allowed",
}


def validate(fuse_map: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(fuse_map.get("schemaVersion") == 1, "schemaVersion must be 1", errors)
    require(
        fuse_map.get("policy") == "eliza-tee-otp-fuse-map-v0",
        "policy must be eliza-tee-otp-fuse-map-v0",
        errors,
    )
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        require(fuse_map.get(key) is False, f"{key} must be false", errors)
    require(fuse_map.get("readMajority") == "2-of-3", "readMajority must be 2-of-3", errors)
    word_bits = fuse_map.get("wordBits")
    require(word_bits == 32, "wordBits must be 32", errors)

    partitions = fuse_map.get("partitions")
    if not isinstance(partitions, list) or not partitions:
        errors.append("partitions must be a non-empty list")
        return errors

    occupied: dict[int, str] = {}
    seen_ids: set[str] = set()
    has_rollback = False
    for index, partition in enumerate(partitions):
        prefix = f"partitions[{index}]"
        if not isinstance(partition, dict):
            errors.append(f"{prefix} must be an object")
            continue
        partition_id = partition.get("id")
        offset = partition.get("offset")
        words = partition.get("words")
        if not isinstance(partition_id, str) or not partition_id:
            errors.append(f"{prefix}.id must be a non-empty string")
        elif partition_id in seen_ids:
            errors.append(f"{prefix}.id duplicates {partition_id}")
        else:
            seen_ids.add(partition_id)
        if not isinstance(offset, int) or offset < 0:
            errors.append(f"{prefix}.offset must be a non-negative integer")
            continue
        if not isinstance(words, int) or words <= 0:
            errors.append(f"{prefix}.words must be a positive integer")
            continue
        for word in range(offset, offset + words):
            if word in occupied:
                errors.append(f"{prefix} word {word} overlaps {occupied[word]}")
            else:
                occupied[word] = str(partition_id)

        is_secret = partition.get("secret") is True
        if is_secret:
            if partition.get("writeLockable") is not True:
                errors.append(f"{prefix} secret partition must be writeLockable")
            if partition.get("readableInProduction") is not False:
                errors.append(f"{prefix} secret partition must not be readable in production")
        if partition_id == "rollback_index":
            has_rollback = True
            if partition.get("monotonic") is not True:
                errors.append("rollback_index partition must be monotonic")

    if not has_rollback:
        errors.append("fuse map must declare a rollback_index partition")

    return errors


def main(argv: list[str]) -> int:
    fuse_map_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_FUSE_MAP
    fuse_map = load_json_object(fuse_map_path)
    errors = validate(fuse_map)
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: TEE OTP fuse map valid: {fuse_map_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
