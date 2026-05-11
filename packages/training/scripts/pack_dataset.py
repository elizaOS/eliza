"""Pack normalized + synthesized records into final {train,val,test}.jsonl.

Operates on the DEPRECATED flat `ElizaRecord` intermediate (see
`scripts/lib/eliza_record.py` and `scripts/normalize.py`), NOT the canonical
Eliza-1 corpus record. The canonical corpus record is `eliza_native_v1`; see
`packages/training/docs/dataset/CANONICAL_RECORD.md`. This path is kept only so
the existing bulk corpus keeps building — new corpus data should be authored as
`eliza_native_v1` rows.

Streaming + reservoir-sampled. We never load all records into RAM —
instead we walk each `data/normalized/<slug>.jsonl` once with two passes:

  Pass 1: count records per source and (lazily) collect line-offsets.
  Pass 2: reservoir-sample up to `--per-source-cap` records per source,
          weighted by the registry's `weight`. Hash on the fly to dedupe.
          Stream straight to per-split temp files honoring metadata.split.

The total in-memory footprint is bounded by:
  - the dedupe hash set (16 bytes per unique record)
  - one reservoir per source (≤ per-source-cap × 1 ref)
  - one pass through the file at a time

That keeps us well under a few GB even on the 1.5M agent-trove file.

Usage:
    uv run python scripts/pack_dataset.py
    uv run python scripts/pack_dataset.py --per-source-cap 75000
    uv run python scripts/pack_dataset.py --max-train 1000000
    uv run python scripts/pack_dataset.py --no-weights
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import random
import sys
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from lib.runtime_phases import classify_phase, PHASE_OOB  # noqa: E402

NORMALIZED = ROOT / "data" / "normalized"
SYNTHESIZED = ROOT / "data" / "synthesized"
FINAL = ROOT / "data" / "final"
ABLITERATION = ROOT / "data" / "abliteration"
REGISTRY_FILE = ROOT / "datasets.yaml"


# ─────────────────────────── tier table ────────────────────────────
# Source: docs/DATASET_REVIEW.md §"Per-source caps + sampling".
# These are module-level so unit tests can import them. Pass-2 reads
# them via the local `tier_for(slug)` helper, which strips any
# `synth:` prefix before lookup.
TIER_S = {  # gold standard — full × 5 replicate
    "nubilio-trajectories",
}
TIER_A = {  # eliza-aligned bench, take full corpus
    "scambench", "scam-defense-corpus",
}
TIER_B = {  # tool-call agent traces, structurally salvageable
    "tool-reasoning-toucan", "agent-trove", "nemotron-terminal-corpus",
    "swebench-verified-opus-47", "mcp-agent-training-data",
    "tool-reasoning-coding-nemotron",
}
TIER_C = {  # synthetic ChatML wrapping (single-turn tool calls)
    "glaive-fc-v2", "bitagent-tool-calling", "dolci-instruct-tool-use",
    "glaive-fc-v2-reasoning", "nemotron-rl-tool-use",
    "sharegpt-tool-calls", "toolhop",
    "functions-53k", "deepfabric-github-mcp",
    "playwright-mcp-toolcalling", "mcp-flow-comprehensive",
    "ha-mcp-dataset", "limbic-eval-tool-use-mcp",
    "mcp-memory-auto-trigger", "phi3-mcp",
    "hf-coding-tools-traces",
    "nemotron-coding-reasoning-rlmt-tool-use",
    "nemotron-post-training-tool-use",
}
TIER_D = {  # pure reasoning/coding, over-represented (also OOB by phase)
    "kimi-k25-reasoning-1m", "glm-51-reasoning-1m",
    "glm-47-multiturn-cot",
    "opus-47-thinking-25k-ansulev",
    "opus-4647-reasoning-8k7",
    "opus-46-10kx-bas95",
    "opus-47-max-sft-labs",
    "opus-47-reasoning-cot-ansulev",
    "deepseek-v4-distill-8000x", "qwen35-reasoning-700x",
}
TIER_E_HERMES_COMBINED = {  # 100k total across all hermes-family
    "hermes-3", "aureth-corpus-hermes", "hermes-omniforge-qwen36",
    "hermes-agent-reasoning-traces", "hermes-agent-traces-filtered",
    "hermes-reasoning-tool-use", "hermes-fc-thinking-v1",
    "hermes-fc-v1", "nemotron-nano-hermes-traces",
    "talos-kimi-hermes", "carnice-glm5-hermes",
    "qwen36-trajectory",
}
TIER_F_N8N = {  # n8n_workflow_generation — combined cap
    "n8n-mega-workflows", "n8n-master-corpus",
    "n8n-grpo-2k-aks729", "n8n-grpo-4k-aks729",
    "n8n-toolkit-davidrpatton",
    "n8n-workflow-template-rubenz",
    "n8n-workflows-batuhanilgarr",
    "n8n-workflows-sft-eclaude",
    "n8n-workflows-templates-0xarchit",
    "n8n-workflows-thinking-stmasson",
    "n8n-workflows-v2-4k-arkelai",
    "n8n-workflows-yagnik",
    "n8n-workflow-dataset-ruh-ai",
    "n8n-workflow-di12", "n8n-workflow-fmd053131",
    "n8n-workflow-mzw2004", "n8n-workflow-npv2k1",
    "n8n-workflow-ruh-ai", "n8n-workflow-tahakk",
    "n8n-workflow-yonibabi", "n8n-testset-ruh-ai",
    "n8nbuilder-perspicacious", "n8nbuilder-velixar",
    "n8nbuilder-webman",
}
TIER_CAPS: dict[str, tuple[int, int]] = {
    # tier → (cap, replicate_factor). cap is records-per-source for
    # per-source tiers, or the combined budget for E/F.
    "S": (5_000, 5),     # full × 5 replicate
    "A": (50_000, 1),    # full
    "B": (50_000, 1),
    "C": (30_000, 1),
    "D": (15_000, 1),
    "E": (100_000, 1),   # combined budget across hermes family
    "F": (50_000, 1),    # combined budget across n8n family
}


def tier_for(slug: str) -> str:
    """Return the tier letter ('S'..'F') for a normalized or `synth:` slug.

    Un-tiered sources default to 'B' (50k cap), which is the conservative
    behavior for synthetic corpora not yet promoted into the explicit
    tables above (mostly synth:lifeops-* and synth:ea-*).
    """
    base = slug.split(":", 1)[1] if slug.startswith("synth:") else slug
    if base in TIER_S:
        return "S"
    if base in TIER_A:
        return "A"
    if base in TIER_B:
        return "B"
    if base in TIER_C:
        return "C"
    if base in TIER_D:
        return "D"
    if base in TIER_E_HERMES_COMBINED:
        return "E"
    if base in TIER_F_N8N:
        return "F"
    return "B"


def compute_targets(
    counts: dict[str, int],
    *,
    per_source_cap: int = 100_000,
    no_weights: bool = False,
) -> dict[str, int]:
    """Compute the per-source sampling target honoring tier caps.

    Behavior matches the inline pass-2 logic in `main()`:

    - Tier S: target = min(cap, n) × replicate_factor.
    - Tier E / F: combined cap split proportionally to record counts.
    - Tier A/B/C/D: target = min(cap, n).
    - When `no_weights` is True, the global `per_source_cap` overrides.
    - When `per_source_cap` is set below the tier-derived target, it
      caps the result.
    """
    e_total = sum(n for s, n in counts.items() if tier_for(s) == "E")
    f_total = sum(n for s, n in counts.items() if tier_for(s) == "F")
    e_budget = TIER_CAPS["E"][0]
    f_budget = TIER_CAPS["F"][0]
    targets: dict[str, int] = {}
    for slug, n in counts.items():
        tier = tier_for(slug)
        if tier == "E":
            t = int(e_budget * n / max(1, e_total))
        elif tier == "F":
            t = int(f_budget * n / max(1, f_total))
        elif tier == "S":
            cap, rep = TIER_CAPS[tier]
            t = min(cap, n) * rep
        else:
            cap, _ = TIER_CAPS[tier]
            t = min(cap, n)
        if no_weights:
            t = min(per_source_cap, n)
        elif per_source_cap and per_source_cap < t:
            t = per_source_cap
        targets[slug] = max(0, t)
    return targets


# Phase-distribution acceptance bands (post-pack).
# Source: docs/dataset/COVERAGE_AUDIT.md §"Per-phase coverage assessment".
# When --phase-distribution-target=balanced and any phase falls more
# than 5% outside its band, pack_dataset.py emits a WARNING (not fatal:
# Phase 3/4 may be empty until synthesizers run).
PHASE_BANDS_BALANCED: dict[str, tuple[float, float]] = {
    "1": (0.20, 0.30),
    "2": (0.45, 0.55),
    "3": (0.10, 0.20),
    "4": (0.07, 0.13),
}
PHASE_BANDS_FLAT: dict[str, tuple[float, float]] = {
    # No-op gate: every phase passes any non-negative fraction.
    "1": (0.0, 1.0),
    "2": (0.0, 1.0),
    "3": (0.0, 1.0),
    "4": (0.0, 1.0),
}
PHASE_BAND_TOLERANCE = 0.05

# Records with these task_types are calibration corpora for the
# orthogonal-projection abliteration in scripts/quantization/abliteration_apply.py.
# They MUST NOT enter train/val/test; pack_dataset.py routes them to
# data/abliteration/{harmful,harmless}.jsonl instead. Their source entries
# in datasets.yaml carry weight=0.0 as a redundant guard.
ABLITERATION_TASK_TYPES = {
    "abliteration_harmful": "harmful.jsonl",
    "abliteration_harmless": "harmless.jsonl",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("pack")


def record_hash(rec: dict) -> bytes:
    """Return a 16-byte hash so the dedupe set stays compact."""
    h = hashlib.blake2b(digest_size=16)
    md = rec.get("metadata") or {}
    h.update((md.get("system_prompt") or "").encode("utf-8", "replace"))
    cm = rec.get("currentMessage") or {}
    h.update((cm.get("content") or "").encode("utf-8", "replace"))
    h.update((rec.get("expectedResponse") or "").encode("utf-8", "replace"))
    return h.digest()


def group_key(rec: dict) -> bytes:
    """Return a 16-byte hash of (system_prompt, currentMessage.content).

    Records sharing the same group_key represent different supervised
    targets for the same input prefix (e.g. LIGHT/multilight emits
    1 RESPOND + 2 IGNORE + 1 reply per turn). They MUST land in the
    same split to avoid train/val/test contamination.
    """
    h = hashlib.blake2b(digest_size=16)
    md = rec.get("metadata") or {}
    h.update((md.get("system_prompt") or "").encode("utf-8", "replace"))
    h.update(b"\x00")
    cm = rec.get("currentMessage") or {}
    h.update((cm.get("content") or "").encode("utf-8", "replace"))
    return h.digest()


def stream_jsonl(path: Path):
    """Yield (line, parsed_dict). Skips bad lines silently."""
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                yield line, json.loads(line)
            except json.JSONDecodeError:
                continue


def count_records(path: Path) -> int:
    n = 0
    with path.open("rb") as f:
        for _ in f:
            n += 1
    return n


def detect_explicit_splits(path: Path, *, sample: int = 4000) -> bool:
    """Return True if any record in the first `sample` lines has a non-train
    metadata.split value. We use this to decide whether to respect the source's
    `metadata.split == "train"` (when val/test markers exist) or to dice-roll
    every record from that source so val/test get a representative slice."""
    seen = 0
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            seen += 1
            if seen > sample:
                return False
            try:
                md = (json.loads(line).get("metadata") or {})
            except json.JSONDecodeError:
                continue
            sp = (md.get("split") or "").lower()
            if sp in ("test", "validation", "val", "dev"):
                return True
    return False


def reservoir_sample_indices(n_total: int, k: int, rng: random.Random) -> set[int]:
    """Return a set of k indices uniformly sampled from [0, n_total)."""
    if k >= n_total:
        return set(range(n_total))
    # Algorithm L
    indices = list(range(k))
    i = k
    w = pow(rng.random(), 1.0 / k) if k > 0 else 0.0
    while i < n_total:
        i += int(__import__("math").log(rng.random()) / __import__("math").log(1 - w)) + 1
        if i < n_total:
            indices[rng.randrange(k)] = i
            w *= pow(rng.random(), 1.0 / k)
    return set(indices)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0xE71A05)
    ap.add_argument("--no-weights", action="store_true",
                    help="ignore per-source weights from datasets.yaml")
    ap.add_argument("--per-source-cap", type=int, default=100_000,
                    help="hard upper bound on records sampled per source")
    ap.add_argument("--sample-per-source", type=int, default=0,
                    help="when >0, override per-source-cap and tier caps so "
                         "each source contributes at most ~N records. Used by "
                         "run_pipeline.py --from-scratch for a tiny sampled mix.")
    ap.add_argument("--smoke", action="store_true",
                    help="relax acceptance gates for a tiny sampled mix: "
                         "out-of-band records pass through (oob-policy=allow) "
                         "and the phase-distribution gate is disabled "
                         "(phase-distribution-target=flat). A clear warning is "
                         "logged. Do NOT use for production packs.")
    ap.add_argument("--max-train", type=int, default=0,
                    help="cap final train size after split (0 = no cap)")
    ap.add_argument("--val-frac", type=float, default=0.04)
    ap.add_argument("--test-frac", type=float, default=0.01)
    ap.add_argument(
        "--oob-policy",
        choices=("drop", "route", "fail", "allow"),
        default="route",
        help=(
            "How to handle records whose task_type does not map to a runtime "
            "phase (see docs/dataset/COVERAGE_AUDIT.md). drop=silently exclude, "
            "route=write to data/final/out_of_band.jsonl and exclude, fail=hard "
            "error if any encountered, allow=pass through (legacy)."
        ),
    )
    ap.add_argument(
        "--phase-distribution-target",
        choices=("balanced", "flat", "legacy"),
        default="balanced",
        help=(
            "Post-pack phase distribution gate. balanced=warn if any phase "
            "drifts more than 5%% from the target bands in "
            "docs/dataset/COVERAGE_AUDIT.md (P1=20-30%%, P2=45-55%%, "
            "P3=10-20%%, P4=7-13%%). flat=no gate. legacy=no gate; "
            "manifest still records distribution."
        ),
    )
    args = ap.parse_args()

    if args.smoke:
        log.warning(
            "SMOKE MODE: skipping out-of-band rejection (oob-policy→allow) and "
            "the phase-distribution acceptance gate (phase-distribution-target→"
            "flat). The resulting pack is for pipeline validation only — NOT a "
            "production training corpus."
        )
        args.oob_policy = "allow"
        args.phase_distribution_target = "flat"
    if args.sample_per_source and args.sample_per_source < args.per_source_cap:
        log.info("sample-per-source=%d overrides per-source-cap=%d",
                 args.sample_per_source, args.per_source_cap)
        args.per_source_cap = args.sample_per_source

    rng = random.Random(args.seed)
    FINAL.mkdir(parents=True, exist_ok=True)

    with REGISTRY_FILE.open() as f:
        registry = yaml.safe_load(f)
    weights: dict[str, float] = {}
    for e in (registry.get("datasets") or []):
        weights[e["slug"]] = float(e.get("weight", 1.0))
    for s in (registry.get("synthesized") or []):
        weights[s["task_id"]] = float(s.get("weight", 1.0))

    # Slugs whose normalized output should NOT enter the train mix and
    # instead be copied verbatim into data/abliteration/{harmful,harmless}.jsonl.
    # Determined by adapter name: any source using harmful_behaviors /
    # harmless_alpaca is calibration data.
    abliteration_slugs: dict[str, str] = {}
    for e in (registry.get("datasets") or []):
        adapter = e.get("normalizer")
        if adapter == "harmful_behaviors":
            abliteration_slugs[e["slug"]] = "harmful.jsonl"
        elif adapter == "harmless_alpaca":
            abliteration_slugs[e["slug"]] = "harmless.jsonl"

    # ─────────────── route abliteration sources directly ─────────────
    if abliteration_slugs:
        ABLITERATION.mkdir(parents=True, exist_ok=True)
        for slug, fname in abliteration_slugs.items():
            src = NORMALIZED / f"{slug}.jsonl"
            if not src.exists():
                log.info("  abliteration: %s not yet normalized; skipping", slug)
                continue
            dst = ABLITERATION / fname
            n = 0
            with src.open("r", encoding="utf-8", errors="replace") as fin, \
                 dst.open("w", encoding="utf-8") as fout:
                for line in fin:
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    tt = (rec.get("metadata") or {}).get("task_type") or ""
                    if tt not in ABLITERATION_TASK_TYPES:
                        continue
                    fout.write(line + "\n")
                    n += 1
            log.info("  abliteration: %s → %s (%d records)", slug, dst, n)

    # ─────────────── enumerate sources ────────────────────────────────
    sources: list[tuple[str, Path]] = []
    for path in sorted(NORMALIZED.glob("*.jsonl")):
        if path.name.endswith(".errors.jsonl"):
            continue
        # Abliteration calibration data is routed separately (above) and
        # must NEVER appear in train/val/test.
        if path.stem in abliteration_slugs:
            continue
        sources.append((path.stem, path))
    for path in sorted(SYNTHESIZED.rglob("*.jsonl")):
        # Skip dotfile / progress markers like .sample_n200_seed42.jsonl
        if any(part.startswith(".") for part in path.parts):
            continue
        # Use parent dir as namespace when nested (e.g. action_pairs/, translated/).
        rel = path.relative_to(SYNTHESIZED)
        if len(rel.parts) > 1:
            slug = f"synth:{rel.parts[0]}-{path.stem}"
        else:
            slug = f"synth:{path.stem}"
        sources.append((slug, path))

    if not sources:
        log.error("no normalized or synthesized records found")
        return 1

    # ─────────────── pass 1: count + compute per-source budgets ──────
    counts: dict[str, int] = {}
    has_explicit_splits: dict[str, bool] = {}
    total = 0
    log.info("pass 1: counting records per source")
    surviving_sources: list[tuple[str, Path]] = []
    for slug, path in sources:
        if not path.exists():
            # Concurrent producer can rename/remove a file between glob
            # enumeration and counting. Drop it from this run.
            log.warning("  %-40s vanished before count; skipping", slug)
            continue
        n = count_records(path)
        counts[slug] = n
        has_explicit_splits[slug] = detect_explicit_splits(path)
        total += n
        log.info("  %-40s %10d records  (%.1f MB)%s", slug, n,
                 path.stat().st_size / 1e6,
                 " [explicit val/test]" if has_explicit_splits[slug] else "")
        surviving_sources.append((slug, path))
    sources = surviving_sources
    log.info("pass 1 done: %d sources, %d records total", len(sources), total)

    # Tier-based per-source caps. Defs live at module scope so unit
    # tests can import them; see TIER_S/A/B/C/D/E_HERMES_COMBINED/F_N8N
    # and TIER_CAPS at the top of this file.
    targets = compute_targets(
        counts,
        per_source_cap=args.per_source_cap,
        no_weights=args.no_weights,
    )
    log.info("tier breakdown: S=%d A=%d B=%d C=%d D=%d E=%d F=%d",
             *(sum(1 for s in counts if tier_for(s) == t) for t in "SABCDEF"))

    grand_target = sum(targets.values())
    log.info("pass 2 will sample up to %d records (per_source_cap=%d, weights=%s)",
             grand_target, args.per_source_cap, not args.no_weights)

    # ─────────────── pass 2: reservoir-sample + stream-write ─────────
    train_path = FINAL / "train.jsonl"
    val_path = FINAL / "val.jsonl"
    test_path = FINAL / "test.jsonl"

    seen: set[bytes] = set()
    # group_key → "train"|"val"|"test"; ensures all records sharing the
    # same (system_prompt, currentMessage.content) prefix end up in the
    # same split. Without this, sources that emit multiple supervised
    # targets per turn (e.g. LIGHT/multilight: RESPOND + IGNORE + reply)
    # leak across splits and inflate eval metrics.
    group_split: dict[bytes, str] = {}
    by_source = Counter()
    by_task_type = Counter()
    by_phase: Counter = Counter()
    n_train = n_val = n_test = 0
    n_group_forced = 0
    n_oob = 0
    n_replicated = 0
    by_oob_task_type: Counter = Counter()
    oob_path = FINAL / "out_of_band.jsonl"
    foob = oob_path.open("w", encoding="utf-8") if args.oob_policy == "route" else None

    with train_path.open("w", encoding="utf-8") as ftr, \
         val_path.open("w", encoding="utf-8") as fva, \
         test_path.open("w", encoding="utf-8") as fte:

        for slug, path in sources:
            n = counts[slug]
            k = targets[slug]
            if n == 0 or k == 0:
                continue
            if not path.exists():
                log.warning("  %s vanished before sampling; skipping", slug)
                continue
            # Tier S sources are replicated: target == min(cap, n) × rep,
            # but the underlying file only has `n` distinct records. Sample
            # the unique reservoir size (target / rep) and emit each kept
            # record `rep` times below.
            tier = tier_for(slug)
            replicate_factor = TIER_CAPS[tier][1] if tier == "S" else 1
            unique_target = k // replicate_factor if replicate_factor > 1 else k
            log.info("  sampling %s: %d/%d (rep=%d)", slug,
                     unique_target, n, replicate_factor)
            keep = reservoir_sample_indices(n, unique_target, rng)

            n_kept = 0
            n_dup = 0
            with path.open("r", encoding="utf-8", errors="replace") as f:
                for idx, line in enumerate(f):
                    if idx not in keep:
                        continue
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # Defensive: never let abliteration calibration leak
                    # into the supervised splits. The slug-level filter
                    # above is the primary gate; this catches any record
                    # whose metadata.task_type was set after the slug was
                    # already enumerated as a regular source.
                    rec_tt = (rec.get("metadata") or {}).get("task_type") or ""
                    if rec_tt in ABLITERATION_TASK_TYPES:
                        continue
                    if classify_phase(rec_tt) == PHASE_OOB:
                        n_oob += 1
                        by_oob_task_type[rec_tt or "<missing>"] += 1
                        if args.oob_policy == "fail":
                            log.error(
                                "OOB record (task_type=%r) in %s; pack rejected. "
                                "See docs/dataset/COVERAGE_AUDIT.md.",
                                rec_tt, slug,
                            )
                            return 2
                        if args.oob_policy in ("drop", "route"):
                            if foob is not None:
                                foob.write(line + "\n")
                            continue
                        # allow: legacy behavior — fall through to inclusion
                    h = record_hash(rec)
                    if h in seen:
                        n_dup += 1
                        continue
                    seen.add(h)

                    # Decide split — GROUP-AWARE.
                    # Records sharing (system_prompt, currentMessage.content)
                    # must land in the same split. We cache the decision per
                    # group_key and force subsequent records into that split.
                    # If the source has explicit val/test markers, respect
                    # whatever metadata.split says. Otherwise (most sources,
                    # which only ship train.parquet), dice-roll every NEW
                    # group so val/test get a representative slice instead
                    # of being dominated by the rare sources with explicit
                    # splits.
                    md = rec.get("metadata") or {}
                    gk = group_key(rec)
                    forced = group_split.get(gk)
                    if forced is not None:
                        was = forced
                        n_group_forced += 1
                    else:
                        split = (md.get("split") or "").lower()
                        explicit = has_explicit_splits.get(slug, False)
                        if explicit and split == "test":
                            was = "test"
                        elif explicit and split in ("validation", "val", "dev"):
                            was = "val"
                        elif explicit and split == "train":
                            was = "train"
                        else:
                            roll = rng.random()
                            if roll < args.test_frac:
                                was = "test"
                            elif roll < args.test_frac + args.val_frac:
                                was = "val"
                            else:
                                was = "train"
                        group_split[gk] = was
                    if was == "test":
                        out = fte
                    elif was == "val":
                        out = fva
                    else:
                        out = ftr

                    out.write(line + "\n")
                    n_kept += 1
                    if was == "train":
                        n_train += 1
                    elif was == "val":
                        n_val += 1
                    else:
                        n_test += 1
                    by_source[md.get("source_dataset") or slug] += 1
                    by_task_type[md.get("task_type") or "?"] += 1
                    by_phase[classify_phase(rec_tt)] += 1

                    # Tier S replication: emit `replicate_factor - 1` extra
                    # copies of this record with a `metadata.replicate_index`
                    # breadcrumb. We use a per-replica RNG seeded from the
                    # base hash so future passes can reproduce, and so that
                    # an optional augmentation pass downstream has a stable
                    # per-copy seed to key off.
                    for r in range(1, replicate_factor):
                        rep_md = dict(md)
                        rep_md["replicate_index"] = r
                        # Stable per-replica seed: 32-bit hash of
                        # (record_hash, replicate_index). Varies the
                        # randomness slightly so downstream augmentation
                        # (paraphrase, dropout) won't produce identical
                        # outputs across replicas.
                        rep_md["replicate_seed"] = (
                            int.from_bytes(h[:4], "big") ^ (r * 0x9E3779B1)
                        ) & 0xFFFFFFFF
                        rep_rec = dict(rec)
                        rep_rec["metadata"] = rep_md
                        out.write(json.dumps(rep_rec, ensure_ascii=False,
                                             separators=(",", ":")) + "\n")
                        n_kept += 1
                        n_replicated += 1
                        if was == "train":
                            n_train += 1
                        elif was == "val":
                            n_val += 1
                        else:
                            n_test += 1
                        by_source[md.get("source_dataset") or slug] += 1
                        by_task_type[md.get("task_type") or "?"] += 1
                        by_phase[classify_phase(rec_tt)] += 1

            log.info("    kept %d, dropped %d duplicates", n_kept, n_dup)

    # ─────────────── enforce --max-train if needed ───────────────────
    if args.max_train and n_train > args.max_train:
        log.info("truncating train.jsonl to %d records (was %d)",
                 args.max_train, n_train)
        tmp = train_path.with_suffix(".tmp")
        n_emit = 0
        with train_path.open("r", encoding="utf-8") as f, \
             tmp.open("w", encoding="utf-8") as g:
            # Reservoir-sample by line
            keep = reservoir_sample_indices(n_train, args.max_train, rng)
            for idx, line in enumerate(f):
                if idx in keep:
                    g.write(line)
                    n_emit += 1
        os.replace(tmp, train_path)
        n_train = n_emit

    if foob is not None:
        foob.close()

    # ─────────────── phase-distribution gate (post-pack) ───────────
    # by_phase counts every record written across train/val/test.
    # We compute the in-band fraction (excluding OOB, which the route/
    # drop policies already excluded from the splits) and check each
    # phase against its target band ± PHASE_BAND_TOLERANCE. Empty
    # phases are not fatal — Phase 3/4 may be sparse until the
    # synthesizers run — they only emit a WARNING.
    in_band_total = sum(by_phase[p] for p in ("1", "2", "3", "4"))
    phase_distribution: dict[str, float] = {}
    if in_band_total > 0:
        for p in ("1", "2", "3", "4"):
            phase_distribution[p] = by_phase[p] / in_band_total

    if args.phase_distribution_target == "balanced":
        bands = PHASE_BANDS_BALANCED
    elif args.phase_distribution_target == "flat":
        bands = PHASE_BANDS_FLAT
    else:
        bands = None  # legacy: no gate

    drift: dict[str, dict[str, float]] = {}
    if bands is not None and in_band_total > 0:
        for p, (lo, hi) in bands.items():
            actual = phase_distribution.get(p, 0.0)
            lo_with_tol = max(0.0, lo - PHASE_BAND_TOLERANCE)
            hi_with_tol = min(1.0, hi + PHASE_BAND_TOLERANCE)
            if actual < lo_with_tol or actual > hi_with_tol:
                drift[p] = {
                    "actual": round(actual, 4),
                    "lo": lo,
                    "hi": hi,
                    "tolerance": PHASE_BAND_TOLERANCE,
                }
        if drift:
            log.warning(
                "phase distribution outside ±%.0f%% of target=%s: %s",
                PHASE_BAND_TOLERANCE * 100,
                args.phase_distribution_target,
                drift,
            )

    manifest = {
        "totals": {"train": n_train, "val": n_val, "test": n_test},
        "by_source": dict(by_source.most_common()),
        "by_task_type": dict(by_task_type.most_common()),
        "seed": args.seed,
        "per_source_cap": args.per_source_cap,
        "weights_applied": not args.no_weights,
        "unique_records": len(seen),
        "unique_groups": len(group_split),
        "group_forced_routings": n_group_forced,
        "replicated_records": n_replicated,
        "out_of_band": {
            "policy": args.oob_policy,
            "count": n_oob,
            "by_task_type": dict(by_oob_task_type.most_common()),
        },
        "phase_target": args.phase_distribution_target,
        "phase_distribution": {
            p: round(v, 4) for p, v in phase_distribution.items()
        },
        "phase_drift": drift,
    }
    (FINAL / "manifest.json").write_text(json.dumps(manifest, indent=2),
                                          encoding="utf-8")

    log.info("totals: train=%d val=%d test=%d (unique=%d, groups=%d, forced=%d)",
             n_train, n_val, n_test, len(seen), len(group_split), n_group_forced)
    log.info("by_task_type: %s", dict(by_task_type.most_common()))
    if n_oob:
        log.warning(
            "out-of-band records (policy=%s): %d total; by task_type=%s",
            args.oob_policy, n_oob, dict(by_oob_task_type.most_common()),
        )
        if args.oob_policy == "route":
            log.warning("  routed to %s for review/transform", oob_path)
    log.info("manifest at %s", FINAL / "manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
