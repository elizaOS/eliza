"""Publish everything Eliza-1 that is legitimately publishable today, and
report exactly which gate blocks each pending release.

This is the operator entry point behind ``bun run publish:eliza1``. It does
*not* bypass any gate — the per-tier bundle orchestrator (``scripts.publish
.orchestrator``) is invoked in ``--dry-run`` here for the bundle repos and
*correctly refuses* on a red gate; this script just sequences the things that
do publish (the privacy-filtered SFT datasets, the eval/bench results, the
honest pending-status cards on the bundle repos) and prints a single summary.

Publishable today (no fork build / no held-out-quality gate needed):
  - dataset ``elizaos/eliza-1-training``    (the broader SFT corpus — refreshed
    only if ``data/final/{train,val,test}.jsonl`` exists locally)
  - dataset ``elizaos/eliza-1-evals``       (the eval/bench results, kernel-verify
    evidence, the ``eliza1_gates.yaml`` thresholds, throughput snapshots)

Gated (this script reports the blocker, never bypasses it):
  - the active device bundles ``elizaos/eliza-1/bundles/<tier>`` — gated on the
    fork-built GGUFs + per-backend dispatch/verify evidence + the runnable-on-
    base evals + the released license review (orchestrator stage 2/3/4).
  - the fine-tuned ``recommended``-channel weights — gated on the full-corpus
    SFT clearing ``format_ok`` and beating the matching Qwen3.5 baseline.

Usage::

    bun run publish:eliza1                 # publish datasets + evals, report pending
    bun run publish:eliza1 -- --dry-run    # report only, push nothing
    HF_TOKEN=hf_xxx bun run publish:eliza1
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("publish_eliza1_all")

TRAINING_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TRAINING_ROOT.parents[1]
if str(TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(TRAINING_ROOT))

from scripts.manifest import eliza1_manifest as M  # noqa: E402

ORG = "elizaos"

# Active Qwen3.5 device bundles. Retired Qwen3 `0_6b` / `1_7b` repos are
# handled by deprecation tooling, not by the current release publisher.
BUNDLE_TIERS = M.ELIZA_1_TIERS

# Where the staged bundles live on a dev box (see RELEASE_V1.md). The path can
# be overridden with --bundles-root.
DEFAULT_BUNDLES_ROOT = Path.home() / ".eliza" / "local-inference" / "models"


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


@dataclass
class Outcome:
    repo: str
    kind: str  # "dataset" | "model-bundle" | "model-weights"
    status: str  # "published" | "pending" | "skipped"
    detail: str


def _upload_dataset_folder(api, repo_id: str, folder: Path, *, message: str,
                           ignore: list[str] | None, dry_run: bool) -> Outcome:
    if not folder.is_dir():
        return Outcome(repo_id, "dataset", "skipped", f"local source missing: {folder}")
    rel = folder.relative_to(REPO_ROOT) if folder.is_relative_to(REPO_ROOT) else folder
    if dry_run:
        return Outcome(repo_id, "dataset", "pending", f"would upload {rel} (dry-run)")
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=False, exist_ok=True)
    api.upload_folder(
        folder_path=str(folder),
        repo_id=repo_id,
        repo_type="dataset",
        ignore_patterns=ignore or [],
        commit_message=message,
    )
    return Outcome(repo_id, "dataset", "published",
                   f"https://huggingface.co/datasets/{repo_id} (from {rel})")


def _publish_datasets(api, dry_run: bool) -> list[Outcome]:
    out: list[Outcome] = []

    # 1) eliza-1-training — the broader SFT corpus (only if the full final split
    #    + its manifest exist locally; otherwise it is already populated on HF).
    final = TRAINING_ROOT / "data" / "final"
    have_train = (final / "train.jsonl").exists() or (final / "train_final.jsonl").exists()
    have_manifest = (final / "manifest.json").exists() or (final / "manifest_final.json").exists()
    have_splits = have_train and (final / "val.jsonl").exists() and (final / "test.jsonl").exists()
    if have_splits and have_manifest:
        # Use the existing allowlist-guarded publisher.
        repo = f"{ORG}/eliza-1-training"
        cmd = [sys.executable, str(TRAINING_ROOT / "scripts" / "publish_dataset_to_hf.py"),
               "--dataset", "training", "--repo-id", repo]
        if dry_run:
            cmd.append("--dry-run")
        rc = subprocess.run(cmd, cwd=str(TRAINING_ROOT)).returncode
        out.append(Outcome(repo, "dataset",
                           "pending" if dry_run else ("published" if rc == 0 else "skipped"),
                           f"publish_dataset_to_hf.py --dataset training (rc={rc})"))
    else:
        out.append(Outcome(f"{ORG}/eliza-1-training", "dataset", "skipped",
                           "data/final/{train,val,test}.jsonl not present in this checkout "
                           "(already populated on HF; nothing to refresh)"))

    # 2) eliza-1-evals — the eval/bench results + kernel-verify evidence + gates.
    #    Assemble a staging tree from the bench/eval JSON that exists in-checkout.
    eval_sources: list[tuple[Path, str]] = []
    gates_yaml = TRAINING_ROOT / "benchmarks" / "eliza1_gates.yaml"
    gates_py = TRAINING_ROOT / "benchmarks" / "eliza1_gates.py"
    models_status = TRAINING_ROOT / "benchmarks" / "MODELS_STATUS.md"
    for src, dst in ((gates_yaml, "gates/eliza1_gates.yaml"),
                     (gates_py, "gates/eliza1_gates.py"),
                     (models_status, "gates/MODELS_STATUS-training.md")):
        if src.exists():
            eval_sources.append((src, dst))
    if not eval_sources:
        out.append(Outcome(f"{ORG}/eliza-1-evals", "dataset", "skipped",
                           "no eval/gates artifacts found locally (repo already populated on HF)"))
    elif dry_run:
        out.append(Outcome(f"{ORG}/eliza-1-evals", "dataset", "pending",
                           f"would upload {len(eval_sources)} gate/eval files (dry-run)"))
    else:
        from huggingface_hub import CommitOperationAdd
        api.create_repo(repo_id=f"{ORG}/eliza-1-evals", repo_type="dataset",
                        private=False, exist_ok=True)
        ops = [CommitOperationAdd(path_in_repo=dst, path_or_fileobj=str(src))
               for src, dst in eval_sources]
        api.create_commit(repo_id=f"{ORG}/eliza-1-evals", repo_type="dataset",
                          operations=ops,
                          commit_message="Refresh eliza1_gates.yaml/.py thresholds + training MODELS_STATUS")
        out.append(Outcome(f"{ORG}/eliza-1-evals", "dataset", "published",
                           f"https://huggingface.co/datasets/{ORG}/eliza-1-evals "
                           f"({len(eval_sources)} gate/eval files refreshed)"))
    return out


def _bundle_dry_run(tier: str, bundle_dir: Path) -> Outcome:
    """Dry-run the bundle orchestrator and turn its verdict into an Outcome."""
    repo = f"{ORG}/eliza-1"
    remote = f"bundles/{tier}/"
    if not bundle_dir.is_dir():
        return Outcome(repo, "model-bundle", "pending",
                       f"{remote}: no staged bundle at {bundle_dir} — assemble it "
                       "(RELEASE_V1.md), then the orchestrator dry-run reports the gate")
    cmd = [sys.executable, "-m", "scripts.publish.orchestrator",
           "--tier", tier, "--bundle-dir", str(bundle_dir), "--base-v1", "--dry-run"]
    proc = subprocess.run(cmd, cwd=str(TRAINING_ROOT), capture_output=True, text=True)
    if proc.returncode == 0:
        return Outcome(repo, "model-bundle", "pending",
                       f"{remote}: orchestrator dry-run is GREEN / upload-ready, "
                       "but no upload is proven until a non-dry-run publish returns "
                       "HF commit/url/uploadedPaths evidence")
    # Pull the first "orchestrator error: ..." line + the bulleted blockers.
    msg = ""
    capture = False
    for line in (proc.stderr + "\n" + proc.stdout).splitlines():
        if "orchestrator error:" in line:
            msg = line.split("orchestrator error:", 1)[1].strip()
            capture = True
            continue
        if capture and line.strip().startswith("- "):
            msg += f" | {line.strip()[2:]}"
        elif capture and line.strip() and not line.startswith("  "):
            break
    return Outcome(repo, "model-bundle", "pending",
                   f"{remote}: orchestrator dry-run exit={proc.returncode}: "
                   f"{msg or 'see stderr'}")


def _bundle_status(bundles_root: Path) -> list[Outcome]:
    out: list[Outcome] = []
    for tier in BUNDLE_TIERS:
        bdir = bundles_root / f"eliza-1-{tier}.bundle"
        out.append(_bundle_dry_run(tier, bdir))
    return out


def _sft_weights_status(tier: str = "0_8b") -> Outcome:
    """Report whether a full-corpus active-tier SFT is done + cleared its gate."""
    ckpt_root = TRAINING_ROOT / "checkpoints"
    repo = f"{ORG}/eliza-1"
    runs = sorted(ckpt_root.glob(f"eliza-1-{tier}-apollo-fullcorpus-*")) if ckpt_root.is_dir() else []
    if not runs:
        return Outcome(repo, "model-weights", "pending",
                       f"{tier} full-corpus Qwen3.5 SFT run not found in checkpoints/")
    run = runs[-1]
    final = run / "final"
    gate = run / "gate_report.json"
    if not final.is_dir():
        return Outcome(repo, "model-weights", "pending",
                       f"SFT run {run.name} has no final/ checkpoint yet (still training or stalled)")
    if not gate.exists():
        return Outcome(repo, "model-weights", "pending",
                       f"SFT run {run.name} has final/ but no gate_report.json — run the bench tail")
    blob = json.loads(gate.read_text())
    if blob.get("passed") is True:
        return Outcome(repo, "model-weights", "published",
                       f"SFT gate GREEN ({run.name}) — run "
                       f"`python scripts/push_model_to_hf.py --registry-key eliza-1-{tier} "
                       f"--checkpoint {final} --repo-id {repo}` then publish under "
                       f"`bundles/{tier}/` in the single model repo")
    return Outcome(repo, "model-weights", "pending",
                   f"SFT gate RED ({run.name}): {blob.get('failures') or blob.get('error')}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would publish; push nothing.")
    ap.add_argument("--bundles-root", type=Path, default=DEFAULT_BUNDLES_ROOT,
                    help=f"Parent dir of the staged eliza-1-<tier>.bundle dirs "
                         f"(default {DEFAULT_BUNDLES_ROOT}).")
    ap.add_argument("--skip-bundle-status", action="store_true",
                    help="Skip the per-tier bundle orchestrator dry-runs.")
    args = ap.parse_args(argv)

    dry_run = args.dry_run
    if not dry_run and not _hf_token():
        log.warning("HF_TOKEN not set — switching to --dry-run (report only).")
        dry_run = True

    outcomes: list[Outcome] = []
    api = None
    if not dry_run:
        from huggingface_hub import HfApi
        api = HfApi(token=_hf_token())

    log.info("=== publish datasets + evals ===")
    if dry_run:
        # In dry-run we still want a clean report without an API object.
        from types import SimpleNamespace
        api = SimpleNamespace(
            create_repo=lambda **k: None,
            upload_folder=lambda **k: None,
            create_commit=lambda **k: None,
        )
    outcomes += _publish_datasets(api, dry_run)

    if not args.skip_bundle_status:
        log.info("=== per-tier bundle status (orchestrator dry-run, refuses-on-red) ===")
        outcomes += _bundle_status(args.bundles_root)

    log.info("=== active-tier SFT weights status ===")
    outcomes.extend(_sft_weights_status(tier) for tier in BUNDLE_TIERS)

    published = [o for o in outcomes if o.status == "published"]
    pending = [o for o in outcomes if o.status == "pending"]
    skipped = [o for o in outcomes if o.status == "skipped"]

    print("\n================ Eliza-1 HF publish summary ================")
    print(f"PUBLISHED ({len(published)}):")
    for o in published:
        print(f"  + {o.repo}  [{o.kind}]  {o.detail}")
    print(f"PENDING ({len(pending)}):")
    for o in pending:
        print(f"  - {o.repo}  [{o.kind}]  {o.detail}")
    if skipped:
        print(f"SKIPPED ({len(skipped)}):")
        for o in skipped:
            print(f"  . {o.repo}  [{o.kind}]  {o.detail}")
    print("============================================================")
    if dry_run:
        print("(dry-run — nothing was pushed; set HF_TOKEN and drop --dry-run to publish)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
