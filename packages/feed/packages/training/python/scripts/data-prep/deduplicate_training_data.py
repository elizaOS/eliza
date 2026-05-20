#!/usr/bin/env python3
"""
Deduplicate training data by content similarity.

Strategy:
1. Extract the "signal" from each example (the attacker's actual message content,
   stripped of boilerplate runtime context and JSON wrapping)
2. Compute MinHash signatures for fuzzy dedup (catches near-duplicates from
   template expansion with minor variations)
3. Exact-match dedup on normalized content hash
4. Report duplicates found and write a clean corpus

This catches:
- Identical messages that only differ in speaker name or scenario ID
- Near-duplicate messages from template expansion with same asset/target/register
- Structurally identical attacks across different pattern IDs
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import struct
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)


# ─── Signal Extraction ───────────────────────────────────────────────────────


def extract_attacker_content(user_prompt: str, category: str = "") -> str:
    """Extract the attacker's actual message from the full user prompt.

    The user_prompt has this structure:
        Runtime context: { ... }
        Conversation transcript:
        [channel] speaker (role): <ACTUAL CONTENT>
        ...
        Produce your next outbound message...

    For attack examples we want just the attacker content lines.
    For benign examples (category="benign") we include all participant
    content with role tags so that conversations with different topics
    but similar structure remain distinct.
    """
    lines = user_prompt.split("\n")
    content_lines = []
    in_transcript = False
    is_benign = category.lower() == "benign" if category else False

    for line in lines:
        if "Conversation transcript:" in line:
            in_transcript = True
            continue
        if in_transcript:
            if line.startswith("Produce your next") or line.strip() == "":
                if line.startswith("Produce"):
                    break
                continue
            # Extract content after the [channel] speaker (role): prefix
            match = re.match(r"\[.*?\]\s*\S+\s*\((\w+)\):\s*(.*)", line)
            if match:
                role = match.group(1)
                content = match.group(2).strip()
                if is_benign:
                    # For benign examples, keep role + content to preserve
                    # conversational context that differentiates examples
                    content_lines.append(f"{role}: {content}")
                else:
                    content_lines.append(content)
            else:
                content_lines.append(line.strip())

    return " ".join(content_lines)


_CRYPTO_TICKERS = [
    "BTC",
    "ETH",
    "SOL",
    "USDC",
    "USDT",
    "MATIC",
    "AVAX",
    "ADA",
    "DOT",
    "LINK",
    "UNI",
    "AAVE",
    "DOGE",
    "SHIB",
    "XRP",
    "BNB",
    "ARB",
    "OP",
    "APT",
    "SUI",
    "NEAR",
    "ATOM",
    "FTM",
    "CRO",
    "LTC",
    "ALGO",
    "FIL",
    "SAND",
    "MANA",
    "AXS",
    "GMT",
    "APE",
    "ICP",
    "HBAR",
    "VET",
    "EOS",
    "XLM",
    "TRX",
    "WBTC",
    "WETH",
    "DAI",
    "BUSD",
    "TUSD",
    "FRAX",
]
# Build regex: match uppercase tickers as whole words (before lowercasing)
_TICKER_RE = re.compile(r"\b(" + "|".join(_CRYPTO_TICKERS) + r")\b")
# Match dollar amounts like $100, $5M, $3.2B, $0.50
_DOLLAR_RE = re.compile(r"\$[\d]+(?:[.,]\d+)?(?:[KkMmBbTt])?")
# Match percentages like 3.2%, 40%, 0.5%
_PERCENT_RE = re.compile(r"[\d]+(?:\.\d+)?%")


def normalize_content(text: str) -> str:
    """Normalize content for comparison: lowercase, collapse whitespace,
    strip punctuation variations, normalize common substitutions.

    Preserves crypto tickers, dollar amounts, and percentages so that
    benign examples differing only in financial tokens remain distinct.
    """
    # --- Phase 1: Extract tokens that must survive normalization ---
    placeholders: list[tuple[str, str]] = []
    counter = 0

    def _placeholder(match: re.Match) -> str:
        nonlocal counter
        token = match.group(0)
        tag = f"XPRSV{counter}X"
        placeholders.append((tag, token))
        counter += 1
        return f" {tag} "

    t = text
    # Preserve tickers BEFORE lowercasing (they are uppercase in source)
    t = _TICKER_RE.sub(_placeholder, t)
    # Preserve dollar amounts and percentages BEFORE punctuation strip
    t = _DOLLAR_RE.sub(_placeholder, t)
    t = _PERCENT_RE.sub(_placeholder, t)

    # --- Phase 2: Standard normalization (existing logic) ---
    t = t.lower()
    # Normalize register-specific transforms back to canonical
    t = re.sub(r"\bur\b", "your", t)
    t = re.sub(r"\bu\b", "you", t)
    t = re.sub(r"\bplz\b", "please", t)
    t = re.sub(r"\bpls\b", "please", t)
    t = re.sub(r"\brn\b", "right now", t)
    t = re.sub(r"\bis\b", "are", t)  # broken-english "is" → "are"
    # Strip professional-wordy prefix
    t = re.sub(r"for the avoidance of doubt.*?workflow,?\s*", "", t)
    t = re.sub(r"please treat this as.*?request\.?\s*", "", t)
    # Strip adversarial wrappers
    t = re.sub(r"\[system override\]", "", t)
    t = re.sub(r"\[end override\]", "", t)
    # Normalize whitespace and punctuation
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()

    # --- Phase 3: Restore preserved tokens ---
    for tag, original in placeholders:
        # Tags were lowercased in phase 2; match case-insensitively
        t = re.sub(tag.lower(), original, t, count=1)

    return t


def content_hash(text: str) -> str:
    """SHA-256 of normalized content."""
    return hashlib.sha256(normalize_content(text).encode()).hexdigest()[:16]


# ─── MinHash for Fuzzy Dedup ────────────────────────────────────────────────


def shingle(text: str, k: int = 3) -> set[str]:
    """Generate character-level k-shingles."""
    normalized = normalize_content(text)
    words = normalized.split()
    if len(words) < k:
        return {normalized}
    return {" ".join(words[i : i + k]) for i in range(len(words) - k + 1)}


def minhash_signature(shingles: set[str], num_hashes: int = 64) -> tuple[int, ...]:
    """Compute MinHash signature."""
    if not shingles:
        return tuple([0] * num_hashes)

    sig = []
    for i in range(num_hashes):
        min_hash = float("inf")
        for s in shingles:
            h = struct.unpack("<I", hashlib.md5(f"{i}:{s}".encode()).digest()[:4])[0]
            if h < min_hash:
                min_hash = h
        sig.append(min_hash)
    return tuple(sig)


def jaccard_from_minhash(sig1: tuple[int, ...], sig2: tuple[int, ...]) -> float:
    """Estimate Jaccard similarity from MinHash signatures."""
    if len(sig1) != len(sig2):
        return 0.0
    return sum(a == b for a, b in zip(sig1, sig2, strict=False)) / len(sig1)


def lsh_buckets(sig: tuple[int, ...], bands: int = 16) -> list[str]:
    """LSH banding: split signature into bands and hash each band."""
    rows_per_band = len(sig) // bands
    buckets = []
    for b in range(bands):
        band = sig[b * rows_per_band : (b + 1) * rows_per_band]
        bucket_hash = hashlib.md5(str(band).encode()).hexdigest()[:12]
        buckets.append(f"b{b}:{bucket_hash}")
    return buckets


from dataclasses import dataclass

# ─── Deduplication Pipeline ──────────────────────────────────────────────────


@dataclass
class DeduplicationResult:
    total_input: int
    exact_duplicates: int
    fuzzy_duplicates: int
    kept: int
    removed_ids: list[str]
    category_stats: dict[str, dict[str, int]]


def example_quality_score(example: dict[str, Any]) -> float:
    score = 0.0
    reasoning_source = str(
        example.get("reasoning_source") or example.get("reasoningSource") or ""
    ).strip()
    if reasoning_source == "captured-trace":
        score += 40.0
    elif reasoning_source == "derived":
        score += 20.0

    if any(
        example.get(field)
        for field in (
            "raw_reasoning_trace",
            "rawReasoningTrace",
            "reasoning_available",
            "reasoningAvailable",
        )
    ):
        score += 10.0

    available_actions = example.get("available_actions") or example.get("availableActions") or []
    if isinstance(available_actions, list):
        score += min(len(available_actions), 12)

    user_prompt = str(example.get("user_prompt") or "")
    response = str(example.get("response") or "")
    score += min(len(user_prompt), 2_000) / 500.0
    score += min(len(response), 1_000) / 250.0
    return score


def preferred_example_index(
    examples: list[dict[str, Any]],
    left_index: int,
    right_index: int,
) -> int:
    left_score = example_quality_score(examples[left_index])
    right_score = example_quality_score(examples[right_index])
    if left_score > right_score:
        return left_index
    if right_score > left_score:
        return right_index
    return min(left_index, right_index)


def deduplicate(
    examples: list[dict[str, Any]],
    fuzzy_threshold: float = 0.85,
    num_hashes: int = 64,
    bands: int = 16,
) -> tuple[list[dict[str, Any]], DeduplicationResult]:
    """
    Deduplicate training examples by content similarity.

    Returns (deduplicated_examples, result_stats).
    """
    if not examples:
        return [], DeduplicationResult(0, 0, 0, 0, [], {})

    # Phase 1: Extract signals and compute hashes
    signals: list[str] = []
    exact_hashes: list[str] = []

    for ex in examples:
        content = extract_attacker_content(
            ex.get("user_prompt", ""),
            category=ex.get("category", ""),
        )
        signals.append(content)
        exact_hashes.append(content_hash(content))

    # Phase 2: Exact dedup
    seen_hashes: dict[str, int] = {}  # hash → preferred index
    exact_dupe_indices: set[int] = set()

    for i, h in enumerate(exact_hashes):
        kept_index = seen_hashes.get(h)
        if kept_index is None:
            seen_hashes[h] = i
            continue
        preferred = preferred_example_index(examples, kept_index, i)
        removed = i if preferred == kept_index else kept_index
        seen_hashes[h] = preferred
        exact_dupe_indices.discard(preferred)
        exact_dupe_indices.add(removed)

    # Phase 3: Fuzzy dedup via MinHash LSH on remaining examples
    remaining_indices = [i for i in range(len(examples)) if i not in exact_dupe_indices]

    # Compute MinHash signatures
    signatures: dict[int, tuple[int, ...]] = {}
    for i in remaining_indices:
        shingles = shingle(signals[i])
        signatures[i] = minhash_signature(shingles, num_hashes)

    # LSH: group candidates by band buckets
    bucket_to_indices: dict[str, list[int]] = defaultdict(list)
    for i in remaining_indices:
        for bucket in lsh_buckets(signatures[i], bands):
            bucket_to_indices[bucket].append(i)

    # Find fuzzy duplicate components
    checked_pairs: set[tuple[int, int]] = set()
    adjacency: dict[int, set[int]] = defaultdict(set)

    for bucket_indices in bucket_to_indices.values():
        if len(bucket_indices) < 2:
            continue
        for a_pos in range(len(bucket_indices)):
            for b_pos in range(a_pos + 1, len(bucket_indices)):
                a, b = bucket_indices[a_pos], bucket_indices[b_pos]
                if a == b:
                    continue
                pair = (min(a, b), max(a, b))
                if pair in checked_pairs:
                    continue
                checked_pairs.add(pair)

                sim = jaccard_from_minhash(signatures[a], signatures[b])
                if sim >= fuzzy_threshold:
                    adjacency[a].add(b)
                    adjacency[b].add(a)

    fuzzy_dupe_indices: set[int] = set()
    visited: set[int] = set()
    for start in adjacency:
        if start in visited:
            continue
        stack = [start]
        component: list[int] = []
        while stack:
            node = stack.pop()
            if node in visited:
                continue
            visited.add(node)
            component.append(node)
            stack.extend(adjacency[node] - visited)
        if len(component) <= 1:
            continue
        kept_index = component[0]
        for candidate in component[1:]:
            kept_index = preferred_example_index(examples, kept_index, candidate)
        for candidate in component:
            if candidate != kept_index:
                fuzzy_dupe_indices.add(candidate)

    # Combine
    all_removed = exact_dupe_indices | fuzzy_dupe_indices
    kept_examples = [ex for i, ex in enumerate(examples) if i not in all_removed]
    removed_ids = [examples[i].get("scenario_id", f"idx-{i}") for i in sorted(all_removed)]

    # Category breakdown
    cat_stats: dict[str, dict[str, int]] = {}
    for i, ex in enumerate(examples):
        cat = ex.get("category", "unknown")
        if cat not in cat_stats:
            cat_stats[cat] = {"input": 0, "exact_dupes": 0, "fuzzy_dupes": 0, "kept": 0}
        cat_stats[cat]["input"] += 1
        if i in exact_dupe_indices:
            cat_stats[cat]["exact_dupes"] += 1
        elif i in fuzzy_dupe_indices:
            cat_stats[cat]["fuzzy_dupes"] += 1
        else:
            cat_stats[cat]["kept"] += 1

    result = DeduplicationResult(
        total_input=len(examples),
        exact_duplicates=len(exact_dupe_indices),
        fuzzy_duplicates=len(fuzzy_dupe_indices),
        kept=len(kept_examples),
        removed_ids=removed_ids,
        category_stats=cat_stats,
    )

    return kept_examples, result


# ─── CLI ─────────────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deduplicate training data by content similarity, then backfill to target count."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input training_examples.jsonl file.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output directory for deduplicated data.",
    )
    parser.add_argument(
        "--fuzzy-threshold",
        type=float,
        default=0.85,
        help="MinHash Jaccard threshold for fuzzy dedup (default: 0.85).",
    )
    parser.add_argument(
        "--target-count",
        type=int,
        default=0,
        help="Target count after dedup. If set, generates more to backfill (default: 0 = no backfill).",
    )
    parser.add_argument(
        "--backfill-seed",
        type=int,
        default=9999,
        help="Seed for backfill generation (different from original to get new content).",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        input_path = Path(args.input).resolve()
        examples: list[dict[str, Any]] = []
        with input_path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    examples.append(json.loads(line))

        LOGGER.info("Loaded %d examples from %s", len(examples), input_path)
        clean, result = deduplicate(examples, fuzzy_threshold=args.fuzzy_threshold)

        print("\n=== Deduplication Results ===")
        print(f"Input:            {result.total_input:,}")
        print(f"Exact duplicates: {result.exact_duplicates:,}")
        print(f"Fuzzy duplicates: {result.fuzzy_duplicates:,}")
        print(f"Kept:             {result.kept:,}")
        print(
            f"Removal rate:     {(result.exact_duplicates + result.fuzzy_duplicates) / max(result.total_input, 1):.1%}"
        )

        print("\nPer category:")
        for cat, stats in sorted(result.category_stats.items()):
            print(
                f"  {cat}: {stats['input']} → {stats['kept']} "
                f"(-{stats['exact_dupes']} exact, -{stats['fuzzy_dupes']} fuzzy)"
            )

        if args.target_count > 0 and len(clean) < args.target_count:
            deficit = args.target_count - len(clean)
            LOGGER.info("Backfilling %d rows to reach target %d", deficit, args.target_count)
            print(f"\nBackfilling {deficit:,} examples to reach target {args.target_count:,}...")

            import generate_synthetic_conversations as gen

            backfill = gen.generate_all(
                target_count=deficit + int(deficit * 0.2),
                seed=args.backfill_seed,
            )

            combined = clean + backfill
            clean, backfill_result = deduplicate(combined, fuzzy_threshold=args.fuzzy_threshold)
            LOGGER.info(
                "Backfill dedup finished: exact=%d fuzzy=%d kept=%d",
                backfill_result.exact_duplicates,
                backfill_result.fuzzy_duplicates,
                backfill_result.kept,
            )
            clean = clean[: args.target_count]
            print(f"After backfill + dedup: {len(clean):,} examples")

        timestamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        default_dir = input_path.parent.parent / f"deduplicated-{timestamp}"
        output_dir = Path(args.output_dir).resolve() if args.output_dir else default_dir
        output_dir.mkdir(parents=True, exist_ok=True)

        output_path = output_dir / "training_examples.jsonl"
        with output_path.open("w", encoding="utf-8") as f:
            for ex in clean:
                f.write(json.dumps(ex) + "\n")

        manifest = {
            "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
            "pipeline": "deduplicate_training_data.py",
            "inputFile": str(input_path),
            "fuzzyThreshold": args.fuzzy_threshold,
            "inputCount": result.total_input,
            "exactDuplicates": result.exact_duplicates,
            "fuzzyDuplicates": result.fuzzy_duplicates,
            "outputCount": len(clean),
            "removalRate": round(
                (result.exact_duplicates + result.fuzzy_duplicates) / max(result.total_input, 1), 4
            ),
            "categoryStats": result.category_stats,
            "backfillTarget": args.target_count if args.target_count > 0 else None,
        }
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        LOGGER.info("Deduplicated corpus ready at %s with %d rows", output_path, len(clean))
        print(f"\nDeduplicated output → {output_path}")
        print(f"Manifest → {output_dir / 'manifest.json'}")
        return 0
    except Exception:
        LOGGER.exception("Training data deduplication failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
