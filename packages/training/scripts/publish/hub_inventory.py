"""Read the remote LFS inventory shared by dataset and pipeline publication.

Metadata failures abort planning before either publisher queues an upload;
files without LFS metadata remain eligible for their normal commit path.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from huggingface_hub import HfApi


def remote_lfs_shas(api: HfApi, repo_id: str) -> dict[str, str]:
    info = api.repo_info(repo_id, repo_type="dataset", files_metadata=True)
    remote_shas: dict[str, str] = {}
    for sibling in info.siblings or []:
        lfs = sibling.lfs
        if not lfs:
            continue
        sha = getattr(lfs, "sha256", None) or (
            lfs.get("sha256") if isinstance(lfs, dict) else None
        )
        if sha:
            remote_shas[sibling.rfilename] = sha
    return remote_shas
