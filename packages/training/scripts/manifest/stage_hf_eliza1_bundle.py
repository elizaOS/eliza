#!/usr/bin/env python3
"""Stage exactly one Eliza-1 HF bundle with a size cap.

This is the guarded materialization step before running
``release_verification_queue --next`` commands. It refuses to stage more than
one tier and estimates bytes from Hub metadata before downloading, so local
verification can stay within the "one LLM at a time" memory/disk discipline.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    from scripts.manifest.eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import ELIZA_1_HF_REPO, ELIZA_1_TIERS  # type: ignore


DEFAULT_LOCAL_DIR = Path("/tmp/eliza-1-bundles")
DEFAULT_MAX_BYTES = 8 * 1024**3


@dataclass(frozen=True, slots=True)
class TierFile:
    remote_path: str
    local_rel: str
    size: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "remotePath": self.remote_path,
            "localRel": self.local_rel,
            "size": self.size,
        }


def _sibling_name(sibling: Any) -> str | None:
    value = getattr(sibling, "rfilename", None)
    return value if isinstance(value, str) else None


def _sibling_size(sibling: Any) -> int:
    value = getattr(sibling, "size", None)
    return int(value) if isinstance(value, int) and value >= 0 else 0


def plan_tier_files(siblings: Iterable[Any], tier: str) -> list[TierFile]:
    prefix = f"bundles/{tier}/"
    out: list[TierFile] = []
    for sibling in siblings:
        name = _sibling_name(sibling)
        if not name or not name.startswith(prefix):
            continue
        out.append(
            TierFile(
                remote_path=name,
                local_rel=f"eliza-1-{tier}.bundle/{name[len(prefix):]}",
                size=_sibling_size(sibling),
            )
        )
    return sorted(out, key=lambda item: item.remote_path)


def total_size(files: Sequence[TierFile]) -> int:
    return sum(item.size for item in files)


def stage_tier(
    *,
    repo_id: str,
    tier: str,
    local_dir: Path,
    max_bytes: int,
    apply: bool,
    token: str | None = None,
) -> dict[str, Any]:
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi(token=token)
    info = api.model_info(repo_id, files_metadata=True)
    files = plan_tier_files(info.siblings, tier)
    planned_bytes = total_size(files)
    if not files:
        raise SystemExit(f"no files found for {repo_id} bundles/{tier}/")
    if planned_bytes > max_bytes:
        raise SystemExit(
            f"refusing to stage {tier}: planned {planned_bytes} bytes exceeds cap {max_bytes}"
        )

    bundle_dir = local_dir / f"eliza-1-{tier}.bundle"
    staged: list[str] = []
    if apply:
        for item in files:
            local_path = local_dir / item.local_rel
            local_path.parent.mkdir(parents=True, exist_ok=True)
            hf_hub_download(
                repo_id,
                item.remote_path,
                repo_type="model",
                local_dir=local_dir,
                token=token,
            )
            downloaded = local_dir / item.remote_path
            if downloaded != local_path:
                local_path.parent.mkdir(parents=True, exist_ok=True)
                if local_path.exists():
                    local_path.unlink()
                downloaded.replace(local_path)
                # Remove empty source dirs left by local_dir preserving Hub paths.
                parent = downloaded.parent
                while parent != local_dir and not any(parent.iterdir()):
                    parent.rmdir()
                    parent = parent.parent
            staged.append(str(local_path))

    return {
        "repoId": repo_id,
        "tier": tier,
        "bundleDir": str(bundle_dir),
        "fileCount": len(files),
        "plannedBytes": planned_bytes,
        "maxBytes": max_bytes,
        "apply": apply,
        "files": [item.as_dict() for item in files],
        "staged": staged,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--repo-id", default=ELIZA_1_HF_REPO)
    ap.add_argument("--tier", choices=ELIZA_1_TIERS, required=True)
    ap.add_argument("--local-dir", type=Path, default=DEFAULT_LOCAL_DIR)
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--apply", action="store_true", help="Actually download files. Default is plan only.")
    args = ap.parse_args(argv)

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    result = stage_tier(
        repo_id=args.repo_id,
        tier=args.tier,
        local_dir=args.local_dir,
        max_bytes=args.max_bytes,
        apply=args.apply,
        token=token,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
