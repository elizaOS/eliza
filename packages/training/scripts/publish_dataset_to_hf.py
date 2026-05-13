"""Publish eliza-1 training datasets to HuggingFace Hub.

Four named bundles, each maps to its own HF dataset repo:

  - ``training``      -> the active SFT split (train_final.jsonl + val + test)
  - ``scambench``     -> adversarial scam benchmark
  - ``synthesized``   -> small Claude-teacher synthesis sets
  - ``abliteration``  -> harmless-prompt set used by abliterate.py
                         (points at upstream `mlabonne/harmless_alpaca` —
                         we do not republish someone else's data)

Usage::

    # Dry-run (no auth required, prints planned uploads + total bytes).
    uv run python scripts/publish_dataset_to_hf.py \\
        --dataset training --repo-id elizaos/eliza-1-training --dry-run

    # Real upload (creates the repo private if missing).
    HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \\
        --dataset training --repo-id elizaos/eliza-1-training

The publisher refuses to upload any file outside the explicit per-dataset
allowlist below — this is the safety rail that keeps the historical WIP
files (``train.jsonl``, ``train_v8.jsonl``, ``train_rewritten.review.jsonl``)
out of the public dataset.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("publish_dataset")


# ---------------------------------------------------------------------------
# Allowlists per dataset bundle. Anything outside these paths is not pushed.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DatasetSpec:
    """Resolved upload plan for one dataset bundle."""

    name: str
    files: tuple[Path, ...]              # absolute paths under training/
    path_in_repo: dict[Path, str]        # abs path -> path inside HF repo
    card: str                            # README.md body for the HF repo
    is_pointer_only: bool = False        # if True, do not upload data — README only


def _spec_training_from_dir(source_dir: Path | None = None) -> DatasetSpec:
    """Build the active SFT upload spec.

    By default this uses ``data/final``. Passing ``source_dir`` also supports a
    staged candidate directory with ``data/train.jsonl``,
    ``data/validation.jsonl``, and ``data/test.jsonl``; the validation split is
    published as the public root ``val.jsonl`` expected by Vast/bootstrap jobs.
    """
    source_dir = source_dir.resolve() if source_dir else DATA / "final"
    candidate_data = source_dir / "data"
    final = candidate_data if (candidate_data / "train.jsonl").exists() else source_dir

    # The canonical SFT train file is train.jsonl. Older runs of the pipeline
    # produced train_final.jsonl as a temporary name; if it still exists locally
    # we honor it for backwards compat, but train.jsonl is the source of truth.
    train_src = final / "train_final.jsonl"
    if not train_src.exists():
        train_src = final / "train.jsonl"
    val_src = final / "val.jsonl"
    if not val_src.exists():
        val_src = final / "validation.jsonl"
    manifest_src = source_dir / "manifest.json"
    if not manifest_src.exists():
        manifest_src = final / "manifest_final.json"
    if not manifest_src.exists():
        manifest_src = final / "manifest.json"
    files = (
        train_src,
        val_src,
        final / "test.jsonl",
        manifest_src,
    )
    path_in_repo = {
        files[0]: "train.jsonl",
        files[1]: "val.jsonl",
        files[2]: "test.jsonl",
        files[3]: "manifest.json",
    }
    return DatasetSpec(
        name="training",
        files=files,
        path_in_repo=path_in_repo,
        card=_card_training(),
    )


def _spec_training() -> DatasetSpec:
    return _spec_training_from_dir()


def _spec_scambench() -> DatasetSpec:
    files: list[Path] = []
    path_in_repo: dict[Path, str] = {}

    normalized = DATA / "normalized" / "scambench.jsonl"
    if normalized.exists():
        files.append(normalized)
        path_in_repo[normalized] = "normalized/scambench.jsonl"

    synth_dir = DATA / "synthesized" / "scambench"
    if synth_dir.exists():
        for p in sorted(synth_dir.glob("*.jsonl")):
            files.append(p)
            path_in_repo[p] = f"synthesized/{p.name}"
        manifest = synth_dir / "manifest.json"
        if manifest.exists():
            files.append(manifest)
            path_in_repo[manifest] = "synthesized/manifest.json"

    return DatasetSpec(
        name="scambench",
        files=tuple(files),
        path_in_repo=path_in_repo,
        card=_card_scambench(),
    )


def _spec_synthesized() -> DatasetSpec:
    """Small Claude-teacher synthesis sets — actions, prompts, examples."""
    base = DATA / "synthesized"
    files: list[Path] = []
    path_in_repo: dict[Path, str] = {}
    for sub in ("action_examples", "action_pairs", "core_prompts"):
        d = base / sub
        if not d.exists():
            continue
        for p in sorted(d.glob("*.jsonl")):
            files.append(p)
            path_in_repo[p] = f"{sub}/{p.name}"
    return DatasetSpec(
        name="synthesized",
        files=tuple(files),
        path_in_repo=path_in_repo,
        card=_card_synthesized(),
    )


def _spec_abliteration() -> DatasetSpec:
    """Pointer-only spec — upstream `mlabonne/harmless_alpaca` is canonical."""
    return DatasetSpec(
        name="abliteration",
        files=(),
        path_in_repo={},
        card=_card_abliteration(),
        is_pointer_only=True,
    )


def _spec_combined() -> DatasetSpec:
    """All eliza-1 SFT data in one repo: training + scambench + synthesized.

    Layout in the HF repo:
      train.jsonl, val.jsonl, test.jsonl, manifest.json   (active SFT split)
      scambench/normalized.jsonl                          (adversarial scam corpus)
      scambench/synthesized.jsonl                         (Claude-teacher scam scenarios)
      scambench/manifest.json
      synthesized/action_examples/*.jsonl                 (action-trajectory examples)
      synthesized/action_pairs/*.jsonl                    (paired action examples)
      synthesized/core_prompts/*.jsonl                    (small core prompt sets)
    """
    files: list[Path] = []
    path_in_repo: dict[Path, str] = {}

    # Active SFT split (mirror _spec_training).
    final = DATA / "final"
    train_src = final / "train_final.jsonl"
    if not train_src.exists():
        train_src = final / "train.jsonl"
    for src, dst in (
        (train_src, "train.jsonl"),
        (final / "val.jsonl", "val.jsonl"),
        (final / "test.jsonl", "test.jsonl"),
        (final / "manifest_final.json", "manifest.json"),
    ):
        files.append(src)
        path_in_repo[src] = dst

    # Scambench.
    sb_norm = DATA / "normalized" / "scambench.jsonl"
    if sb_norm.exists():
        files.append(sb_norm)
        path_in_repo[sb_norm] = "scambench/normalized.jsonl"
    sb_synth_dir = DATA / "synthesized" / "scambench"
    if sb_synth_dir.exists():
        for p in sorted(sb_synth_dir.glob("*.jsonl")):
            files.append(p)
            path_in_repo[p] = f"scambench/{p.name}"
        sb_manifest = sb_synth_dir / "manifest.json"
        if sb_manifest.exists():
            files.append(sb_manifest)
            path_in_repo[sb_manifest] = "scambench/manifest.json"

    # Synthesized small sets. evaluators/ + phase3/ are the Phase-4 and
    # Phase-3 fillers added in 2026-05 to close the runtime-phase coverage
    # gap (see docs/dataset/COVERAGE_AUDIT.md, EVALUATOR_SYNTHESIS.md).
    synth_base = DATA / "synthesized"
    for sub in ("action_examples", "action_pairs", "core_prompts",
                "evaluators", "phase3"):
        d = synth_base / sub
        if not d.exists():
            continue
        for p in sorted(d.glob("*.jsonl")):
            files.append(p)
            path_in_repo[p] = f"synthesized/{sub}/{p.name}"

    return DatasetSpec(
        name="combined",
        files=tuple(files),
        path_in_repo=path_in_repo,
        card=_card_combined(),
    )


SPEC_BUILDERS = {
    "training": _spec_training,
    "scambench": _spec_scambench,
    "synthesized": _spec_synthesized,
    "abliteration": _spec_abliteration,
    "combined": _spec_combined,
}


# ---------------------------------------------------------------------------
# Dataset cards
# ---------------------------------------------------------------------------


def _card_training() -> str:
    return (
        "---\n"
        "license: cc-by-4.0\n"
        "task_categories:\n"
        "  - text-generation\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - eliza\n"
        "  - elizaos\n"
        "  - sft\n"
        "  - tool-use\n"
        "  - reasoning\n"
        "  - qwen\n"
        "size_categories:\n"
        "  - 1M<n<10M\n"
        "---\n"
        "\n"
        "# eliza-1 training corpus\n"
        "\n"
        "Active SFT corpus for the elizaOS **eliza-1** Qwen-based model series.\n"
        "All app-facing runtime bundles live in the single model repo\n"
        "[`elizaos/eliza-1`](https://huggingface.co/elizaos/eliza-1) under\n"
        "`bundles/<tier>/` paths for the active `eliza-1-0_8b`,\n"
        "`eliza-1-2b`, and `eliza-1-4b` tiers.\n"
        "\n"
        "## Files\n"
        "\n"
        "| Path           | Role                          |\n"
        "|----------------|-------------------------------|\n"
        "| `train.jsonl`  | training split                |\n"
        "| `val.jsonl`    | validation split              |\n"
        "| `test.jsonl`   | held-out test split           |\n"
        "| `manifest.json`| per-source counts             |\n"
        "\n"
        "## Schema\n"
        "\n"
        "The active trajectory path uses `eliza_native_v1`: one row per model\n"
        "boundary, with the exact request sent to the model and the expected\n"
        "text/tool-call response.\n"
        "\n"
        "```json\n"
        "{\n"
        '  "format": "eliza_native_v1",\n'
        '  "request": {"messages": [{"role": "user", "content": "..."}], "tools": []},\n'
        '  "response": {"text": "...", "toolCalls": []},\n'
        '  "metadata": {"task_type": "...", "source_dataset": "..."}\n'
        "}\n"
        "```\n"
        "\n"
        "Legacy `messages` and flat ElizaRecord rows are accepted by the local\n"
        "formatter, but a published root split must be internally consistent so\n"
        "the Hugging Face Dataset Viewer can load all train/validation/test splits.\n"
        "\n"
        "## Source mix\n"
        "\n"
        "Aggregated from ~90 upstream datasets covering tool-use, agent\n"
        "trajectories, multi-turn reasoning, n8n workflows, MCP traces, and\n"
        "synthesized eliza-specific scenarios. Per-source counts are in\n"
        "`manifest.json`. The pipeline that built this corpus is published at\n"
        "[`elizaos/eliza-1-pipeline`](https://huggingface.co/elizaos/eliza-1-pipeline).\n"
        "\n"
        "## Loading\n"
        "\n"
        "```python\n"
        "from datasets import load_dataset\n"
        'ds = load_dataset("elizaos/eliza-1-training", data_files={\n'
        '    "train": "train.jsonl",\n'
        '    "validation": "val.jsonl",\n'
        '    "test": "test.jsonl",\n'
        "})\n"
        "```\n"
        "\n"
        "## Intended use\n"
        "\n"
        "Supervised fine-tuning of small-to-medium Qwen3.5 causal LMs (0.8B-4B)\n"
        "for agent / tool-use workloads on mobile, local desktop, and\n"
        "workstation hardware.\n"
        "\n"
        "## License + provenance\n"
        "\n"
        "Released CC-BY-4.0. The corpus contains assistant turns synthesized\n"
        "with Claude (Anthropic) as the teacher model on a subset of the mix;\n"
        "downstream use must comply with Anthropic's usage policies for\n"
        "teacher-derived training data, and per-source upstream licenses for\n"
        "non-synthesized rows. See `manifest.json` for upstream source slugs\n"
        "and consult their original licenses.\n"
    )


def _card_scambench() -> str:
    return (
        "---\n"
        "license: cc-by-sa-4.0\n"
        "task_categories:\n"
        "  - text-classification\n"
        "  - text-generation\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - safety\n"
        "  - adversarial\n"
        "  - scam\n"
        "  - eliza\n"
        "---\n"
        "\n"
        "# eliza-1 scambench\n"
        "\n"
        "Adversarial scam dataset used to train and evaluate the\n"
        "**eliza-1** safety behaviors: scam recognition, request\n"
        "verification, refusal, and audit-trail responses.\n"
        "\n"
        "## Files\n"
        "\n"
        "- `normalized/scambench.jsonl` — normalized (eliza schema) corpus.\n"
        "- `synthesized/scambench.jsonl` — Claude-teacher synthesized rows\n"
        "  (legitimate-traffic balanced + decision-class labeled).\n"
        "- `synthesized/manifest.json` — counts by `scam_category`,\n"
        "  `scenario_category`, `decision_class`.\n"
        "\n"
        "## Decision classes\n"
        "\n"
        "`request_verification`, `refuse`, `engage_legitimate`, `audit`,\n"
        "`escalate`, `allow_safe_action`, `block_actor`, `accept`,\n"
        "`share_safe_info`, `warn_actor`, `deny_privileged_action`,\n"
        "`execute_transaction`, `ignore`.\n"
        "\n"
        "## License\n"
        "\n"
        "CC-BY-SA-4.0 (matches upstream scambench source data).\n"
    )


def _card_synthesized() -> str:
    return (
        "---\n"
        "license: cc-by-4.0\n"
        "task_categories:\n"
        "  - text-generation\n"
        "  - conversational\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - eliza\n"
        "  - synthesized\n"
        "  - claude-teacher\n"
        "---\n"
        "\n"
        "# eliza-1 synthesized examples\n"
        "\n"
        "Small synthesized JSONL sets used to extend the eliza-1 SFT corpus\n"
        "with action-routing, action-pair, and core-prompt examples.\n"
        "\n"
        "## Layout\n"
        "\n"
        "- `action_examples/*.jsonl` — per-domain action examples\n"
        "  (agent_orch, commerce, messaging, music, system, web3).\n"
        "- `action_pairs/*.jsonl` — paired (prompt, action) traces\n"
        "  (actions-catalog, core-prompts, inline-actions, lifeops,\n"
        "  plugin-prompts).\n"
        "- `core_prompts/*.jsonl` — eliza core-prompt completions\n"
        "  (add_contact, choose_option, extract_secrets, etc.).\n"
        "\n"
        "## Provenance\n"
        "\n"
        "Generated with Claude (Anthropic) as the teacher model. Downstream\n"
        "use must comply with Anthropic's usage policies for\n"
        "teacher-derived training data.\n"
        "\n"
        "## License\n"
        "\n"
        "CC-BY-4.0.\n"
    )


def _card_abliteration() -> str:
    return (
        "---\n"
        "license: apache-2.0\n"
        "tags:\n"
        "  - pointer\n"
        "  - abliteration\n"
        "  - eliza\n"
        "---\n"
        "\n"
        "# eliza-1 abliteration calibration set (pointer)\n"
        "\n"
        "**This repo intentionally does not host data.** The harmless-prompt\n"
        "calibration set used by\n"
        "[`scripts/training/abliterate.py`](https://huggingface.co/elizaos/eliza-1-pipeline/blob/main/scripts/training/abliterate.py)\n"
        "is the upstream\n"
        "[`mlabonne/harmless_alpaca`](https://huggingface.co/datasets/mlabonne/harmless_alpaca)\n"
        "dataset, paired with the harmful set\n"
        "[`mlabonne/harmful_behaviors`](https://huggingface.co/datasets/mlabonne/harmful_behaviors).\n"
        "\n"
        "Use those repos directly:\n"
        "\n"
        "```bash\n"
        "hf download mlabonne/harmless_alpaca --repo-type dataset\n"
        "hf download mlabonne/harmful_behaviors --repo-type dataset\n"
        "```\n"
        "\n"
        "We do not republish someone else's data.\n"
    )


def _card_combined() -> str:
    return (
        "---\n"
        "license: cc-by-4.0\n"
        "task_categories:\n"
        "  - text-generation\n"
        "language:\n"
        "  - en\n"
        "tags:\n"
        "  - eliza\n"
        "  - elizaos\n"
        "  - sft\n"
        "  - tool-use\n"
        "  - reasoning\n"
        "  - qwen\n"
        "  - safety\n"
        "  - adversarial\n"
        "size_categories:\n"
        "  - 1M<n<10M\n"
        "---\n"
        "\n"
        "# eliza-1 training corpus (consolidated)\n"
        "\n"
        "Single-repo home for everything used to train the elizaOS\n"
        "**eliza-1** Qwen-based model series. This bundles the active SFT split, the\n"
        "scambench adversarial set, and the small Claude-teacher synthesis\n"
        "sets that previously lived in separate repos.\n"
        "\n"
        "Companion repo: [`elizaos/eliza-1-pipeline`](https://huggingface.co/elizaos/eliza-1-pipeline)\n"
        "(scripts + Vast.ai automation that built this corpus).\n"
        "\n"
        "## Layout\n"
        "\n"
        "```\n"
        "train.jsonl                 # active SFT training split\n"
        "val.jsonl                   # validation split\n"
        "test.jsonl                  # held-out test split\n"
        "manifest.json               # per-source counts for the SFT splits\n"
        "\n"
        "scambench/\n"
        "  normalized.jsonl          # adversarial scam corpus (canonical, normalized)\n"
        "  scambench.jsonl           # Claude-teacher synthesized scam scenarios\n"
        "  manifest.json             # scambench source counts\n"
        "\n"
        "synthesized/\n"
        "  action_examples/*.jsonl   # action-trajectory examples per surface\n"
        "  action_pairs/*.jsonl      # paired action examples for routing\n"
        "  core_prompts/*.jsonl      # small core prompt / routing sets\n"
        "```\n"
        "\n"
        "## Schema\n"
        "\n"
        "The active SFT root splits use `eliza_native_v1`: one row per model\n"
        "boundary, with the exact request sent to the model and the expected\n"
        "text/tool-call response.\n"
        "\n"
        "```json\n"
        "{\n"
        '  "format": "eliza_native_v1",\n'
        '  "request": {"messages": [{"role": "user", "content": "..."}], "tools": []},\n'
        '  "response": {"text": "...", "toolCalls": []},\n'
        '  "metadata": {"task_type": "...", "source_dataset": "..."}\n'
        "}\n"
        "```\n"
        "\n"
        "The synthesized small sets follow the same shape but carry a\n"
        "`scenario` field describing the action / routing decision being\n"
        "demonstrated.\n"
        "\n"
        "## Loading\n"
        "\n"
        "```python\n"
        "from datasets import load_dataset\n"
        "\n"
        "# Active SFT splits\n"
        'sft = load_dataset("elizaos/eliza-1-training", data_files={\n'
        '    "train": "train.jsonl",\n'
        '    "validation": "val.jsonl",\n'
        '    "test": "test.jsonl",\n'
        "})\n"
        "\n"
        "# Scambench (adversarial)\n"
        'sb = load_dataset("elizaos/eliza-1-training", data_files={\n'
        '    "normalized": "scambench/normalized.jsonl",\n'
        '    "synthesized": "scambench/scambench.jsonl",\n'
        "})\n"
        "\n"
        "# Synthesized small sets\n"
        'syn = load_dataset("elizaos/eliza-1-training", data_files=\n'
        '    "synthesized/**/*.jsonl")\n'
        "```\n"
        "\n"
        "## Source mix\n"
        "\n"
        "Aggregated from ~90 upstream datasets covering tool-use, agent\n"
        "trajectories, multi-turn reasoning, n8n workflows, MCP traces, and\n"
        "synthesized eliza-specific scenarios. Per-source counts are in\n"
        "`manifest.json`.\n"
        "\n"
        "## Intended use\n"
        "\n"
        "Supervised fine-tuning of small-to-medium Qwen causal LMs (0.8B-27B)\n"
        "for agent / tool-use workloads on mobile, local desktop, and\n"
        "workstation hardware.\n"
        "\n"
        "## Abliteration calibration\n"
        "\n"
        "The harmless-prompt calibration set used by Heretic abliteration is\n"
        "**not** in this repo — it points at upstream\n"
        "[`mlabonne/harmless_alpaca`](https://huggingface.co/datasets/mlabonne/harmless_alpaca)\n"
        "and [`mlabonne/harmful_behaviors`](https://huggingface.co/datasets/mlabonne/harmful_behaviors).\n"
        "\n"
        "## License + provenance\n"
        "\n"
        "Released CC-BY-4.0 (scambench follows CC-BY-SA-4.0, see its directory).\n"
        "The corpus contains assistant turns synthesized with Claude\n"
        "(Anthropic) as the teacher model on a subset of the mix; downstream\n"
        "use must comply with Anthropic's usage policies for teacher-derived\n"
        "training data, and per-source upstream licenses for non-synthesized\n"
        "rows. See `manifest.json` for upstream source slugs and consult\n"
        "their original licenses.\n"
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _remote_sha256(api, repo_id: str, path_in_repo: str) -> str | None:
    """Return remote LFS SHA256 if the file exists on HF, else None."""
    try:
        info = api.repo_info(repo_id, repo_type="dataset", files_metadata=True)
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


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------


def _split_data_files(spec: DatasetSpec) -> dict[str, Path]:
    """Return train/validation/test JSONL files addressed as HF splits.

    The live HF Dataset Viewer builds all splits together. A publish that lets
    those split schemas drift can break the public dataset even when every file
    is individually valid JSONL, so real publish validates this exact mapping.
    """
    by_split: dict[str, Path] = {}
    for path in spec.files:
        target = spec.path_in_repo.get(path)
        if target == "train.jsonl":
            by_split["train"] = path
        elif target in {"val.jsonl", "validation.jsonl"}:
            by_split["validation"] = path
        elif target == "test.jsonl":
            by_split["test"] = path
    required = {"train", "validation", "test"}
    return by_split if required <= set(by_split) else {}


def validate_hf_loadable(spec: DatasetSpec) -> bool:
    data_files = _split_data_files(spec)
    if not data_files:
        return True
    for split, path in data_files.items():
        if not path.exists():
            log.error("missing %s split for HF load preflight: %s", split, path)
            return False
    try:
        from datasets import load_dataset
    except ImportError:
        log.error(
            "datasets is required for HF load preflight; install the train extra "
            "before publishing"
        )
        return False
    try:
        ds = load_dataset(
            "json",
            data_files={split: str(path) for split, path in data_files.items()},
        )
    except Exception as exc:
        log.error("HF load preflight failed: %s", exc)
        return False

    feature_fingerprints = {
        split: repr(dataset.features)
        for split, dataset in ds.items()
    }
    row_counts = {split: int(ds[split].num_rows) for split in ds}
    empty = {split: count for split, count in row_counts.items() if count <= 0}
    if empty:
        log.error("HF load preflight found empty split(s): %s", empty)
        return False
    if len(set(feature_fingerprints.values())) != 1:
        log.error("HF load preflight found split feature drift: %s", feature_fingerprints)
        return False
    log.info(
        "HF load preflight ok: %s",
        row_counts,
    )
    return True


def _print_dry_run(spec: DatasetSpec, repo_id: str, *, validate_hf_load: bool = False) -> int:
    rc = _print_dry_run_without_validation(spec, repo_id)
    if rc != 0 or not validate_hf_load:
        return rc
    return 0 if validate_hf_loadable(spec) else 2


def _print_dry_run_without_validation(spec: DatasetSpec, repo_id: str) -> int:
    log.info("dataset=%s repo_id=%s (dry-run)", spec.name, repo_id)
    if spec.is_pointer_only:
        log.info("pointer-only — would upload README only (no data files).")
        log.info("README preview:\n%s", spec.card)
        return 0
    if not spec.files:
        log.error("dataset=%s — no files matched the allowlist; nothing to upload.", spec.name)
        return 2
    total = 0
    for f in spec.files:
        if not f.exists():
            log.error("missing source file: %s", f)
            return 2
        size = f.stat().st_size
        total += size
        log.info(
            "  %-60s -> %s  (%.2f MB)",
            str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f),
            spec.path_in_repo[f],
            size / 1e6,
        )
    log.info("total payload: %.2f GB across %d files", total / 1e9, len(spec.files))
    log.info("README preview:\n%s", spec.card)
    return 0


def publish(spec: DatasetSpec, repo_id: str, public: bool) -> int:
    if not hf_token():
        log.error("HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing to push.")
        return 1
    if not validate_hf_loadable(spec):
        return 2

    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())

    try:
        api.repo_info(repo_id, repo_type="dataset")
        log.info("repo %s already exists", repo_id)
    except RepositoryNotFoundError:
        log.info("repo %s does not exist — creating (private=%s)", repo_id, not public)
        api.create_repo(
            repo_id=repo_id,
            repo_type="dataset",
            private=not public,
            exist_ok=False,
        )

    if spec.is_pointer_only:
        api.upload_file(
            path_or_fileobj=spec.card.encode("utf-8"),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type="dataset",
            commit_message=f"eliza-1-{spec.name}: refresh dataset card",
        )
        log.info("pointer-only dataset; README pushed, skipping data upload.")
        log.info("done. https://huggingface.co/datasets/%s", repo_id)
        return 0

    # Build remote sha index in one shot so we can skip unchanged LFS blobs.
    remote_shas: dict[str, str] = {}
    try:
        info = api.repo_info(repo_id, repo_type="dataset", files_metadata=True)
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

    from huggingface_hub import CommitOperationAdd

    operations: list[CommitOperationAdd] = [
        CommitOperationAdd(
            path_in_repo="README.md",
            path_or_fileobj=spec.card.encode("utf-8"),
        )
    ]
    skipped = 0
    for f in spec.files:
        if not f.exists():
            log.error("missing source file (refusing to continue): %s", f)
            return 2
        target = spec.path_in_repo[f]
        if target in remote_shas:
            local_sha = _sha256_file(f)
            if remote_shas[target] == local_sha:
                log.info("skip (sha matches remote): %s", target)
                skipped += 1
                continue
        size = f.stat().st_size
        log.info("queue %s (%.2f MB) -> %s", f.name, size / 1e6, target)
        operations.append(
            CommitOperationAdd(
                path_in_repo=target,
                path_or_fileobj=str(f),
            )
        )

    log.info(
        "committing %d operations in one commit (%d skipped as unchanged)",
        len(operations),
        skipped,
    )
    api.create_commit(
        repo_id=repo_id,
        repo_type="dataset",
        operations=operations,
        commit_message=f"eliza-1-{spec.name}: publish {len(operations)} files",
    )

    log.info("done. https://huggingface.co/datasets/%s", repo_id)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--dataset",
        required=True,
        choices=sorted(SPEC_BUILDERS.keys()),
        help="Which dataset bundle to publish.",
    )
    ap.add_argument(
        "--repo-id",
        required=True,
        help="Destination HF dataset repo id (e.g. elizaos/eliza-1-training).",
    )
    ap.add_argument(
        "--source-dir",
        type=Path,
        default=None,
        help=(
            "Override the source directory for --dataset training. Supports "
            "data/final-style roots and staged candidate directories whose "
            "validation split is data/validation.jsonl."
        ),
    )
    ap.add_argument(
        "--private",
        action="store_true",
        help="Create the repo as private (default: public).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned uploads + total bytes; do not authenticate or push.",
    )
    ap.add_argument(
        "--validate-hf-load",
        action="store_true",
        help="During --dry-run, also exercise datasets.load_dataset on train/val/test.",
    )
    args = ap.parse_args()

    if args.source_dir is not None and args.dataset != "training":
        ap.error("--source-dir is only supported with --dataset training")
    spec = (
        _spec_training_from_dir(args.source_dir)
        if args.source_dir is not None
        else SPEC_BUILDERS[args.dataset]()
    )
    if args.dry_run:
        return _print_dry_run(spec, args.repo_id, validate_hf_load=args.validate_hf_load)
    # Mirror push_to_hf.py default: public unless --private flips it.
    return publish(spec, args.repo_id, public=not args.private)


if __name__ == "__main__":
    sys.exit(main())
