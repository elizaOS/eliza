#!/usr/bin/env python3
"""Dry-run and verify external AI-EDA asset intake.

The default mode is dry-run. `--execute` is intentionally conservative and only
checks out git repositories or calls `hf download` when the relevant
tool exists and the user has already accepted the asset's license/provenance
outside this script. Downloaded payloads remain under ignored `external/` paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
DEFAULT_REPORT_ROOT = ROOT / "build/ai_eda/external_assets"
CLAIM_BOUNDARY = "external_asset_fetch_report_only_no_training_inference_or_release_claim"
MAX_HASHED_FILES = 20000


def load_lockfile(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"invalid lockfile: {path}")
    return data


def find_asset(lock: dict[str, Any], asset_id: str) -> dict[str, Any]:
    for entry in lock.get("entries", []):
        if isinstance(entry, dict) and entry.get("id") == asset_id:
            return entry
    raise SystemExit(f"unknown asset id: {asset_id}")


def repo_dir(asset: dict[str, Any]) -> Path:
    kind = asset["kind"]
    if kind == "dataset":
        return ROOT / "external/datasets" / asset["id"]
    if kind == "model":
        return ROOT / "external/models" / asset["id"]
    return ROOT / "external/repos" / asset["id"]


def payload_dir(asset: dict[str, Any]) -> Path:
    return repo_dir(asset) / "payload"


def command_exists(command: str) -> bool:
    return shutil.which(command) is not None


def run_command(command: list[str], cwd: Path | None = None) -> dict[str, Any]:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        timeout=24 * 3600,
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def payload_file_manifest(path: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    total_bytes = 0
    skipped = 0
    for child in sorted(path.rglob("*")):
        if child.is_dir():
            continue
        if ".git" in child.parts:
            continue
        if child.is_symlink():
            skipped += 1
            continue
        if len(files) >= MAX_HASHED_FILES:
            skipped += 1
            continue
        size = child.stat().st_size
        total_bytes += size
        files.append(
            {
                "path": rel(child),
                "bytes": size,
                "sha256": sha256_file(child),
            }
        )
    return {
        "file_count": len(files),
        "skipped_after_limit": skipped,
        "total_hashed_bytes": total_bytes,
        "max_hashed_files": MAX_HASHED_FILES,
        "files": files,
    }


def expected_revision(asset: dict[str, Any]) -> str | None:
    revision = asset.get("revision")
    if not isinstance(revision, dict):
        return None
    value = revision.get("value")
    if not isinstance(value, str) or value in {
        "PIN_AFTER_FETCH",
        "BLOCKED_HTTP_403_REAUDIT_REQUIRED",
    }:
        return None
    if revision.get("type") not in {"commit", "tag", "hf_revision"}:
        return None
    return value


def verify_existing(path: Path, asset: dict[str, Any]) -> dict[str, Any]:
    if asset.get("kind") == "paper" or asset.get("fetch", {}).get("mode") == "paper":
        metadata_path = path / "metadata.json"
        if not metadata_path.is_file():
            return {
                "status": "BLOCKED_MISSING_METADATA_ONLY_PAPER_RECORD",
                "path": str(path),
                "expected_metadata": str(metadata_path),
            }
        return {
            "status": "PRESENT_METADATA_ONLY_PAPER_RECORD",
            "path": str(path),
            "metadata": rel(metadata_path),
            "file_manifest": payload_file_manifest(path),
        }
    if not path.exists():
        return {"status": "BLOCKED_MISSING_LOCAL_ASSET", "path": str(path)}
    hf_revision_path = path / ".hf_revision"
    if hf_revision_path.is_file():
        actual_revision = hf_revision_path.read_text(encoding="utf-8").strip()
        expected = expected_revision(asset)
        status = "PRESENT_HUGGINGFACE_PAYLOAD"
        if expected and actual_revision != expected:
            status = "BLOCKED_REVISION_MISMATCH"
        return {
            "status": status,
            "path": str(path),
            "revision": actual_revision,
            "expected_revision": expected,
            "file_manifest": payload_file_manifest(path),
        }
    if (path / ".git").exists() and command_exists("git"):
        rev = run_command(["git", "rev-parse", "HEAD"], cwd=path)
        actual_revision = rev["stdout_tail"].strip()
        expected = expected_revision(asset)
        status = "PRESENT_GIT_REPO" if rev["returncode"] == 0 else "BLOCKED_UNREADABLE_GIT_REPO"
        if expected and actual_revision != expected:
            status = "BLOCKED_REVISION_MISMATCH"
        return {
            "status": status,
            "path": str(path),
            "revision": actual_revision,
            "expected_revision": expected,
            "file_manifest": payload_file_manifest(path),
        }
    return {
        "status": "PRESENT_UNPINNED_PAYLOAD",
        "path": str(path),
        "file_manifest": payload_file_manifest(path),
    }


def execute_fetch(asset: dict[str, Any], dest: Path) -> dict[str, Any]:
    source_url = asset["source_url"]
    mode = asset["fetch"]["mode"]
    if dest.exists() and mode != "paper":
        return {"status": "SKIPPED_ALREADY_PRESENT", "path": str(dest)}
    dest.parent.mkdir(parents=True, exist_ok=True)
    if mode == "paper":
        dest.mkdir(parents=True, exist_ok=True)
        metadata = {
            "schema": "eliza.ai_eda.external_paper_metadata.v1",
            "asset_id": asset["id"],
            "name": asset["name"],
            "source_url": source_url,
            "revision": asset.get("revision"),
            "license_status": asset.get("license_status"),
            "allowed_use": asset.get("allowed_use"),
            "claim_boundary": CLAIM_BOUNDARY,
            "policy": {
                "downloads_payload": False,
                "downloads_model_weights": False,
                "release_use_allowed": False,
                "deterministic_replay_required": True,
            },
        }
        metadata_path = dest / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
        return {
            "status": "PRESENT_METADATA_ONLY_PAPER_RECORD",
            "path": str(dest),
            "metadata": rel(metadata_path),
            "file_manifest": payload_file_manifest(dest),
        }
    if mode == "git":
        if not command_exists("git"):
            return {"status": "BLOCKED_MISSING_TOOL", "tool": "git"}
        clone_command = ["git", "clone", "--depth", "1", source_url, str(dest)]
        result = run_command(clone_command)
        expected = expected_revision(asset)
        if result.get("returncode") == 0 and expected:
            checkout = run_command(["git", "checkout", "--detach", expected], cwd=dest)
            result["checkout"] = checkout
            rev = run_command(["git", "rev-parse", "HEAD"], cwd=dest)
            if rev.get("stdout_tail", "").strip() != expected:
                result["status"] = "BLOCKED_REVISION_MISMATCH"
                result["expected_revision"] = expected
                result["actual_revision"] = rev.get("stdout_tail", "").strip()
        if result.get("returncode") == 0 and command_exists("git-lfs"):
            lfs = run_command(["git", "lfs", "pull"], cwd=dest)
            result["git_lfs_pull"] = lfs
        return result
    if mode == "huggingface":
        # Convert https://huggingface.co/datasets/org/name to org/name.
        dataset_id = source_url.rstrip("/").split("/datasets/", 1)[-1]
        revision = expected_revision(asset)
        try:
            from huggingface_hub import snapshot_download
        except Exception as exc:  # noqa: BLE001
            return {"status": "BLOCKED_MISSING_TOOL", "tool": "huggingface_hub", "error": str(exc)}
        try:
            snapshot_download(  # type: ignore[call-overload]  # local_dir_use_symlinks dropped in newer huggingface_hub stubs; kept for older versions, except-TypeError handles its absence
                repo_id=dataset_id,
                repo_type="dataset",
                revision=revision,
                local_dir=dest,
                local_dir_use_symlinks=False,
            )
        except TypeError:
            snapshot_download(
                repo_id=dataset_id,
                repo_type="dataset",
                revision=revision,
                local_dir=dest,
            )
        except Exception as exc:  # noqa: BLE001
            return {"status": "BLOCKED_HUGGINGFACE_DOWNLOAD_FAILED", "error": str(exc)}
        if revision:
            (dest / ".hf_revision").write_text(revision + "\n", encoding="utf-8")
        return {"status": "PRESENT_HUGGINGFACE_PAYLOAD", "path": str(dest), "revision": revision}
    if mode == "model":
        if source_url.startswith("https://storage.googleapis.com/"):
            dest.mkdir(parents=True, exist_ok=True)
            return run_command(["curl", "-fL", "-o", str(dest / Path(source_url).name), source_url])
        if "huggingface.co/" in source_url:
            if not command_exists("hf"):
                return {"status": "BLOCKED_MISSING_TOOL", "tool": "hf"}
            model_id = source_url.rstrip("/").split("huggingface.co/", 1)[-1]
            return run_command(["hf", "download", model_id, "--local-dir", str(dest)])
        return {
            "status": "BLOCKED_UNSUPPORTED_MODEL_SOURCE",
            "source_url": source_url,
            "reason": "model assets require a direct file URL or Hugging Face model id",
        }
    return {"status": "BLOCKED_UNSUPPORTED_FETCH_MODE", "mode": mode}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--lockfile", type=Path, default=LOCKFILE)
    parser.add_argument("--report-root", type=Path, default=DEFAULT_REPORT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    mode.add_argument("--execute", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    lock = load_lockfile(args.lockfile)
    if args.all and args.execute:
        raise SystemExit("--all cannot be combined with --execute")
    if not args.all and not args.asset:
        raise SystemExit("--asset is required unless --all is set")
    assets = lock.get("entries", []) if args.all else [find_asset(lock, args.asset)]

    mode = "dry-run"
    reports: list[dict[str, Any]] = []
    overall_rc = 0
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        dest = payload_dir(asset)
        action: dict[str, Any]
        if args.verify_only:
            mode = "verify-only"
            action = verify_existing(dest, asset)
        elif args.execute:
            mode = "execute"
            action = execute_fetch(asset, dest)
        else:
            action = {
                "status": "DRY_RUN",
                "would_fetch": asset["source_url"],
                "dest": str(dest),
                "fetch_mode": asset["fetch"]["mode"],
            }
        if action.get("status", "").startswith("BLOCKED"):
            overall_rc = max(overall_rc, 2)
        if (
            mode == "execute"
            and isinstance(action.get("returncode"), int)
            and action["returncode"] != 0
        ):
            overall_rc = max(overall_rc, 1)
        reports.append(
            {
                "asset": {
                    "id": asset["id"],
                    "name": asset["name"],
                    "kind": asset["kind"],
                    "priority": asset["priority"],
                    "source_url": asset["source_url"],
                    "allowed_use": asset["allowed_use"],
                    "release_use_allowed": False,
                },
                "action": action,
            }
        )

    report = {
        "schema": "eliza.ai_eda.external_asset_fetch_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "mode": mode,
        "claim_boundary": CLAIM_BOUNDARY,
        "asset_count": len(reports),
        "reports": reports,
    }
    out_dir = args.report_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / ("all.json" if args.all else f"{reports[0]['asset']['id']}.json")
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    blocked = sum(1 for item in reports if item["action"].get("status", "").startswith("BLOCKED"))
    failed = sum(
        1
        for item in reports
        if mode == "execute"
        and isinstance(item["action"].get("returncode"), int)
        and item["action"]["returncode"] != 0
    )
    status = "FAIL" if failed else "BLOCKED" if blocked else "PASS"
    print(
        "STATUS: "
        f"{status} ai_eda.external_asset count={len(reports)} blocked={blocked} "
        f"failed={failed} {report_path}"
    )
    return overall_rc


if __name__ == "__main__":
    raise SystemExit(main())
