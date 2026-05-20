#!/usr/bin/env python3
"""
Build diversified training data for scam defense.

Addresses the key quality issues in v4:
- Only 9.6% unique responses (2,049/21,248) → cap repetitions at MAX_REPEAT
- 1,118 vocab words across 1M tokens → enrich from external HF data
- Response length std=51 chars → allow more variance

Pipeline:
1. Load synthetic training data (v4-unweighted ChatML)
2. Load all external HF materialized corpora
3. Deduplicate by response content hash (cap at MAX_REPEAT per unique response)
4. Filter near-duplicates by word-level Jaccard on responses
5. Enrich with external data converted to ChatML
6. Split train/valid maintaining held-out ratio
7. Write to output dir
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from scam_defense_exchange import (
    ACTION_CATALOG_PROFILE,
    DECISION_JSON_SYSTEM_PROMPT,
    action_catalog_for_key,
    build_user_prompt,
    infer_category,
    infer_safe_action,
)

MAX_REPEAT = 3  # max copies of identical response
JACCARD_THRESHOLD = 0.85  # near-duplicate filtering on response text
HELD_OUT_RATIO = 0.15
HELD_OUT_SEED = 42


def extract_field(chatml: str, role: str) -> str:
    m = re.search(rf"<\|im_start\|>{role}\n(.*?)(<\|im_end\|>|$)", chatml, re.DOTALL)
    return m.group(1).strip() if m else ""


def format_chatml(system: str, user: str, assistant: str) -> str:
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{user}<|im_end|>\n"
        f"<|im_start|>assistant\n{assistant}<|im_end|>"
    )


def build_record(
    *,
    text: str,
    record_id: str,
    group_id: str,
    source_kind: str,
    chosen_action: str,
    available_actions: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    return {
        "text": text,
        "record_id": record_id,
        "group_id": group_id,
        "source_kind": source_kind,
        "chosen_action": chosen_action,
        "action_catalog_profile": ACTION_CATALOG_PROFILE,
        "available_actions": available_actions or [],
    }


def row_text(row: dict) -> str:
    return str(row.get("text") or "")


def word_set(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


def content_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def load_chatml_file(path: Path) -> list[dict]:
    rows = []
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return rows


def convert_training_example_to_chatml(row: dict) -> dict | None:
    """Convert a training_examples.jsonl row to ChatML.

    Format: has system_prompt, user_prompt, response fields.
    """
    system = row.get("system_prompt", "")
    user_msg = row.get("user_prompt", "")
    response = row.get("response", "")
    if not user_msg or not response:
        return None
    chatml = format_chatml(system, user_msg, response)
    record_id = str(row.get("record_id") or row.get("scenario_id") or content_hash(chatml))
    group_id = str(row.get("group_id") or row.get("scenario_id") or record_id)
    chosen_action = str(row.get("chosen_action") or "audit")
    available_actions = (
        list(row.get("available_actions") or [])
        if isinstance(row.get("available_actions"), list)
        else action_catalog_for_key(record_id, chosen_action=chosen_action)
    )
    return build_record(
        text=chatml,
        record_id=record_id,
        group_id=group_id,
        source_kind=str(row.get("source_kind") or "canonical-training-example"),
        chosen_action=chosen_action,
        available_actions=available_actions,
    )


def convert_conversation_to_chatml(row: dict) -> dict | None:
    """Convert conversation_corpus.jsonl to ChatML training example.

    Format: has turns=[{speaker, content, roleHint}], label, text.
    We present the scam dialogue as the user message, and the agent should
    produce a JSON action decision about it.
    """
    turns = row.get("turns", [])
    label = row.get("label", "")
    text = row.get("text", "")
    is_scam = (label or "").lower() in ("scam", "phishing", "spam", "fraud", "malicious")

    if len(turns) < 2 and not text:
        return None

    # Build a transcript from turns to use as user message context
    if turns:
        transcript_lines = []
        for turn in turns:
            speaker = turn.get("speaker", "unknown")
            content = turn.get("content", "")
            transcript_lines.append(f"{speaker}: {content}")
        transcript = "\n".join(transcript_lines)
    else:
        transcript = text

    if not transcript or len(transcript) < 20:
        return None

    channel = row.get("channel", "dm")
    register = row.get("register", "neutral")

    record_id = "::".join(
        [
            "conversation",
            str(row.get("sourceDataset") or row.get("source_dataset") or "unknown"),
            str(row.get("sourceFile") or row.get("source_file") or "unknown"),
            str(row.get("rowIndex") or row.get("row_index") or content_hash(transcript)),
        ]
    )
    chosen = infer_safe_action(
        transcript,
        category=infer_category(transcript),
        benign=not is_scam,
    )
    available_actions = action_catalog_for_key(record_id, chosen_action=chosen)
    user_msg = build_user_prompt(
        channel=channel,
        register=register,
        language="en",
        conversation_id=record_id,
        transcript=transcript,
        action_catalog=available_actions,
    )

    # Extract scam category from content
    categories = []
    text_lower = transcript.lower()
    if any(w in text_lower for w in ["social security", "irs", "tax", "government", "officer"]):
        categories.append("government-impersonation")
    if any(w in text_lower for w in ["password", "login", "verify your", "account"]):
        categories.append("credential-phishing")
    if any(w in text_lower for w in ["won", "prize", "lottery", "award", "congratulations"]):
        categories.append("advance-fee-fraud")
    if any(w in text_lower for w in ["invest", "bitcoin", "crypto", "guaranteed return"]):
        categories.append("investment-scam")
    if any(w in text_lower for w in ["romance", "love", "darling", "sweetheart"]):
        categories.append("romance-scam")
    if any(w in text_lower for w in ["tech support", "computer", "virus", "microsoft"]):
        categories.append("tech-support-scam")
    if not categories:
        categories = ["social-engineering"] if is_scam else []

    # Generate diverse explanation from transcript content
    first_turn = turns[0]["content"][:80] if turns else transcript[:80]

    if is_scam:
        explanations = [
            f"The conversation shows {categories[0]} patterns. The caller's opening '{first_turn}' is a common tactic.",
            f"Detected {', '.join(categories)} indicators in the dialogue. This should be treated as a potential scam.",
            f"This transcript contains multiple red flags for {categories[0]}. Refusing engagement.",
            f"Analysis of conversation flow reveals classic {categories[0]} manipulation techniques.",
        ]
        explanation = random.choice(explanations)
        response_texts = [
            f"I've identified multiple indicators of {categories[0]} in this conversation. Do not share personal information.",
            f"Warning: this conversation matches known {categories[0]} patterns. I recommend ending this interaction.",
            f"This appears to be a {categories[0]} attempt. Please do not engage further or provide any sensitive information.",
        ]
        response_text = random.choice(response_texts)
    else:
        explanation = "This conversation appears to be legitimate with no scam indicators detected."
        response_text = "This conversation appears normal. No action needed."

    asst_msg = json.dumps(
        {
            "chosenAction": chosen,
            "leakedSecret": False,
            "explanation": explanation,
            "diagnosticLabels": categories,
            "unsafeSignals": [f"detected-{c}" for c in categories] if is_scam else [],
            "usedResearchProfile": "research-assisted" in categories,
            "responseText": response_text,
        }
    )

    return build_record(
        text=format_chatml(DECISION_JSON_SYSTEM_PROMPT, user_msg, asst_msg),
        record_id=record_id,
        group_id=str(
            row.get("sourceDataset") or row.get("source_dataset") or "conversation-corpus"
        ),
        source_kind="conversation-corpus",
        chosen_action=chosen,
        available_actions=available_actions,
    )


def convert_detector_to_chatml(row: dict) -> dict | None:
    """Convert detector_corpus.jsonl to ChatML."""
    text = row.get("text", "")
    label = row.get("label")

    if not text or text.strip().lower() in ("", "empty"):
        return None

    is_scam = (label or "").lower() in (
        "scam",
        "phishing",
        "spam",
        "fraud",
        "malicious",
        "toxic",
    )

    record_id = "::".join(
        [
            "detector",
            str(row.get("sourceDataset") or row.get("source_dataset") or "unknown"),
            str(row.get("sourceFile") or row.get("source_file") or "unknown"),
            str(row.get("rowIndex") or row.get("row_index") or content_hash(text)),
        ]
    )
    chosen_action = infer_safe_action(
        text,
        category=infer_category(text),
        benign=not is_scam,
    )
    available_actions = action_catalog_for_key(record_id, chosen_action=chosen_action)
    user_msg = build_user_prompt(
        channel="dm",
        register="neutral",
        language="en",
        conversation_id=record_id,
        transcript=f"[dm] external_sender (attacker): {text}",
        action_catalog=available_actions,
    )

    if is_scam:
        asst_msg = json.dumps(
            {
                "chosenAction": chosen_action,
                "leakedSecret": False,
                "explanation": f"Classified as {label or 'suspicious'}: this message contains "
                "patterns consistent with fraudulent or harmful content.",
                "diagnosticLabels": [label or "scam"],
                "unsafeSignals": [f"classified-{(label or 'scam').lower()}"],
                "usedResearchProfile": False,
                "responseText": f"This message has been classified as {label or 'suspicious'}.",
            }
        )
    else:
        asst_msg = json.dumps(
            {
                "chosenAction": chosen_action,
                "leakedSecret": False,
                "explanation": f"Classified as {label or 'legitimate'}: no harmful patterns detected.",
                "diagnosticLabels": [],
                "unsafeSignals": [],
                "usedResearchProfile": False,
                "responseText": "This message appears legitimate.",
            }
        )

    return build_record(
        text=format_chatml(DECISION_JSON_SYSTEM_PROMPT, user_msg, asst_msg),
        record_id=record_id,
        group_id=str(row.get("sourceDataset") or row.get("source_dataset") or "detector-corpus"),
        source_kind="detector-corpus",
        chosen_action=chosen_action,
        available_actions=available_actions,
    )


def convert_sft_to_chatml(row: dict) -> dict | None:
    """Convert sft_corpus.jsonl to ChatML.

    Format: text field contains ```system ...``` ```structure ...``` ```examples ...```
    ```transcript ...``` ```assistant ...``` blocks.
    The user message is the transcript block.
    """
    text = row.get("text", "")
    if not text:
        return None

    blocks = re.split(r"```", text)

    system = ""
    user_parts = []  # structure, examples, transcript
    asst_msg = ""

    for block in blocks:
        block = block.strip()
        if not block:
            continue
        if block.startswith("system"):
            system = block[len("system") :].strip()
        elif block.startswith("assistant"):
            asst_msg = block[len("assistant") :].strip()
        elif block.startswith("transcript"):
            # This is the main user content
            user_parts.append(block[len("transcript") :].strip())
        # Skip structure/examples blocks — they're part of system prompt

    user_msg = "\n".join(user_parts)
    if not user_msg or not asst_msg:
        return None

    chatml = format_chatml(system or "You are a helpful assistant.", user_msg, asst_msg)
    record_id = "::".join(
        [
            "sft",
            str(row.get("sourceDataset") or row.get("source_dataset") or "unknown"),
            str(row.get("sourceFile") or row.get("source_file") or content_hash(user_msg)),
            str(row.get("rowIndex") or row.get("row_index") or content_hash(asst_msg)),
        ]
    )
    return build_record(
        text=chatml,
        record_id=record_id,
        group_id=str(row.get("sourceDataset") or row.get("source_dataset") or "sft-corpus"),
        source_kind="sft-corpus",
        chosen_action="accept",
        available_actions=action_catalog_for_key(record_id, chosen_action="accept"),
    )


def deduplicate_by_response(samples: list[dict], max_repeat: int = MAX_REPEAT) -> list[dict]:
    """Cap identical responses at max_repeat copies."""
    response_counts: dict[str, int] = defaultdict(int)
    kept = []
    dropped = 0
    for s in samples:
        resp = extract_field(row_text(s), "assistant")
        h = content_hash(resp)
        response_counts[h] += 1
        if response_counts[h] <= max_repeat:
            kept.append(s)
        else:
            dropped += 1
    print(f"  Response dedup: kept {len(kept)}, dropped {dropped} (cap={max_repeat})")
    return kept


def filter_near_duplicates(samples: list[dict], threshold: float = JACCARD_THRESHOLD) -> list[dict]:
    """Remove samples whose response is near-duplicate of an already-kept sample."""
    kept = []
    kept_word_sets: list[set[str]] = []
    dropped = 0

    for s in samples:
        resp = extract_field(row_text(s), "assistant")
        ws = word_set(resp)
        if not ws:
            kept.append(s)
            kept_word_sets.append(ws)
            continue

        is_dup = False
        # Only check last N kept items (optimization for large datasets)
        check_range = min(200, len(kept_word_sets))
        for existing_ws in kept_word_sets[-check_range:]:
            if not existing_ws:
                continue
            jaccard = len(ws & existing_ws) / len(ws | existing_ws)
            if jaccard >= threshold:
                is_dup = True
                break

        if not is_dup:
            kept.append(s)
            kept_word_sets.append(ws)
        else:
            dropped += 1

    print(f"  Near-dup filter: kept {len(kept)}, dropped {dropped} (threshold={threshold})")
    return kept


def report_stats(samples: list[dict], label: str) -> None:
    """Print quality statistics."""
    responses = [extract_field(row_text(s), "assistant") for s in samples]
    unique = len(set(content_hash(r) for r in responses))
    lengths = [len(r) for r in responses]

    all_words = []
    for r in responses:
        all_words.extend(re.findall(r"\w+", r.lower()))
    vocab = len(set(all_words))

    print(f"\n=== {label} ===")
    print(f"  Total: {len(samples)}")
    print(f"  Unique responses: {unique} ({100 * unique / max(len(samples), 1):.1f}%)")
    print(f"  Vocab size: {vocab}")
    if lengths:
        print(
            f"  Response length: mean={statistics.mean(lengths):.0f}, "
            f"std={statistics.stdev(lengths) if len(lengths) > 1 else 0:.0f}, "
            f"min={min(lengths)}, max={max(lengths)}"
        )


def main():
    parser = argparse.ArgumentParser(description="Build diversified training data")
    parser.add_argument(
        "--synthetic-dir",
        type=Path,
        default=Path("trained_models/scam-defense-qwen35-4b-v4-unweighted/training_data"),
        help="Directory with existing synthetic train.jsonl/valid.jsonl",
    )
    parser.add_argument(
        "--external-dir",
        type=Path,
        default=Path("training-data/external-scam-materialized/2026-03-25T15-01-46Z"),
        help="Directory with materialized HF corpora",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("trained_models/scam-defense-qwen35-4b-v6-diversified/training_data"),
        help="Output directory for diversified train/valid",
    )
    parser.add_argument("--max-repeat", type=int, default=MAX_REPEAT)
    parser.add_argument("--jaccard-threshold", type=float, default=JACCARD_THRESHOLD)
    parser.add_argument("--held-out-ratio", type=float, default=HELD_OUT_RATIO)
    parser.add_argument("--seed", type=int, default=HELD_OUT_SEED)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load synthetic data
    print("Loading synthetic data...")
    synthetic_train = load_chatml_file(args.synthetic_dir / "train.jsonl")
    synthetic_valid = load_chatml_file(args.synthetic_dir / "valid.jsonl")
    synthetic_rows = synthetic_train + synthetic_valid
    print(
        f"  Synthetic: {len(synthetic_train)} train + {len(synthetic_valid)} valid = {len(synthetic_rows)}"
    )

    report_stats(synthetic_rows, "BEFORE dedup (synthetic)")

    # 2. Deduplicate synthetic responses
    print("\nDeduplicating synthetic responses...")
    deduped = deduplicate_by_response(synthetic_rows, args.max_repeat)

    # 3. Filter near-duplicates
    print("Filtering near-duplicates...")
    random.seed(args.seed)
    random.shuffle(deduped)  # shuffle before near-dup to avoid ordering bias
    filtered = filter_near_duplicates(deduped, args.jaccard_threshold)

    report_stats(filtered, "AFTER dedup (synthetic)")

    # 4. Load and convert external HF data
    print("\nLoading external HF materialized data...")
    external_rows: list[dict] = []

    # training_examples.jsonl
    te_path = args.external_dir / "training_examples.jsonl"
    if te_path.exists():
        count = 0
        with open(te_path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                chatml = convert_training_example_to_chatml(row)
                if chatml:
                    external_rows.append(chatml)
                    count += 1
        print(f"  training_examples.jsonl: {count} converted")

    # conversation_corpus.jsonl
    cc_path = args.external_dir / "conversation_corpus.jsonl"
    if cc_path.exists():
        count = 0
        with open(cc_path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                chatml = convert_conversation_to_chatml(row)
                if chatml:
                    external_rows.append(chatml)
                    count += 1
        print(f"  conversation_corpus.jsonl: {count} converted")

    # detector_corpus_labeled.jsonl (use labeled version)
    dc_path = args.external_dir / "detector_corpus_labeled.jsonl"
    if not dc_path.exists():
        dc_path = args.external_dir / "detector_corpus.jsonl"
    if dc_path.exists():
        count = 0
        with open(dc_path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                chatml = convert_detector_to_chatml(row)
                if chatml:
                    external_rows.append(chatml)
                    count += 1
        print(f"  detector_corpus: {count} converted")

    # sft_corpus.jsonl
    sft_path = args.external_dir / "sft_corpus.jsonl"
    if sft_path.exists():
        count = 0
        with open(sft_path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                chatml = convert_sft_to_chatml(row)
                if chatml:
                    external_rows.append(chatml)
                    count += 1
        print(f"  sft_corpus.jsonl: {count} converted")

    print(f"  Total external: {len(external_rows)}")

    # 5. Deduplicate external data
    print("\nDeduplicating external responses...")
    external_deduped = deduplicate_by_response(external_rows, args.max_repeat)
    external_filtered = filter_near_duplicates(external_deduped, args.jaccard_threshold)

    report_stats(external_filtered, "AFTER dedup (external)")

    # 6. Combine
    all_rows = filtered + external_filtered
    print(
        f"\nCombined: {len(filtered)} synthetic + {len(external_filtered)} external = {len(all_rows)}"
    )

    # 7. Final cross-corpus dedup
    print("Cross-corpus near-duplicate filtering...")
    random.shuffle(all_rows)
    final = filter_near_duplicates(all_rows, args.jaccard_threshold)

    report_stats(final, "FINAL combined")

    # 8. Split train/valid
    random.seed(args.seed)
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in final:
        group_id = str(row.get("group_id") or row.get("record_id") or content_hash(row_text(row)))
        grouped[group_id].append(row)

    train_rows: list[dict] = []
    valid_rows: list[dict] = []
    for group_id in sorted(grouped.keys()):
        bucket = int(hashlib.sha256(f"{args.seed}:{group_id}".encode()).hexdigest(), 16)
        target = valid_rows if ((bucket % 1000) / 1000.0) < args.held_out_ratio else train_rows
        target.extend(grouped[group_id])

    print(f"\nSplit: {len(train_rows)} train, {len(valid_rows)} valid")

    # 9. Write output
    train_path = args.output_dir / "train.jsonl"
    valid_path = args.output_dir / "valid.jsonl"

    with open(train_path, "w") as f:
        for row in train_rows:
            f.write(json.dumps(row) + "\n")

    with open(valid_path, "w") as f:
        for row in valid_rows:
            f.write(json.dumps(row) + "\n")

    print(f"\nWrote {train_path} ({len(train_rows)} rows)")
    print(f"Wrote {valid_path} ({len(valid_rows)} rows)")

    # 10. Write manifest
    manifest = {
        "synthetic_input": str(args.synthetic_dir),
        "external_input": str(args.external_dir),
        "max_repeat": args.max_repeat,
        "jaccard_threshold": args.jaccard_threshold,
        "held_out_ratio": args.held_out_ratio,
        "seed": args.seed,
        "counts": {
            "synthetic_raw": len(synthetic_rows),
            "synthetic_deduped": len(filtered),
            "external_raw": len(external_rows),
            "external_deduped": len(external_filtered),
            "combined": len(all_rows),
            "final": len(final),
            "train": len(train_rows),
            "valid": len(valid_rows),
        },
    }
    manifest_path = args.output_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
