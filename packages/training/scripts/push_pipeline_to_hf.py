"""Publish the eliza-training-pipeline source tree to HuggingFace Hub.

The training/ directory is intentionally NOT committed to the eliza git
repo (see /home/shaw/eliza/.gitignore). HuggingFace is the canonical
artifact store for everything in this tree:

  - corpora + dataset splits → ``elizaos/eliza-native-v1-sft``  (push_to_hf.py)
  - trained checkpoints      → ``elizaos/eliza-1`` under ``bundles/<tier>/`` (push_model_to_hf.py)
  - this pipeline (scripts + configs + reports) → ``elizaos/eliza-1-pipeline``
    (THIS script)

That keeps the eliza repo small, prevents accidental commits of
unfiltered trajectory data, and gives the team one URL to point training
runners at.

What this script uploads:
  - ``scripts/``         — the entire Python pipeline (download → normalize →
                           pack → train → quantize → benchmark → push).
  - ``*.md``             — README, RL_STRATEGY, TRAINING_PLAN, SCHEMA, run reports.
  - ``datasets.yaml``    — corpus manifest the pipeline reads at preprocess time.
  - ``pyproject.toml``   — uv project config.
  - ``uv.lock``          — pinned deps for reproducibility.

What this script never uploads (matched against ``EXCLUDE_PATTERNS`` below):
  - ``data/``, ``checkpoints/``, ``previews/``, ``local-corpora/`` — heavy or
    user-derived.
  - ``.venv/``, ``__pycache__/``, ``*.pyc``, ``wandb/`` — transient.
  - ``training-babylon/``, ``sim/``, ``tools/`` — sibling subprojects with
    their own canonical homes (they get their own pushes when they're
    ready, not as part of the eliza-training-pipeline release).

Usage::

    # Dry-run — print the file list and skip the upload.
    uv run python scripts/push_pipeline_to_hf.py --dry-run

    # Upload (creates the repo private if missing; flip to public via the UI).
    HF_TOKEN=hf_xxx uv run python scripts/push_pipeline_to_hf.py

    # Public from the start with a custom repo id.
    HF_TOKEN=hf_xxx uv run python scripts/push_pipeline_to_hf.py \\
        --repo-id myorg/my-pipeline --public
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_REPO_ID = "elizaos/eliza-1-pipeline"

# Things we explicitly do NOT publish. Matched as fnmatch patterns against
# both file paths and directory paths (relative to training/).
#
# What we ALWAYS include (intentionally not in the exclude list, listed here
# so the next reader doesn't go hunting for opt-ins):
#   - scripts/inference/{entropix_sampler.py,serve_vllm.py,...}
#   - scripts/training/{te_fp8.py,abliterate.py,model_registry.py,...}
#   - scripts/templates/model_card_*.md  (used by push_model_to_hf.py)
#   - scripts/publish_all_eliza1.sh      (matrix orchestrator)
#   - scripts/training/README.md, scripts/quantization/README.md
EXCLUDE_PATTERNS: tuple[str, ...] = (
    # Heavy artifacts — these go in their own repos.
    "data",
    "data/*",
    "checkpoints",
    "checkpoints/*",
    "previews",
    "previews/*",
    "local-corpora",
    "local-corpora/*",
    # Transient.
    ".venv",
    ".venv/*",
    "__pycache__",
    "*/__pycache__",
    "*/__pycache__/*",
    "*.pyc",
    "wandb",
    "wandb/*",
    ".pytest_cache",
    ".pytest_cache/*",
    "*/.pytest_cache",
    "*/.pytest_cache/*",
    # Belt-and-suspenders for things HfApi.upload_folder also filters
    # internally — kept here so --dry-run reflects reality.
    ".git",
    ".git/*",
    "node_modules",
    "node_modules/*",
    "*.parquet",
    # Sibling subprojects with their own canonical homes.
    "training-babylon",
    "training-babylon/*",
    "sim",
    "sim/*",
    "tools",
    "tools/*",
    # Shell utilities not needed downstream.
    "__free_disk.sh",
    # Vast SDK state file (per-instance; not source).
    ".vast_instance_id",
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("push_pipeline")


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def build_pipeline_card() -> str:
    """README rendered at the top of the HF repo. Kept short and honest."""
    return (
        "---\n"
        "license: apache-2.0\n"
        "tags:\n"
        "  - eliza\n"
        "  - elizaos\n"
        "  - training-pipeline\n"
        "  - apollo\n"
        "  - rlvr\n"
        "  - grpo\n"
        "  - qwen3.5\n"
        "---\n"
        "\n"
        "# eliza-training-pipeline\n"
        "\n"
        "End-to-end training pipeline for the elizaOS **eliza-1** model series.\n"
        "The app-facing GGUF bundles publish to the single model repo\n"
        "[`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1) under\n"
        "`bundles/<tier>/` paths.\n"
        "\n"
        "Trained on [`elizaos/eliza-native-v1-sft`](https://huggingface.co/datasets/elizaos/eliza-native-v1-sft).\n"
        "\n"
        "## What this repo is\n"
        "\n"
        "The full training pipeline source tree (scripts, configs, reports). The\n"
        "eliza core repo intentionally does NOT track this tree — HuggingFace is\n"
        "the canonical artifact store for everything training-related so corpora,\n"
        "checkpoints, and pipeline source can be versioned without bloating the\n"
        "main monorepo.\n"
        "\n"
        "## Pipeline\n"
        "\n"
        "```\n"
        "datasets.yaml ──▶ download_datasets.py ──▶ data/raw/<slug>/\n"
        "                                              │\n"
        "                                              ▼\n"
        "                                       normalize.py\n"
        "                                              │\n"
        "                                              ▼\n"
        "                                       pack_dataset.py\n"
        "                                              │\n"
        "                                              ▼\n"
        "                            data/final/{train,val,test}.jsonl\n"
        "                                              │\n"
        "                                ┌─────────────┴─────────────┐\n"
        "                                ▼                           ▼\n"
        "                       train_local.py             train_nebius.sh\n"
        "                       (APOLLO, eliza-1-2b)       (APOLLO, eliza-1-4b/27b)\n"
        "                                │                           │\n"
        "                                └─────────────┬─────────────┘\n"
        "                                              ▼\n"
        "                                  scripts/quantization/\n"
        "                                  (PolarQuant, TurboQuant, GGUF)\n"
        "                                              │\n"
        "                                              ▼\n"
        "                                push_model_to_hf.py\n"
        "                                  → elizaos/eliza-1/bundles/<tier>\n"
        "```\n"
        "\n"
        "See `RL_STRATEGY.md` for the post-SFT plan (DPO + GRPO via verl).\n"
        "\n"
        "## Reproducing\n"
        "\n"
        "```bash\n"
        "hf download elizaos/eliza-1-pipeline --repo-type model --local-dir ./training\n"
        "cd training\n"
        "uv sync --extra train\n"
        "hf download elizaos/eliza-native-v1-sft --repo-type dataset --local-dir data/final\n"
        "uv run --extra train python scripts/run_pipeline.py --registry-key qwen3.5-2b --epochs 3\n"
        "```\n"
        "\n"
        "## License\n"
        "\n"
        "Apache-2.0.\n"
    )


def push(args: argparse.Namespace) -> int:
    if not args.dry_run and not hf_token():
        log.error("HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set.")
        return 1

    log.info("repo_id=%s public=%s dry_run=%s", args.repo_id, args.public, args.dry_run)
    log.info("source root: %s", ROOT)
    log.info("exclude patterns: %s", ", ".join(EXCLUDE_PATTERNS))

    if args.dry_run:
        # Approximate what HfApi.upload_folder will see by walking the tree
        # and applying the same fnmatch-style ignore patterns as below.
        from fnmatch import fnmatch

        included: list[Path] = []
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT)
            rel_str = str(rel)
            if any(fnmatch(rel_str, p) for p in EXCLUDE_PATTERNS):
                continue
            included.append(rel)
        total_bytes = sum((ROOT / p).stat().st_size for p in included)
        log.info("would upload %d files, %.2f MB", len(included), total_bytes / 1e6)
        for p in included[:50]:
            log.info("  %s", p)
        if len(included) > 50:
            log.info("  ... and %d more", len(included) - 50)
        log.info("dry-run: pipeline card preview\n%s", build_pipeline_card())
        return 0

    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())

    try:
        api.repo_info(args.repo_id, repo_type="model")
        log.info("repo %s already exists", args.repo_id)
    except RepositoryNotFoundError:
        log.info("repo %s does not exist — creating (private=%s)",
                 args.repo_id, not args.public)
        api.create_repo(
            repo_id=args.repo_id,
            repo_type="model",
            private=not args.public,
            exist_ok=False,
        )

    # Always refresh the README first.
    api.upload_file(
        path_or_fileobj=build_pipeline_card().encode("utf-8"),
        path_in_repo="README.md",
        repo_id=args.repo_id,
        repo_type="model",
        commit_message="eliza-training-pipeline: refresh README",
    )
    if args.readme_only:
        log.info("README-only mode — skipping source upload.")
        return 0

    # Upload the rest. ignore_patterns matches HfApi's usage of fnmatch.
    api.upload_folder(
        folder_path=str(ROOT),
        repo_id=args.repo_id,
        repo_type="model",
        commit_message="eliza-training-pipeline: sync source tree",
        ignore_patterns=list(EXCLUDE_PATTERNS) + ["README.md"],  # README pushed separately above
    )
    log.info("done. https://huggingface.co/%s", args.repo_id)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo-id", default=DEFAULT_REPO_ID,
                    help=f"Destination HF model repo (default: {DEFAULT_REPO_ID}).")
    ap.add_argument("--public", action="store_true",
                    help="Create the repo as public (default: private).")
    ap.add_argument("--readme-only", action="store_true",
                    help="Refresh README without re-uploading source.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the file list + card preview, no network calls.")
    return push(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
