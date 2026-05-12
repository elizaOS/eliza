"""Verifiable reward function for the eliza-1 GRPO stage.

Per RL_STRATEGY.md the reward is a clamped weighted sum of:

  format_ok    (0/1)   — eliza_bench TOON parser succeeds + required fields present.
  content_ok   (0/1)   — eliza_bench scorer's action-name / RESPOND-IGNORE / text check.
  length       (-0.2..0)— heuristic token-length penalty (target 50-500 tokens).
  ai_judge     (0/1)   — optional Claude judge call (gated on ELIZA_REWARD_USE_AI_JUDGE=1).

Weights default to (0.4, 0.4, 0.1, 0.1) to match the reward weights table in
RL_STRATEGY.md (verifiable correctness primary, heuristics secondary, AI judge
capped). Final reward is clamped to [-1, 1].

Importable as:
    from scripts.eliza_reward_fn import compute_reward
    r = compute_reward(prompt, response, ground_truth={"task_type": ..., "expected": ...})

Standalone CLI for verl reward-server use:
    python scripts/eliza_reward_fn.py \\
        --prompt-jsonl prompts.jsonl \\
        --responses-jsonl responses.jsonl \\
        --out results.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from benchmark.eliza_bench import (  # noqa: E402
    classify,
    score_claude_distill,
    score_message_handler,
    score_reply,
    score_should_respond,
)
from benchmark.toon_parser import parse as parse_toon  # noqa: E402

log = logging.getLogger("eliza-reward")


# ───────────────────────────── tunables ─────────────────────────────

# Defaults match RL_STRATEGY.md "Reward signal design" section. Verifiable
# correctness is the primary signal (format + content together are 0.8 of
# the gross), heuristic length shaping and the optional AI judge each cap
# at 0.1 so a single noisy signal can't dominate the gradient.
DEFAULT_WEIGHTS: dict[str, float] = {
    "format": 0.4,
    "content": 0.4,
    "length": 0.1,
    "ai_judge": 0.1,
}

# Token-length sweet spot for TOON action documents. Anything inside the band
# is neutral (0); short responses get a mild penalty (-0.2..0); long
# responses get a stronger penalty (-0.2..0). The penalty is bounded so a
# correct-but-slightly-long response can't go negative on length alone.
LENGTH_TARGET_LO = 50
LENGTH_TARGET_HI = 500
LENGTH_PENALTY_FLOOR = -0.2

AI_JUDGE_MODEL_ENV = "ELIZA_REWARD_AI_JUDGE_MODEL"
AI_JUDGE_DEFAULT_MODEL = "claude-haiku-4-5-20251001"


# ───────────────────────────── components ─────────────────────────────

@dataclass
class RewardComponents:
    """Per-call breakdown so verl/wandb can log individual signals."""

    format_ok: float = 0.0
    content_ok: float = 0.0
    length_score: float = 0.0
    ai_judge_score: float | None = None
    weighted_sum: float = 0.0
    final: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format_ok": self.format_ok,
            "content_ok": self.content_ok,
            "length_score": self.length_score,
            "ai_judge_score": self.ai_judge_score,
            "weighted_sum": self.weighted_sum,
            "final": self.final,
            "notes": self.notes,
        }


# ───────────────────────────── verifiable scoring ─────────────────────────────

def _score_verifiable(
    response: str,
    ground_truth: dict[str, Any] | None,
) -> tuple[float, float, list[str]]:
    """Run eliza_bench's bucket-aware scorer. Returns (format_ok, content_ok, notes)."""

    notes: list[str] = []
    if not ground_truth:
        # No ground truth: we can still verify format (TOON parses + has at
        # least one key) but can't verify content. Treat content as neutral
        # (0.5) so the optimizer isn't told the response is wrong when we
        # simply don't know.
        parsed = parse_toon(response)
        fmt = 1.0 if (parsed.ok and parsed.document) else 0.0
        notes.append("no_ground_truth")
        return fmt, 0.5, notes

    # Construct an eliza-style record so eliza_bench.classify works.
    bucket = ground_truth.get("bucket")
    if not bucket:
        synthetic = {"metadata": {"task_type": ground_truth.get("task_type", "")}}
        bucket = classify(synthetic)

    expected = ground_truth.get("expected") or ground_truth.get("expectedResponse") or ""

    if bucket == "claude_distill":
        ok_fmt, ok_content, _ = score_claude_distill(response, str(expected))
        return float(ok_fmt), float(ok_content), notes

    if bucket not in ("should_respond", "message_handler", "reply"):
        # Unknown task type — score format only.
        parsed = parse_toon(response)
        fmt = 1.0 if (parsed.ok and parsed.document) else 0.0
        notes.append(f"unknown_bucket:{bucket}")
        return fmt, 0.5, notes

    pred = parse_toon(response)
    exp = parse_toon(str(expected))
    scorer = {
        "should_respond": score_should_respond,
        "message_handler": score_message_handler,
        "reply": score_reply,
    }[bucket]
    ok_fmt, ok_content, _ = scorer(pred.document, exp.document)
    return float(ok_fmt), float(ok_content), notes


# ───────────────────────────── length heuristic ─────────────────────────────

_TOKEN_RE = re.compile(r"\S+")


def _length_score(response: str) -> float:
    """Cheap word-count proxy for token count.

    Returns a value in [LENGTH_PENALTY_FLOOR, 0]. We never reward extra length —
    the verifiable signal already captures correctness; this only penalizes
    pathological short or long outputs that game format checks.
    """

    n = len(_TOKEN_RE.findall(response or ""))
    if LENGTH_TARGET_LO <= n <= LENGTH_TARGET_HI:
        return 0.0
    if n < LENGTH_TARGET_LO:
        # Linearly interpolate from -0.2 at n=0 to 0 at n=LO.
        frac = n / max(LENGTH_TARGET_LO, 1)
        return LENGTH_PENALTY_FLOOR * (1.0 - frac)
    # n > HI: ramp to floor at 4× target.
    over = (n - LENGTH_TARGET_HI) / max(LENGTH_TARGET_HI * 3, 1)
    return max(LENGTH_PENALTY_FLOOR, LENGTH_PENALTY_FLOOR * min(over, 1.0))


# ───────────────────────────── AI judge ─────────────────────────────

_AI_JUDGE_PROMPT = """You are scoring an autonomous agent's TOON-format response.

Prompt context:
{prompt}

Ground truth (expected response):
{expected}

Model response:
{response}

Is the model response correct given the prompt and ground truth?
Reply with exactly one token: YES or NO.
"""


def _ai_judge_score(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
) -> float | None:
    """Optional Claude judge. Returns None when disabled or unreachable."""

    if os.environ.get("ELIZA_REWARD_USE_AI_JUDGE", "0") != "1":
        return None
    if not ground_truth:
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic SDK not installed; skipping AI judge")
        return None
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.warning("ANTHROPIC_API_KEY unset; skipping AI judge")
        return None

    expected = ground_truth.get("expected") or ground_truth.get("expectedResponse") or ""
    body = _AI_JUDGE_PROMPT.format(
        prompt=(prompt or "")[:2000],
        expected=str(expected)[:1000],
        response=(response or "")[:2000],
    )
    client = anthropic.Anthropic(api_key=api_key)
    model = os.environ.get(AI_JUDGE_MODEL_ENV, AI_JUDGE_DEFAULT_MODEL)
    resp = client.messages.create(
        model=model,
        max_tokens=4,
        messages=[{"role": "user", "content": body}],
    )
    text = ""
    for block in resp.content:
        if getattr(block, "type", "") == "text":
            text += getattr(block, "text", "")
    text = text.strip().upper()
    if text.startswith("YES"):
        return 1.0
    if text.startswith("NO"):
        return 0.0
    log.warning("ai_judge unparseable verdict: %r", text)
    return None


# ───────────────────────────── public API ─────────────────────────────

def compute_reward_components(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
    *,
    weights: dict[str, float] | None = None,
) -> RewardComponents:
    w = weights or DEFAULT_WEIGHTS
    out = RewardComponents()

    out.format_ok, out.content_ok, notes = _score_verifiable(response, ground_truth)
    out.notes.extend(notes)
    out.length_score = _length_score(response)
    out.ai_judge_score = _ai_judge_score(prompt, response, ground_truth)

    weighted = (
        w.get("format", 0.0) * out.format_ok
        + w.get("content", 0.0) * out.content_ok
        + w.get("length", 0.0) * out.length_score
    )
    if out.ai_judge_score is not None:
        weighted += w.get("ai_judge", 0.0) * out.ai_judge_score
    out.weighted_sum = weighted

    out.final = max(-1.0, min(1.0, weighted))
    return out


def compute_reward(
    prompt: str,
    response: str,
    ground_truth: dict[str, Any] | None,
    *,
    weights: dict[str, float] | None = None,
) -> float:
    """Scalar reward in [-1, 1]. Importable from verl's reward-fn registry."""

    return compute_reward_components(
        prompt, response, ground_truth, weights=weights,
    ).final


# verl's `reward_score.compute_score` registry expects a callable named
# `compute_score(data_source, solution_str, ground_truth, extra_info)`. Wrap
# our function so verl can import it directly.
def compute_score(
    data_source: str,
    solution_str: str,
    ground_truth: Any,
    extra_info: Any = None,
) -> float:
    gt: dict[str, Any] | None
    if isinstance(ground_truth, dict):
        gt = ground_truth
    elif isinstance(ground_truth, str):
        gt = {"expected": ground_truth, "task_type": data_source or ""}
    else:
        gt = None
    prompt = ""
    if isinstance(extra_info, dict):
        prompt = str(extra_info.get("prompt") or "")
    return compute_reward(prompt, solution_str, gt)


# ───────────────────────────── CLI ─────────────────────────────

def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-jsonl", required=True,
                    help="JSONL of {id, prompt, ground_truth} rows.")
    ap.add_argument("--responses-jsonl", required=True,
                    help="JSONL of {id, response} rows. Joined to prompts by id.")
    ap.add_argument("--out", required=True,
                    help="Output JSON file with per-row + aggregate scores.")
    ap.add_argument("--weight-format", type=float, default=DEFAULT_WEIGHTS["format"])
    ap.add_argument("--weight-content", type=float, default=DEFAULT_WEIGHTS["content"])
    ap.add_argument("--weight-length", type=float, default=DEFAULT_WEIGHTS["length"])
    ap.add_argument("--weight-judge", type=float, default=DEFAULT_WEIGHTS["ai_judge"])
    args = ap.parse_args()

    weights = {
        "format": args.weight_format,
        "content": args.weight_content,
        "length": args.weight_length,
        "ai_judge": args.weight_judge,
    }
    prompts = {row["id"]: row for row in _load_jsonl(Path(args.prompt_jsonl))}
    responses = _load_jsonl(Path(args.responses_jsonl))

    rows: list[dict[str, Any]] = []
    total = 0.0
    for r in responses:
        rid = r["id"]
        p = prompts.get(rid)
        if not p:
            continue
        comps = compute_reward_components(
            p.get("prompt", ""),
            r.get("response", ""),
            p.get("ground_truth"),
            weights=weights,
        )
        rows.append({"id": rid, "components": comps.to_dict()})
        total += comps.final

    avg = total / len(rows) if rows else 0.0
    payload = {
        "weights": weights,
        "n": len(rows),
        "mean_reward": avg,
        "rows": rows,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2))
    print(json.dumps({"n": len(rows), "mean_reward": round(avg, 4)}))
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
    )
    sys.exit(main())
