#!/usr/bin/env python3
"""Validate the AlphaChip checkpoint blocker audit and optional live URL status."""

from __future__ import annotations

import argparse
import json
import re
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs/toolchain/alphachip-checkpoint-blocker.md"
PIN = ROOT / "external/circuit_training/pin-manifest.json"
LOCK = ROOT / "external/SOURCES.lock.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/alphachip_checkpoint_blocker"
CLAIM_BOUNDARY = "alphachip_checkpoint_blocker_metadata_only_no_checkpoint_or_release_claim"


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected YAML mapping")
    return data


def parse_last_audited(text: str) -> str | None:
    match = re.search(r"\*\*Last audited:\*\*\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\.", text)
    return match.group(1) if match else None


def month_key(value: str) -> str:
    return value[:7]


def head_status(url: str, timeout: int) -> dict[str, Any]:
    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": "eliza-ai-eda-audit/1"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return {
                "url": url,
                "http_status": response.status,
                "ok": 200 <= response.status < 300,
                "error": None,
            }
    except urllib.error.HTTPError as exc:
        return {"url": url, "http_status": exc.code, "ok": False, "error": exc.reason}
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "http_status": None, "ok": False, "error": repr(exc)}


def find_lock_entry(lock: dict[str, Any], entry_id: str) -> dict[str, Any] | None:
    for entry in lock.get("entries", []):
        if isinstance(entry, dict) and entry.get("id") == entry_id:
            return entry
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument(
        "--network", action="store_true", help="Probe canonical GCS URLs with HEAD."
    )
    parser.add_argument("--timeout", type=int, default=10)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    warnings: list[str] = []
    today = date.today().isoformat()
    current_month = month_key(today)

    doc_text = DOC.read_text(encoding="utf-8")
    pin = load_json(PIN)
    lock = load_yaml(LOCK)

    doc_last_audited = parse_last_audited(doc_text)
    pin_last_audited = pin.get("last_audited")
    if doc_last_audited is None:
        errors.append("blocker doc missing '**Last audited:** YYYY-MM-DD.'")
    elif month_key(doc_last_audited) != current_month:
        errors.append(
            f"blocker doc audit is stale: {doc_last_audited}, current month {current_month}"
        )
    if pin_last_audited != doc_last_audited:
        errors.append(
            f"pin last_audited {pin_last_audited!r} does not match doc {doc_last_audited!r}"
        )
    if (
        pin.get("checkpoint_status")
        != "gcs-403-with-local-mitigation-blocked-by-closed-source-binary"
    ):
        errors.append("pin checkpoint_status changed without updating blocker checker")
    if pin.get("claim_boundary") != "metadata_only_no_checkpoint_binary_or_training_claim":
        errors.append("pin claim_boundary must forbid checkpoint/release claims")

    artifacts = pin.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("pin artifacts must be a non-empty list")
        artifacts = []

    lock_entry = find_lock_entry(lock, "alphachip-tpu-checkpoint-20240815")
    if lock_entry is None:
        errors.append("external/SOURCES.lock.yaml missing alphachip-tpu-checkpoint-20240815")
    else:
        first_artifact_url = (
            artifacts[0].get("url") if artifacts and isinstance(artifacts[0], dict) else None
        )
        if lock_entry.get("source_url") != first_artifact_url:
            errors.append(
                "AlphaChip checkpoint source_url must match pin artifact URL "
                f"({lock_entry.get('source_url')!r} != {first_artifact_url!r})"
            )
        if lock_entry.get("allowed_use") != "blocked":
            errors.append("AlphaChip checkpoint lock entry must remain allowed_use=blocked")
        if lock_entry.get("license_status") != "unavailable_for_review":
            errors.append("AlphaChip checkpoint lock entry must remain unavailable_for_review")
        revision_value = lock_entry.get("revision")
        revision: dict[str, Any] = revision_value if isinstance(revision_value, dict) else {}
        if revision.get("value") != "BLOCKED_HTTP_403_REAUDIT_REQUIRED":
            errors.append(
                "AlphaChip checkpoint revision must remain BLOCKED_HTTP_403_REAUDIT_REQUIRED"
            )

    for artifact in artifacts:
        if not isinstance(artifact, dict):
            errors.append("pin artifact must be an object")
            continue
        if artifact.get("expected_http_status") != 403:
            errors.append(f"{artifact.get('name')}: expected_http_status must be 403")
        if (
            artifact.get("sha256") is not None
            and artifact.get("status") != "blocked_until_lawful_mirror"
        ):
            warnings.append(
                f"{artifact.get('name')}: sha256 present; confirm blocker status is still accurate"
            )
        url = artifact.get("url")
        if not isinstance(url, str) or url not in doc_text:
            errors.append(f"{artifact.get('name')}: URL missing from blocker doc")

    network_results: list[dict[str, Any]] = []
    if args.network:
        for artifact in artifacts:
            if isinstance(artifact, dict) and isinstance(artifact.get("url"), str):
                result = head_status(artifact["url"], args.timeout)
                result["name"] = artifact.get("name")
                result["expected_http_status"] = artifact.get("expected_http_status")
                network_results.append(result)
                if result["http_status"] != artifact.get("expected_http_status"):
                    errors.append(
                        f"{artifact.get('name')}: live HTTP status {result['http_status']} "
                        f"!= expected {artifact.get('expected_http_status')}; re-audit blocker"
                    )

    status = "PASS_BLOCKED_CURRENT" if not errors else "FAIL"
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "eliza.ai_eda.alphachip_checkpoint_blocker_audit.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": status,
        "network_probe_enabled": args.network,
        "doc": str(DOC.relative_to(ROOT)),
        "pin_manifest": str(PIN.relative_to(ROOT)),
        "doc_last_audited": doc_last_audited,
        "pin_last_audited": pin_last_audited,
        "current_month": current_month,
        "artifact_count": len(artifacts),
        "network_results": network_results,
        "warnings": warnings,
        "errors": errors,
        "release_use_allowed": False,
    }
    report_path = out_dir / "alphachip_checkpoint_blocker_audit.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.alphachip_checkpoint_blocker {error}")
        return 1
    suffix = " network=on" if args.network else " network=off"
    print(
        "STATUS: PASS_BLOCKED_CURRENT ai_eda.alphachip_checkpoint_blocker "
        f"{report_path.relative_to(ROOT)} artifacts={len(artifacts)}{suffix}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
