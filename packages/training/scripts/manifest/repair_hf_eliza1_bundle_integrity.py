#!/usr/bin/env python3
"""Repair Eliza-1 bundle manifest/checksum integrity from Hub bytes.

This updates only integrity metadata:

* ``bundles/<tier>/eliza-1.manifest.json`` file-entry SHA256 values.
* ``bundles/<tier>/checksums/SHA256SUMS`` coverage/hashes.

It does not change eval results, backend verification statuses, release state,
or any model weights. Large LFS hashes come from Hub metadata; small non-LFS
files are fetched and hashed directly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Mapping

try:
    from scripts.manifest.eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS  # type: ignore


@dataclass(frozen=True, slots=True)
class HubFile:
    path: str
    size: int
    lfs_sha256: str | None


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hub_files(info: Any, tier: str) -> dict[str, HubFile]:
    prefix = f"bundles/{tier}/"
    out: dict[str, HubFile] = {}
    for sibling in info.siblings:
        path = getattr(sibling, "rfilename", None)
        if not isinstance(path, str) or not path.startswith(prefix):
            continue
        rel = path[len(prefix):]
        size = getattr(sibling, "size", 0)
        lfs = getattr(sibling, "lfs", None)
        sha = getattr(lfs, "sha256", None) if lfs is not None else None
        out[rel] = HubFile(
            path=path,
            size=size if isinstance(size, int) else 0,
            lfs_sha256=sha if isinstance(sha, str) else None,
        )
    return out


def _download_bytes(api: Any, repo_id: str, path: str, *, repo_type: str = "model") -> bytes:
    with TemporaryDirectory(prefix="eliza1-integrity-") as tmp:
        try:
            local = api.hf_hub_download(
                repo_id=repo_id,
                filename=path,
                repo_type=repo_type,
                local_dir=tmp,
            )
        except AttributeError:
            from huggingface_hub import hf_hub_download

            token = getattr(api, "token", None)
            local = hf_hub_download(
                repo_id,
                path,
                repo_type=repo_type,
                local_dir=tmp,
                token=token,
            )
        return Path(local).read_bytes()


def _hash_for_file(api: Any, repo_id: str, item: HubFile) -> str:
    if item.lfs_sha256:
        return item.lfs_sha256
    return _sha256_bytes(_download_bytes(api, repo_id, item.path))


def _hashes_for_tier(api: Any, repo_id: str, files: Mapping[str, HubFile]) -> dict[str, str]:
    return {rel: _hash_for_file(api, repo_id, item) for rel, item in sorted(files.items())}


def _update_manifest_hashes(manifest: dict[str, Any], hashes: Mapping[str, str]) -> list[str]:
    changed: list[str] = []
    files = manifest.get("files")
    if not isinstance(files, dict):
        return changed
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            rel = entry.get("path")
            if not isinstance(rel, str) or rel not in hashes:
                continue
            old = entry.get("sha256")
            new = hashes[rel]
            if old != new:
                entry["sha256"] = new
                changed.append(rel)
    return changed


def _render_checksums(hashes: Mapping[str, str]) -> str:
    lines = [
        f"{digest}  {rel}"
        for rel, digest in sorted(hashes.items())
        if rel != "checksums/SHA256SUMS"
    ]
    return "\n".join(lines) + "\n"


def plan_repair(api: Any, repo_id: str, tier: str) -> dict[str, Any]:
    info = api.model_info(repo_id, files_metadata=True)
    files = _hub_files(info, tier)
    if not files:
        raise SystemExit(f"no files found under bundles/{tier}/")
    hashes = _hashes_for_tier(api, repo_id, files)
    manifest = json.loads(_download_bytes(api, repo_id, f"bundles/{tier}/eliza-1.manifest.json"))
    changed_manifest_paths = _update_manifest_hashes(manifest, hashes)
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    hashes["eliza-1.manifest.json"] = _sha256_bytes(manifest_bytes)
    checksum_text = _render_checksums(hashes)
    existing_checksum = _download_bytes(api, repo_id, f"bundles/{tier}/checksums/SHA256SUMS").decode()
    checksum_changed = existing_checksum != checksum_text
    return {
        "tier": tier,
        "fileCount": len(files),
        "changedManifestPaths": changed_manifest_paths,
        "checksumChanged": checksum_changed,
        "manifestText": manifest_bytes.decode(),
        "checksumText": checksum_text,
    }


def apply_repair(api: Any, repo_id: str, plans: list[dict[str, Any]]) -> str:
    from huggingface_hub import CommitOperationAdd

    operations = []
    with TemporaryDirectory(prefix="eliza1-integrity-commit-") as tmp:
        root = Path(tmp)
        for plan in plans:
            tier = str(plan["tier"])
            manifest_path = root / tier / "eliza-1.manifest.json"
            checksum_path = root / tier / "SHA256SUMS"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(str(plan["manifestText"]), encoding="utf-8")
            checksum_path.write_text(str(plan["checksumText"]), encoding="utf-8")
            operations.append(
                CommitOperationAdd(
                    path_in_repo=f"bundles/{tier}/eliza-1.manifest.json",
                    path_or_fileobj=str(manifest_path),
                )
            )
            operations.append(
                CommitOperationAdd(
                    path_in_repo=f"bundles/{tier}/checksums/SHA256SUMS",
                    path_or_fileobj=str(checksum_path),
                )
            )
        info = api.create_commit(
            repo_id=repo_id,
            repo_type="model",
            operations=operations,
            commit_message="Repair Eliza-1 bundle integrity metadata",
            commit_description=(
                "Refreshes bundle manifests and SHA256SUMS from current Hub object "
                "hashes. Does not alter weights, eval results, backend verification "
                "statuses, or release-state claims."
            ),
        )
    return info.commit_url


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--repo-id", default=ELIZA_1_HF_REPO)
    ap.add_argument("--tier", choices=(*ELIZA_1_TIERS, "all"), default="all")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    from huggingface_hub import HfApi

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    api = HfApi(token=token)
    tiers = ELIZA_1_TIERS if args.tier == "all" else (args.tier,)
    plans = [plan_repair(api, args.repo_id, tier) for tier in tiers]
    summary = {
        "repoId": args.repo_id,
        "apply": args.apply,
        "tiers": [
            {
                "tier": plan["tier"],
                "fileCount": plan["fileCount"],
                "changedManifestPaths": plan["changedManifestPaths"],
                "checksumChanged": plan["checksumChanged"],
            }
            for plan in plans
        ],
    }
    if args.apply:
        summary["commitUrl"] = apply_repair(api, args.repo_id, plans)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
