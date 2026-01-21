#!/usr/bin/env python3
"""
AI-label eligible dating pairs (from filtered match matrix) as good/bad/neutral.
Uses LLM to classify based on persona signals. Outputs expanded curated benchmarks.
"""
from __future__ import annotations

import argparse
import _bootstrap  # noqa: F401
import json
import os
import random
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple

from matcher.io import load_json


def _chat(base_url: str, api_key: str, model: str, messages: List[Dict[str, str]], max_tokens: int = 2000) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.3}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "matching-label/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    choices = data.get("choices", [])
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message", {})
        return msg.get("content", "") or msg.get("reasoning", "")
    return ""


def _persona_summary(p: Dict[str, object]) -> str:
    pid = p.get("id", "?")
    req = p.get("required", {})
    opt = p.get("optional", {})
    name = req.get("name", "?")
    age = req.get("age", "?")
    loc = req.get("location", {})
    city = loc.get("city", "?")

    gender = opt.get("genderIdentity", "?")
    orientation = opt.get("sexualOrientation", "?")
    goal = opt.get("relationshipGoal", "?")
    comm = opt.get("communicationStyle", "?")
    interests = opt.get("interests", [])
    dealbreakers = opt.get("dealbreakers", [])
    values = opt.get("values", [])
    
    dp = opt.get("datingPreferences", {})
    pref_genders = dp.get("preferredGenders", [])
    pref_age_min = dp.get("preferredAgeMin", "?")
    pref_age_max = dp.get("preferredAgeMax", "?")
    monogamy = dp.get("monogamy", "?")
    wants_kids = dp.get("wantsKids", "?")
    
    lifestyle = opt.get("lifestyle", {})
    drinking = lifestyle.get("drinking", "?")
    fitness = lifestyle.get("fitness", "?")
    
    lines = [
        f"{pid}: {name}, {age}, {city}",
        f"  Gender: {gender}, Orientation: {orientation}",
        f"  Seeking: {pref_genders}, ages {pref_age_min}-{pref_age_max}",
        f"  Goal: {goal}, Communication: {comm}",
        f"  Monogamy: {monogamy}, Wants kids: {wants_kids}",
        f"  Interests: {interests}",
        f"  Values: {values}",
        f"  Dealbreakers: {dealbreakers}",
        f"  Lifestyle: drinking={drinking}, fitness={fitness}",
    ]
    return "\n".join(lines)


def _label_batch(
    base_url: str,
    api_key: str,
    model: str,
    pairs: List[Tuple[str, str, int]],
    by_id: Dict[str, Dict[str, object]],
) -> List[Dict[str, object]]:
    """Label a batch of pairs. Returns list of {a, b, label, reason}."""
    
    pair_texts = []
    for i, (a, b, score) in enumerate(pairs):
        pa = by_id.get(a, {})
        pb = by_id.get(b, {})
        pair_texts.append(f"--- PAIR {i+1} (baseline score: {score}) ---\nPerson A:\n{_persona_summary(pa)}\n\nPerson B:\n{_persona_summary(pb)}")
    
    prompt = f"""You are evaluating dating compatibility for {len(pairs)} pairs. All pairs have already passed hard filters (gender/age preferences are compatible).

## COMPATIBILITY RULES

**Relationship Goal** (commitment level) - MUST MATCH:
- casual ↔ long_term = INCOMPATIBLE (BAD)
- casual ↔ serious_but_slow = INCOMPATIBLE (BAD)
- exploring ↔ long_term = INCOMPATIBLE (BAD)
- exploring ↔ serious_but_slow = INCOMPATIBLE (BAD)
- Same goal or exploring ↔ casual = COMPATIBLE

**Kids Preference** (SEPARATE dimension):
- wantsKids='yes' ↔ wantsKids='no' = INCOMPATIBLE (BAD)
- 'open' or 'unsure' is compatible with anything
- Note: Goal and kids are independent. Someone can want long_term + no kids.

**Monogamy**:
- yes ↔ no = INCOMPATIBLE (BAD)
- 'flexible' or null = compatible with either

For each pair, classify as:
- GOOD: Compatible goals AND kids AND monogamy, plus positive signals (shared interests, values, lifestyle)
- BAD: Any hard conflict (goal mismatch, kids conflict, monogamy conflict) OR multiple negative signals
- NEUTRAL: Compatible on hard factors but no strong positive/negative signals

{chr(10).join(pair_texts)}

Respond with a JSON array (no markdown):
[
  {{"pair": 1, "a": "ID", "b": "ID", "label": "GOOD|BAD|NEUTRAL", "reason": "brief explanation"}},
  ...
]"""

    messages = [{"role": "user", "content": prompt}]
    resp = _chat(base_url, api_key, model, messages, max_tokens=4000)
    
    # Parse JSON from response
    resp = resp.strip()
    if resp.startswith("```"):
        resp = resp.split("\n", 1)[1] if "\n" in resp else resp[3:]
        if resp.endswith("```"):
            resp = resp[:-3]
        resp = resp.strip()
    
    results: List[Dict[str, object]] = []
    parsed = json.loads(resp)
    for item in parsed:
        idx = item.get("pair", 0) - 1
        if 0 <= idx < len(pairs):
            a, b, _ = pairs[idx]
            results.append({
                "a": a,
                "b": b,
                "label": item.get("label", "NEUTRAL"),
                "reason": item.get("reason", ""),
            })
    return results


def main() -> None:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise SystemExit("Set GROQ_API_KEY")

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="openai/gpt-oss-120b")
    parser.add_argument("--base-url", default="https://api.groq.com/openai/v1")
    parser.add_argument("--sample", type=int, default=100, help="Number of pairs to sample and label")
    parser.add_argument("--batch", type=int, default=10, help="Pairs per LLM call")
    parser.add_argument("--out", default="data/dating/benchmarks_curated.json")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    d = root / "data" / "dating"

    # Load personas
    sf = load_json(d / "personas_sf.json")
    ny = load_json(d / "personas_ny.json")
    personas = sf + ny
    by_id: Dict[str, Dict[str, object]] = {p["id"]: p for p in personas if isinstance(p, dict)}

    # Load matrix scores (only eligible pairs)
    matrix = load_json(d / "match_matrix.json")
    scores: Dict[str, Dict[str, int]] = matrix["scores"]

    # Collect all eligible pairs with scores
    all_pairs: List[Tuple[str, str, int]] = []
    seen: set[frozenset[str]] = set()
    for a, row in scores.items():
        for b, score in row.items():
            pair = frozenset({a, b})
            if pair not in seen:
                seen.add(pair)
                all_pairs.append((a, b, score))

    print(f"Total eligible pairs: {len(all_pairs)}")

    # Sample pairs with bias toward extremes (high and low scores)
    all_pairs.sort(key=lambda x: x[2])
    n = min(args.sample, len(all_pairs))
    
    # Take some from bottom, some from top, some from middle
    bottom = all_pairs[:n // 3]
    top = all_pairs[-(n // 3):]
    middle = all_pairs[n // 3: -(n // 3)]
    random.shuffle(middle)
    middle = middle[:n - len(bottom) - len(top)]
    
    sampled = bottom + middle + top
    random.shuffle(sampled)
    print(f"Sampled {len(sampled)} pairs for labeling")

    # Label in batches
    all_labels: List[Dict[str, object]] = []
    for i in range(0, len(sampled), args.batch):
        batch = sampled[i:i + args.batch]
        print(f"Labeling batch {i // args.batch + 1}/{(len(sampled) + args.batch - 1) // args.batch}...")
        labels = _label_batch(args.base_url, api_key, args.model, batch, by_id)
        all_labels.extend(labels)

    # Separate into good/bad
    good_pairs: List[Dict[str, object]] = []
    bad_pairs: List[Dict[str, object]] = []
    neutral_count = 0

    for item in all_labels:
        label = item.get("label", "").upper()
        entry = {
            "a": item["a"],
            "b": item["b"],
            "expectedScoreRange": [50, 100] if label == "GOOD" else [-100, 20] if label == "BAD" else [-50, 50],
            "reason": item.get("reason", ""),
        }
        if label == "GOOD":
            good_pairs.append(entry)
        elif label == "BAD":
            bad_pairs.append(entry)
        else:
            neutral_count += 1

    print(f"\nLabeling results:")
    print(f"  GOOD: {len(good_pairs)}")
    print(f"  BAD: {len(bad_pairs)}")
    print(f"  NEUTRAL: {neutral_count}")

    # Output curated benchmarks
    out_path = root / args.out
    output = {
        "domain": "dating",
        "description": "AI-labeled benchmark pairs from eligible matches. GOOD = high likelihood of success, BAD = low likelihood despite passing hard filters.",
        "goodPairs": good_pairs,
        "badPairs": bad_pairs,
    }
    out_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {len(good_pairs)} good + {len(bad_pairs)} bad pairs to {out_path}")


if __name__ == "__main__":
    main()
