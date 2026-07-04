"""Publish fine-tuned eliza-1 models and training datasets to HuggingFace.

Models are published to elizaos/eliza-1 under bundles/<tier>/ using the
canonical publish/publish_model.py dispatcher. Datasets are published to
elizaos/eliza-1-training-data from data/converted/ JSONL files using
publish/publish_dataset.py.

Requires HF_TOKEN in the environment (or --token on the command line).

Usage:
    # Publish everything (models + datasets) for all tiers, dry run first
    uv run python scripts/publish_all_finetuned.py --what all --dry-run

    # Publish models for two tiers
    uv run python scripts/publish_all_finetuned.py \
        --what models \
        --tiers gemma4-e2b,gemma4-e4b

    # Publish datasets only
    uv run python scripts/publish_all_finetuned.py --what datasets

    # Full publish with an explicit token
    uv run python scripts/publish_all_finetuned.py \
        --what all --token hf_xxxx
"""

from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("publish_all_finetuned")

ALL_TIERS: list[str] = [
    "gemma4-e2b",
    "gemma4-e4b",
    "gemma4-12b",
    "gemma4-31b",
]

# HuggingFace repo IDs
HF_MODEL_REPO = "elizaos/eliza-1"
HF_DATASET_REPO = "elizaos/eliza-1-training-data"


def _run(cmd: list[str], *, dry_run: bool, env: dict | None = None) -> int:
    """Run a subprocess, or print it in dry-run mode."""
    log.info("$ %s", " ".join(cmd))
    if dry_run:
        log.info("  [dry-run] skipping")
        return 0
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, env=env, cwd=str(ROOT))
    log.info("  → exit=%d (%.1fs)", proc.returncode, time.perf_counter() - t0)
    return proc.returncode


def _find_bundle_dir(checkpoints_dir: Path, tier: str, entry: Any) -> Path | None:
    """Find the assembled bundle directory for a tier.

    Uses the final checkpoint directory. The retired eliza1-optimized/ output
    was produced by the legacy optimizer and must not be preferred for
    app-facing publishes.
    """
    eliza_name = entry.eliza_short_name
    if checkpoints_dir.exists():
        # Most recent run dir for this tier
        for d in sorted(checkpoints_dir.iterdir(), reverse=True):
            if d.is_dir() and (
                d.name.startswith(eliza_name) or
                d.name.startswith(tier.replace(".", "-"))
            ):
                final = d / "final"
                if final.exists():
                    return final
    return None


def _collect_dataset_files(data_dir: Path) -> list[Path]:
    """Collect JSONL files from data/converted/ for dataset upload."""
    converted_dir = data_dir / "converted"
    if not converted_dir.exists():
        # Fall back to data/final/
        final_dir = data_dir / "final"
        if final_dir.exists():
            return sorted(final_dir.glob("*.jsonl"))
        return []
    return sorted(converted_dir.glob("*.jsonl"))


def publish_model_tier(
    tier: str,
    entry: Any,
    checkpoints_dir: Path,
    *,
    dry_run: bool,
    hf_token: str | None,
) -> dict[str, Any]:
    """Publish a single tier's bundle to HuggingFace."""
    bundle_dir = _find_bundle_dir(checkpoints_dir, tier, entry)
    result: dict[str, Any] = {
        "tier": tier,
        "eliza_short_name": entry.eliza_short_name,
        "bundle_dir": str(bundle_dir) if bundle_dir else None,
        "repo": f"{HF_MODEL_REPO}/bundles/{entry.eliza_short_name}",
        "status": "pending",
        "error": None,
    }

    if bundle_dir is None:
        msg = f"no bundle found for {tier} under {checkpoints_dir}"
        log.warning("[%s] %s", tier, msg)
        result["status"] = "skipped"
        result["error"] = msg
        return result

    log.info("[%s] publishing bundle %s → %s", tier, bundle_dir, result["repo"])

    env = dict(os.environ)
    if hf_token:
        env["HF_TOKEN"] = hf_token
        env["HUGGING_FACE_HUB_TOKEN"] = hf_token

    # Delegate to publish/publish_model.py --mode tier
    cmd = [
        sys.executable, "scripts/publish/publish_model.py",
        "--mode", "tier",
        "--tier", entry.eliza_short_name,
        "--bundle-dir", str(bundle_dir),
    ]
    if dry_run:
        cmd.append("--dry-run")

    rc = _run(cmd, dry_run=False, env=env)  # dry_run handled by --dry-run flag above
    if rc == 0:
        result["status"] = "ok"
        log.info("[%s] published successfully", tier)
    else:
        result["status"] = "failed"
        result["error"] = f"publish_model.py exited {rc}"
        log.error("[%s] publish failed (exit=%d)", tier, rc)

    return result


def publish_datasets(
    data_dir: Path,
    *,
    dry_run: bool,
    hf_token: str | None,
) -> dict[str, Any]:
    """Upload JSONL dataset files to HuggingFace."""
    files = _collect_dataset_files(data_dir)
    result: dict[str, Any] = {
        "repo": HF_DATASET_REPO,
        "files": [str(f) for f in files],
        "status": "pending",
        "error": None,
    }

    if not files:
        msg = f"no JSONL files found under {data_dir}/converted/ or {data_dir}/final/"
        log.warning(msg)
        result["status"] = "skipped"
        result["error"] = msg
        return result

    log.info("publishing %d JSONL files → %s", len(files), HF_DATASET_REPO)
    for f in files:
        log.info("  %s", f)

    env = dict(os.environ)
    if hf_token:
        env["HF_TOKEN"] = hf_token
        env["HUGGING_FACE_HUB_TOKEN"] = hf_token

    # Delegate to publish/publish_dataset.py
    cmd = [
        sys.executable, "scripts/publish/publish_dataset.py",
        "--repo", HF_DATASET_REPO,
    ]
    for f in files:
        cmd += ["--file", str(f)]
    if dry_run:
        cmd.append("--dry-run")

    rc = _run(cmd, dry_run=False, env=env)
    if rc == 0:
        result["status"] = "ok"
        log.info("dataset upload complete")
    else:
        result["status"] = "failed"
        result["error"] = f"publish_dataset.py exited {rc}"
        log.error("dataset upload failed (exit=%d)", rc)

    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Publish fine-tuned eliza-1 models and datasets to HuggingFace.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--what",
        choices=("models", "datasets", "all"),
        default="all",
        help="What to publish. Default: all.",
    )
    ap.add_argument(
        "--tiers",
        default="all",
        help=(
            "Comma-separated tier keys for model publishing. "
            "Default: all. Ignored when --what datasets."
        ),
    )
    ap.add_argument(
        "--checkpoints-dir",
        default=str(ROOT / "checkpoints"),
        help="Root directory to search for tier bundles.",
    )
    ap.add_argument(
        "--data-dir",
        default=str(ROOT / "data"),
        help="Data directory; publish_datasets looks in <data-dir>/converted/ then <data-dir>/final/.",
    )
    ap.add_argument(
        "--token",
        default=None,
        help="HuggingFace token. Falls back to HF_TOKEN env var.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be uploaded without pushing anything.",
    )
    args = ap.parse_args()

    hf_token = args.token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not hf_token and not args.dry_run:
        log.error(
            "HF_TOKEN is not set. Export it or pass --token. "
            "Use --dry-run to preview without a token."
        )
        return 1

    from training.model_registry import REGISTRY, get as registry_get

    if args.tiers == "all":
        selected_tiers = ALL_TIERS
    else:
        selected_tiers = [t.strip() for t in args.tiers.split(",") if t.strip()]
        for t in selected_tiers:
            try:
                registry_get(t)
            except KeyError:
                log.error("unknown tier %r; known: %s", t, sorted(REGISTRY))
                return 1

    checkpoints_dir = Path(args.checkpoints_dir)
    data_dir = Path(args.data_dir)
    publish_models = args.what in ("models", "all")
    publish_data = args.what in ("datasets", "all")

    model_results: list[dict[str, Any]] = []
    dataset_result: dict[str, Any] | None = None

    if args.dry_run:
        log.info("[dry-run] listing what would be published:")

    if publish_models:
        for tier in selected_tiers:
            entry = registry_get(tier)
            bundle = _find_bundle_dir(checkpoints_dir, tier, entry)
            if args.dry_run:
                log.info(
                    "  model: %s → %s/bundles/%s (bundle: %s)",
                    tier, HF_MODEL_REPO, entry.eliza_short_name,
                    bundle or "NOT FOUND",
                )
                model_results.append({
                    "tier": tier,
                    "eliza_short_name": entry.eliza_short_name,
                    "bundle_dir": str(bundle) if bundle else None,
                    "repo": f"{HF_MODEL_REPO}/bundles/{entry.eliza_short_name}",
                    "status": "dry_run",
                    "error": None if bundle else "no bundle found",
                })
            else:
                r = publish_model_tier(
                    tier, entry, checkpoints_dir,
                    dry_run=False, hf_token=hf_token,
                )
                model_results.append(r)

    if publish_data:
        if args.dry_run:
            files = _collect_dataset_files(data_dir)
            log.info("  datasets: %d JSONL files → %s", len(files), HF_DATASET_REPO)
            for f in files:
                log.info("    %s", f)
            dataset_result = {
                "repo": HF_DATASET_REPO,
                "files": [str(f) for f in files],
                "status": "dry_run",
                "error": None,
            }
        else:
            dataset_result = publish_datasets(
                data_dir, dry_run=False, hf_token=hf_token,
            )

    # Summary
    print("\n" + "=" * 70)
    if publish_models:
        print("MODELS:")
        for r in model_results:
            status = r.get("status", "?")
            err = f"  ({r['error']})" if r.get("error") else ""
            print(f"  {r['eliza_short_name']:<20} → {r['repo']:<45} {status}{err}")
    if publish_data and dataset_result:
        status = dataset_result.get("status", "?")
        n = len(dataset_result.get("files", []))
        err = f"  ({dataset_result['error']})" if dataset_result.get("error") else ""
        print(f"DATASETS: {n} files → {HF_DATASET_REPO}  {status}{err}")
    print("=" * 70)

    any_failed = any(
        r.get("status") == "failed" for r in model_results
    ) or (dataset_result is not None and dataset_result.get("status") == "failed")

    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())
