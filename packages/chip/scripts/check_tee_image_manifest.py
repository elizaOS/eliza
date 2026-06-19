#!/usr/bin/env python3
"""Validate the E1 confidential guest image manifest against the SHARED OS schema (06 WI-3).

The reproducible-build schema + verifier are owned by packages/os
(release/schema/confidential-image-manifest.schema.json,
scripts/verify-image-reproducibility.mjs). This gate does NOT duplicate them — it
references the OS schema directly and validates the chip-side E1 riscv64 image
manifest fixture (sw/confidential/e1-elizaos-linux.manifest.json) against it,
asserting REAL invariants fail-closed:

  1. The manifest validates structurally against the shared OS schema.
  2. image.substrate == "cove" and image.architecture == "riscv64" (this is the
     E1 confidential VM, not the TDX/x86_64 path the same schema also serves).
  3. Every component digest is sha256:<64 hex> and not the all-zero placeholder.
  4. components.appCompose.digest == measurements.compose (one bytes, two views;
     same invariant the OS checker enforces for RTMR3).
  5. For any component whose referenced artifact file is actually present on
     disk, the recomputed sha256 equals the manifest digest — so once a real
     build lands beside the manifest, drift fails the gate. With no built image
     present (the BLOCKED case), digest-recompute is a no-op and the gate stays
     a schema + shape + cross-binding proof, release-blocked.

Recompute search roots: the manifest directory and an optional --image-dir.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
DEFAULT_MANIFEST = ROOT / "sw/confidential/e1-elizaos-linux.manifest.json"
OS_SCHEMA = REPO_ROOT / "packages/os/release/schema/confidential-image-manifest.schema.json"
OUT = ROOT / "build/reports/tee_image_manifest.json"

DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
ZERO_DIGEST = "sha256:" + "0" * 64
COMPONENT_NAMES = ("kernel", "initrd", "rootfs", "appCompose")
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "reproducible_build_claim_allowed": False,
    "measured_launch_claim_allowed": False,
    "silicon_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def recompute_digest(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest}"


def validate(
    manifest: dict[str, Any], schema: dict[str, Any], search_dirs: list[Path]
) -> list[str]:
    errors: list[str] = []

    schema_errors = sorted(
        Draft202012Validator(schema).iter_errors(manifest),
        key=lambda e: list(e.absolute_path),
    )
    for err in schema_errors:
        location = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"schema: {location}: {err.message}")
    if errors:
        return errors

    image = manifest["image"]
    if image.get("substrate") != "cove":
        errors.append(
            f"image.substrate must be 'cove' for the E1 path, got {image.get('substrate')!r}"
        )
    if image.get("architecture") != "riscv64":
        errors.append(
            f"image.architecture must be 'riscv64' for the E1 path, got {image.get('architecture')!r}"
        )

    components = manifest["components"]
    for name in COMPONENT_NAMES:
        digest = components[name]["digest"]
        if not DIGEST.match(str(digest)):
            errors.append(f"components.{name}.digest must be sha256:<64 lowercase hex>")
        elif digest == ZERO_DIGEST:
            errors.append(f"components.{name}.digest is an all-zero placeholder")

    compose_component = components["appCompose"]["digest"]
    compose_measurement = manifest["measurements"].get("compose")
    if compose_measurement is not None and compose_component != compose_measurement:
        errors.append(
            "components.appCompose.digest must equal measurements.compose "
            "(the app-compose bytes are measured once, viewed twice)"
        )

    # Digest recompute: only for components whose artifact bytes are actually
    # present (a real build sitting beside the manifest). Absent in the BLOCKED
    # fixture case, so this is a no-op there but catches drift the moment a real
    # image lands.
    recomputed = 0
    for name in COMPONENT_NAMES:
        filename = components[name]["filename"]
        for base in search_dirs:
            candidate = base / filename
            if candidate.is_file():
                actual = recompute_digest(candidate)
                if actual != components[name]["digest"]:
                    errors.append(
                        f"components.{name}.digest {components[name]['digest']} != "
                        f"recomputed {actual} for {candidate}"
                    )
                recomputed += 1
                break

    return errors


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument(
        "--image-dir",
        default=None,
        help="additional directory to search for built component artifacts to recompute",
    )
    args = parser.parse_args(argv[1:])

    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    schema = json.loads(OS_SCHEMA.read_text(encoding="utf-8"))

    search_dirs = [manifest_path.parent]
    if args.image_dir:
        search_dirs.append(Path(args.image_dir))

    errors = validate(manifest, schema, search_dirs)
    confirmed = bool(manifest.get("reproducibility", {}).get("confirmed"))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.tee_image_manifest_check.v1",
                "status": "tee_image_manifest_release_blocked",
                "generated_utc": utc_now(),
                "claim_boundary": (
                    "Schema-conformance + digest-shape + appCompose/compose binding + "
                    "present-artifact digest recompute only; not a reproducible build, "
                    "not a measured launch, not silicon."
                ),
                "manifest": manifest_path.relative_to(ROOT).as_posix()
                if manifest_path.is_relative_to(ROOT)
                else str(manifest_path),
                "os_schema": "packages/os/release/schema/confidential-image-manifest.schema.json",
                "reproducibility_confirmed": confirmed,
                "errors": errors,
                "false_claim_flags": FALSE_CLAIM_FLAGS,
                "findings": [
                    {
                        "code": "tee_image_manifest_release_blocked",
                        "message": (
                            "Confidential image manifest is schema-checked, but release remains "
                            "blocked until reproducible build and measured-launch evidence are confirmed."
                        ),
                        "next_step": "produce reproducible confidential image artifacts and bind their measurements",
                        "severity": "blocker",
                    }
                ],
                "summary": {
                    "release_claim_allowed": confirmed and not errors,
                    "false_claim_flags": FALSE_CLAIM_FLAGS,
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        print("tee-image-manifest-check: FAIL-CLOSED", file=sys.stderr)
        return 1

    print(f"PASS: E1 confidential image manifest valid vs shared OS schema: {manifest_path}")
    if not confirmed:
        print(
            "  note: reproducible riscv64 CoVE image build is BLOCKED "
            "(tee-image-reproducibility, needs a build host). Component digests are "
            "golden placeholders; only schema + shape + binding + present-artifact "
            "recompute are proven here."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
