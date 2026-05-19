#!/usr/bin/env python3
"""Validate and optionally install Android external evidence logs."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_REL = Path("docs/android/bsp-log-evidence-manifest.json")

TARGET_LOGS = {
    "aosp": [
        "docs/evidence/android/eliza_ai_soc_lunch.log",
        "docs/evidence/android/eliza_ai_soc_vendorimage.log",
        "docs/evidence/android/eliza_ai_soc_checkvintf.log",
        "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
        "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
        "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
        "docs/evidence/android/cuttlefish_riscv64_smoke.log",
        "docs/evidence/android/qemu_riscv64_smoke.log",
        "docs/evidence/android/renode_e1_soc_smoke.log",
    ],
}


def load_manifest(root: Path) -> dict:
    path = root / MANIFEST_REL
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise SystemExit(f"missing manifest: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid manifest {path}: {exc}") from exc


def candidate_path(source_dir: Path, rel_log: str) -> Path:
    rel = Path(rel_log)
    full = source_dir / rel
    if full.is_file():
        return full
    return source_dir / rel.name


def validate_log(log_path: Path, rel_log: str, spec: dict) -> list[str]:
    failures: list[str] = []
    if not log_path.is_file():
        return [f"{rel_log}: source log is missing: {log_path}"]

    text = log_path.read_text(errors="ignore")
    missing_metadata = [
        marker for marker in spec.get("required_metadata", []) if marker not in text
    ]
    if missing_metadata:
        failures.append(f"{rel_log}: missing provenance fields: " + ", ".join(missing_metadata))

    missing_all = [marker for marker in spec.get("required_all", []) if marker not in text]
    if missing_all:
        failures.append(f"{rel_log}: missing required markers: " + ", ".join(missing_all))

    required_any = spec.get("required_any", [])
    if required_any and not any(marker in text for marker in required_any):
        failures.append(f"{rel_log}: missing one of required markers: " + ", ".join(required_any))

    forbidden = [marker for marker in spec.get("forbidden_any", []) if marker in text]
    if forbidden:
        failures.append(f"{rel_log}: contains forbidden markers: " + ", ".join(forbidden))

    lowered = text.lower()
    forbidden_claims = [
        marker for marker in spec.get("forbidden_claims", []) if marker.lower() in lowered
    ]
    if forbidden_claims:
        failures.append(
            f"{rel_log}: contains forbidden broad claims: " + ", ".join(forbidden_claims)
        )

    return failures


def selected_logs(target: str) -> list[str]:
    try:
        return TARGET_LOGS[target]
    except KeyError as exc:
        raise SystemExit(f"unknown target: {target}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--target", choices=sorted(TARGET_LOGS), default="aosp")
    parser.add_argument(
        "--from-dir",
        type=Path,
        help="Directory containing real external logs, either by basename or repo-relative path.",
    )
    parser.add_argument(
        "--install",
        action="store_true",
        help="Copy validated logs into docs/evidence/android.",
    )
    parser.add_argument(
        "--validate-existing",
        action="store_true",
        help="Validate logs already installed in the repository.",
    )
    args = parser.parse_args()

    root = args.repo_root.resolve()
    if not args.from_dir and not args.validate_existing:
        parser.error("provide --from-dir or --validate-existing")
    if args.install and not args.from_dir:
        parser.error("--install requires --from-dir")

    manifest = load_manifest(root)
    if manifest.get("claim_boundary") != "expected_future_log_markers_only_not_boot_evidence":
        raise SystemExit(f"{MANIFEST_REL}: unexpected claim_boundary")
    specs = manifest.get("logs", {})

    failures: list[str] = []
    installs: list[tuple[Path, Path]] = []
    for rel_log in selected_logs(args.target):
        spec = specs.get(rel_log)
        if not isinstance(spec, dict):
            failures.append(f"{rel_log}: missing manifest spec")
            continue
        source = (
            candidate_path(args.from_dir.resolve(), rel_log) if args.from_dir else root / rel_log
        )
        failures.extend(validate_log(source, rel_log, spec))
        installs.append((source, root / rel_log))

    if failures:
        print("Android evidence intake failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if args.install:
        for source, dest in installs:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
        print(f"installed {len(installs)} Android evidence logs")
    else:
        print(f"validated {len(installs)} Android evidence logs")
    print("claim boundary: external evidence only; no Android boot or compatibility claim")
    return 0


if __name__ == "__main__":
    sys.exit(main())
