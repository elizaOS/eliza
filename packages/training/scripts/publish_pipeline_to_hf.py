"""Publish the eliza-1 training pipeline to HuggingFace Hub.

This creates an HF *model* repo (HF has no separate "pipeline" repo type)
that bundles the training scripts so a fresh Vast.ai box can:

    git clone <nothing — straight HF download>
    hf download elizaos/eliza-1-pipeline --local-dir /workspace/training
    cd /workspace/training && uv sync --extra train
    bash scripts/train_vast.sh ...

Companion to ``publish_dataset_to_hf.py`` (data) and
``push_model_to_hf.py`` (trained checkpoints). Distinct from the legacy
``push_pipeline_to_hf.py`` which targets the older
``elizaos/eliza-1-pipeline`` repo and includes a wider tree.

Usage::

    uv run python scripts/publish_pipeline_to_hf.py \\
        --repo-id elizaos/eliza-1-pipeline --dry-run

    HF_TOKEN=hf_xxx uv run python scripts/publish_pipeline_to_hf.py \\
        --repo-id elizaos/eliza-1-pipeline
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Top-level docs (bundled at the repo root).
TOP_LEVEL_FILES: tuple[str, ...] = (
    "pyproject.toml",
    "uv.lock",
    "CLAUDE.md",
    "AGENTS.md",
    "RL_STRATEGY.md",
    "Dockerfile",
    "Dockerfile.cpu",
)
# Older docs that may live under scripts/ in this checkout. We accept either
# location and re-anchor the bundled name at the repo root.
SCOPED_DOCS: tuple[tuple[str, str], ...] = (
    ("CLOUD_VAST.md", "scripts/CLOUD_VAST.md"),
    ("CHECKPOINT_SYNC.md", "scripts/CHECKPOINT_SYNC.md"),
    ("RL_TRAINING.md", "scripts/RL_TRAINING.md"),
    ("CI.md", "CI.md"),
)

# What to exclude inside scripts/ when uploading the recursive tree.
EXCLUDE_PATTERNS: tuple[str, ...] = (
    "__pycache__",
    "*/__pycache__",
    "*/__pycache__/*",
    "**/__pycache__/**",
    "*.pyc",
    "*.pyo",
    ".pytest_cache",
    ".pytest_cache/*",
    "*/.pytest_cache",
    "*/.pytest_cache/*",
    "*.egg-info",
    "*.egg-info/*",
    ".DS_Store",
    "*.so",            # vendored CUDA build outputs
    "*.o",
    ".vast_instance_id",
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("publish_pipeline")


@dataclass(frozen=True)
class PipelineFile:
    src: Path             # absolute on local disk
    path_in_repo: str     # relative path inside the HF repo


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _matches_exclude(rel: str) -> bool:
    return any(fnmatch(rel, p) for p in EXCLUDE_PATTERNS)


def _walk_scripts() -> list[PipelineFile]:
    out: list[PipelineFile] = []
    scripts_root = ROOT / "scripts"
    if not scripts_root.exists():
        return out
    for path in sorted(scripts_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)  # e.g. scripts/training/foo.py
        rel_str = str(rel)
        # exclude hits anywhere in the path
        if _matches_exclude(rel_str):
            continue
        # also skip if any path component is __pycache__ etc.
        if any(part in {"__pycache__", ".pytest_cache", ".egg-info"} for part in rel.parts):
            continue
        out.append(PipelineFile(src=path, path_in_repo=rel_str))
    return out


def _collect_top_level_docs() -> list[PipelineFile]:
    out: list[PipelineFile] = []
    for name in TOP_LEVEL_FILES:
        p = ROOT / name
        if p.exists() and p.is_file():
            out.append(PipelineFile(src=p, path_in_repo=name))
    for bundled_name, candidate in SCOPED_DOCS:
        for cand in (candidate, bundled_name):
            p = ROOT / cand
            if p.exists() and p.is_file():
                out.append(PipelineFile(src=p, path_in_repo=bundled_name))
                break
    return out


def build_pipeline_card(repo_id: str) -> str:
    return (
        "---\n"
        "license: apache-2.0\n"
        "tags:\n"
        "  - eliza\n"
        "  - elizaos\n"
        "  - training-pipeline\n"
        "  - apollo\n"
        "  - qwen\n"
        "---\n"
        "\n"
        "# eliza-1-pipeline\n"
        "\n"
        "This is the **trainer pipeline** for the elizaOS *eliza-1* model\n"
        "series — not a model. It bundles the scripts, configs, and Vast.ai\n"
        "automation needed to take a fresh GPU box and run an APOLLO\n"
        "full-finetune end to end.\n"
        "\n"
        "Companion repos:\n"
        "\n"
        "- `elizaos/eliza-1-training` — SFT data (train/val/test).\n"
        "- `elizaos/eliza-1-scambench` — adversarial scam set.\n"
        "- `elizaos/eliza-1-synthesized` — small Claude-teacher synthesis sets.\n"
        "- `elizaos/eliza-1-{2b,9b,27b}` — published checkpoints.\n"
        "\n"
        "## Vast.ai bootstrap\n"
        "\n"
        "On a fresh Vast box (after attaching SSH and `apt install rsync git\n"
        "tmux jq curl ca-certificates build-essential python3-dev` + `curl\n"
        "-LsSf https://astral.sh/uv/install.sh | sh`):\n"
        "\n"
        "```bash\n"
        f"hf download {repo_id} --local-dir /workspace/training\n"
        "hf download elizaos/eliza-1-training --repo-type dataset \\\n"
        "    --local-dir /workspace/training/data/final\n"
        "cd /workspace/training\n"
        "uv sync --extra train\n"
        "bash scripts/train_vast.sh run\n"
        "```\n"
        "\n"
        "Or, from your local box, drive the whole flow:\n"
        "\n"
        "```bash\n"
        "bash scripts/train_vast.sh provision-and-train \\\n"
        "    --registry-key qwen3.5-9b --bootstrap hf\n"
        "```\n"
        "\n"
        "The `--bootstrap hf` flag tells `train_vast.sh` to download both this\n"
        "pipeline repo and the training data repo onto the remote, instead of\n"
        "rsyncing from your local box.\n"
        "\n"
        "## Layout\n"
        "\n"
        "```\n"
        "scripts/\n"
        "  training/        APOLLO entrypoints, model_registry.py, dataset packers\n"
        "  quantization/    PolarQuant / TurboQuant / QJL / FP8 / GGUF / abliteration\n"
        "  inference/       serve_vllm.py + per-GPU profiles\n"
        "  benchmark/       native_tool_call_bench harness\n"
        "  train_vast.sh    Canonical cloud entrypoint\n"
        "pyproject.toml     uv project (deps + extras)\n"
        "uv.lock            pinned deps\n"
        "```\n"
        "\n"
        "## License\n"
        "\n"
        "Apache-2.0 for source. Note that abliterated weight artifacts produced\n"
        "by `scripts/training/abliterate.py` are *AGPL-3.0* downstream because\n"
        "Heretic itself is AGPL — see `CLAUDE.md` for the full caveat.\n"
    )


def _print_dry_run(files: list[PipelineFile], repo_id: str) -> int:
    log.info("repo_id=%s (dry-run)", repo_id)
    if not files:
        log.error("no files matched; refusing to publish an empty repo.")
        return 2
    total = sum(f.src.stat().st_size for f in files)
    log.info("would upload %d files, %.2f MB total", len(files), total / 1e6)
    head = files[:60]
    for f in head:
        log.info("  %s", f.path_in_repo)
    if len(files) > len(head):
        log.info("  ... and %d more", len(files) - len(head))
    log.info("README preview:\n%s", build_pipeline_card(repo_id))
    return 0


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _remote_sha256(api, repo_id: str, path_in_repo: str) -> str | None:
    try:
        info = api.repo_info(repo_id, repo_type="model", files_metadata=True)
    except Exception:
        return None
    for sibling in getattr(info, "siblings", []) or []:
        if sibling.rfilename != path_in_repo:
            continue
        lfs = getattr(sibling, "lfs", None)
        if lfs:
            return getattr(lfs, "sha256", None) or (lfs.get("sha256") if isinstance(lfs, dict) else None)
        return None
    return None


def publish(files: list[PipelineFile], repo_id: str, public: bool) -> int:
    if not hf_token():
        log.error("HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing to push.")
        return 1
    if not files:
        log.error("no files matched; refusing to publish an empty repo.")
        return 2

    from huggingface_hub import CommitOperationAdd, HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())

    try:
        api.repo_info(repo_id, repo_type="model")
        log.info("repo %s already exists", repo_id)
    except RepositoryNotFoundError:
        log.info("repo %s does not exist — creating (private=%s)", repo_id, not public)
        api.create_repo(
            repo_id=repo_id,
            repo_type="model",
            private=not public,
            exist_ok=False,
        )

    # Build remote sha index in one shot so we can skip unchanged LFS blobs.
    remote_shas: dict[str, str] = {}
    try:
        info = api.repo_info(repo_id, repo_type="model", files_metadata=True)
        for sib in getattr(info, "siblings", []) or []:
            lfs = getattr(sib, "lfs", None)
            if not lfs:
                continue
            sha = getattr(lfs, "sha256", None) or (
                lfs.get("sha256") if isinstance(lfs, dict) else None
            )
            if sha:
                remote_shas[sib.rfilename] = sha
    except Exception:
        pass

    operations: list[CommitOperationAdd] = [
        CommitOperationAdd(
            path_in_repo="README.md",
            path_or_fileobj=build_pipeline_card(repo_id).encode("utf-8"),
        )
    ]
    skipped = 0
    for f in files:
        target = f.path_in_repo
        if target in remote_shas:
            local_sha = _sha256_file(f.src)
            if remote_shas[target] == local_sha:
                skipped += 1
                continue
        operations.append(
            CommitOperationAdd(
                path_in_repo=target,
                path_or_fileobj=str(f.src),
            )
        )

    log.info(
        "committing %d files in one commit (%d skipped as unchanged)",
        len(operations),
        skipped,
    )
    api.create_commit(
        repo_id=repo_id,
        repo_type="model",
        operations=operations,
        commit_message=f"eliza-1-pipeline: publish {len(operations)} files",
    )

    log.info("done. https://huggingface.co/%s", repo_id)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--repo-id",
        required=True,
        help="Destination HF model repo id (e.g. elizaos/eliza-1-pipeline).",
    )
    ap.add_argument(
        "--private",
        action="store_true",
        help="Create the repo as private (default: public).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the file list + total bytes; do not authenticate or push.",
    )
    args = ap.parse_args()

    docs = _collect_top_level_docs()
    # If a scoped doc is bundled at the repo root (e.g. scripts/CLOUD_VAST.md
    # promoted to CLOUD_VAST.md), drop the original location from the
    # recursive scripts walk so we don't ship two copies in the same repo.
    promoted_sources = {f.src for f in docs}
    walked = [f for f in _walk_scripts() if f.src not in promoted_sources]
    files = docs + walked
    if args.dry_run:
        return _print_dry_run(files, args.repo_id)
    return publish(files, args.repo_id, public=not args.private)


if __name__ == "__main__":
    sys.exit(main())
