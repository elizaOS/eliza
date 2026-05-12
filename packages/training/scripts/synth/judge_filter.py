"""Pre-training quality filter for synthetic trajectories.

Wraps the GRPO reward function (`scripts/eliza_reward_fn.py`) as a per-record
filter that routes each synth trajectory to a `--output-keep` or
`--output-reject` JSONL. Closes M7 / W1-S3 in
`docs/eliza-1-pipeline/{02-gap-analysis.md, 03-implementation-plan.md}`.

Why this exists
---------------
The reward function is correctness-aware: TOON format check + bucket-specific
content check (`should_respond`, `message_handler`, `reply`, `claude_distill`),
length shaping, and optional Claude AI judge. During RL it scores rollouts.
Here we run it offline against synth output (e.g. Together-synth or
drive_eliza output) to drop low-quality records *before* SFT. No silent
drops — every reject is written to the reject file with the score, the
reward-component breakdown, and a human-readable reason.

Input shape
-----------
Each input line is a synth trajectory record. Accepted variants:

  1. nubilio shape (together_synth + drive_eliza output):
       {
         "messages": [
           {"role": "system", "content": "..."},
           {"role": "user", "content": "..."},
           {"role": "model" | "assistant", "content": "<TOON response>"}
         ],
         "task_id": "...",
         "task_type": "should_respond" | "message_handler" | "reply" | ...
       }

  2. raw-eliza record (`format_for_training.py` ingest shape):
       {
         "currentMessage": {"content": "..."},
         "expectedResponse": "<TOON response>",   # treated as both prompt and gt
         "metadata": {"task_type": "..."},
         ...
       }

Either shape is fine. The filter pulls:
  - the user prompt (the human turn the model is responding to),
  - the model response (the trajectory's actual training target),
  - the bucket / task_type (drives which `eliza_bench` scorer runs).

If the record carries an explicit ground truth (`expectedResponse`, or a
sibling `ground_truth` block), it's passed through so the verifiable content
check has something to compare against. Without ground truth we still run
format + length + optional AI judge — but the threshold should account for
the reduced ceiling (verifiable content collapses to a neutral 0.5).

Output
------
- `--output-keep`: records that scored at or above the threshold. Each kept
  record gets a `judge_score: <float>` added to its top-level (and mirrored
  into `metadata.judge_score` when a metadata block exists, so downstream
  transforms can read it). The reward-component breakdown is attached as
  `judge_components` for traceability.
- `--output-reject`: records that scored below the threshold OR could not be
  scored. Each rejected record has the same `judge_score` / `judge_components`
  fields, plus a `judge_reject_reason` string ("below_threshold:0.42" /
  "no_model_response" / "no_user_prompt" / "scoring_failed:<exc>").

CLI
---
    python -m synth.judge_filter \
        --input data/synthesized/together-synth/should_respond_trajectories.jsonl \
        --output-keep data/synthesized/together-synth/should_respond.keep.jsonl \
        --output-reject data/synthesized/together-synth/should_respond.reject.jsonl \
        --threshold 0.5

Strong typing
-------------
Every record passes through dataclasses (`SynthRecord`, `JudgeOutcome`); no
silent drops. Records that fail to parse are surfaced as `reject_reason=
"parse_failed:..."`. Records with no model response are rejected with
`no_model_response`. Records with no user prompt are rejected with
`no_user_prompt`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]  # packages/training/scripts/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_reward_fn import (  # noqa: E402
    RewardComponents,
    compute_reward_components,
)

log = logging.getLogger("synth.judge_filter")


# ───────────────────────────── extraction ─────────────────────────────


@dataclass(frozen=True)
class ExtractedRecord:
    """The four pieces the reward function needs, lifted from a synth record."""

    prompt: str
    response: str
    task_type: str
    ground_truth: dict[str, Any] | None


def _last_user_message(messages: list[dict[str, Any]]) -> str:
    """Return the last `role: user` message's content, or empty string."""
    for msg in reversed(messages):
        if str(msg.get("role")) == "user":
            return str(msg.get("content") or "")
    return ""


def _last_model_message(messages: list[dict[str, Any]]) -> str:
    """Return the last `role: model` / `role: assistant` content, or empty.

    `together_synth.py` writes `role: model` (per the nubilio canonical shape);
    other producers write `role: assistant`. Accept both.
    """
    for msg in reversed(messages):
        role = str(msg.get("role"))
        if role in ("model", "assistant"):
            return str(msg.get("content") or "")
    return ""


def _extract_task_type(record: dict[str, Any]) -> str:
    """Resolve the `task_type` used to pick the bucket-specific scorer."""
    explicit = record.get("task_type")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    metadata = record.get("metadata")
    if isinstance(metadata, dict):
        t = metadata.get("task_type") or metadata.get("taskType")
        if isinstance(t, str) and t.strip():
            return t.strip()
    benchmark = record.get("benchmark")
    if isinstance(benchmark, str) and benchmark.startswith("synth-"):
        return benchmark[len("synth-"):].strip()
    return ""


def _extract_ground_truth(record: dict[str, Any], task_type: str) -> dict[str, Any] | None:
    """Build the `ground_truth` block the reward function expects, if available.

    Synth records produced by the eliza-driver loop come with an
    `expectedResponse` (the gold trajectory shape from the agent run). Some
    transforms also carry an explicit `ground_truth` block. If neither is
    present we return `None`, and the reward function falls back to format-only
    verifiable scoring (content stays at the neutral 0.5).
    """
    gt = record.get("ground_truth")
    if isinstance(gt, dict):
        # Normalize to ensure task_type is set so eliza_bench.classify works.
        out = dict(gt)
        out.setdefault("task_type", task_type)
        return out
    expected = record.get("expectedResponse") or record.get("expected_response")
    if isinstance(expected, str) and expected.strip():
        return {"task_type": task_type, "expected": expected}
    return None


def extract_record(record: dict[str, Any]) -> ExtractedRecord:
    """Lift the prompt / response / task_type / ground_truth from a synth record.

    Accepts the nubilio `{messages: [...]}` shape and the raw-eliza
    `{currentMessage, expectedResponse, metadata}` shape. Other producers can
    add support by ensuring at least one user-role message + one model-role
    message is present, or by surfacing a top-level `prompt` / `response`.
    """
    task_type = _extract_task_type(record)
    ground_truth = _extract_ground_truth(record, task_type)

    # 1. Top-level `prompt` / `response` (cheapest path).
    prompt_top = record.get("prompt")
    response_top = record.get("response")
    if isinstance(prompt_top, str) and isinstance(response_top, str):
        return ExtractedRecord(
            prompt=prompt_top,
            response=response_top,
            task_type=task_type,
            ground_truth=ground_truth,
        )

    # 2. Nubilio `messages: [...]` shape.
    messages = record.get("messages")
    if isinstance(messages, list):
        return ExtractedRecord(
            prompt=_last_user_message(messages),
            response=_last_model_message(messages),
            task_type=task_type,
            ground_truth=ground_truth,
        )

    # 3. Raw-eliza shape (`currentMessage.content` + `expectedResponse`). Here
    #    the response IS the ground-truth expected — scoring still tells us
    #    whether the synth target is well-formed and on-task, which is what we
    #    want pre-SFT.
    current = record.get("currentMessage")
    prompt = ""
    if isinstance(current, dict):
        c = current.get("content")
        if isinstance(c, str):
            prompt = c
    expected = record.get("expectedResponse") or record.get("expected_response")
    if isinstance(expected, str):
        return ExtractedRecord(
            prompt=prompt,
            response=expected,
            task_type=task_type,
            ground_truth=ground_truth,
        )

    # Nothing usable.
    return ExtractedRecord(
        prompt=prompt,
        response="",
        task_type=task_type,
        ground_truth=ground_truth,
    )


# ───────────────────────────── judging ─────────────────────────────


@dataclass
class JudgeOutcome:
    """Final keep/reject decision and the score that drove it."""

    keep: bool
    score: float
    components: RewardComponents
    reason: str = ""

    def to_components_dict(self) -> dict[str, Any]:
        return self.components.to_dict()


JudgeFn = Callable[[str, str, dict[str, Any] | None], RewardComponents]


def judge_record(
    record: dict[str, Any],
    *,
    threshold: float,
    judge_fn: JudgeFn = compute_reward_components,
) -> JudgeOutcome:
    """Score one record and decide keep/reject.

    Rejection reasons:
      - `no_model_response`     — record has no extractable model output.
      - `no_user_prompt`        — record has no extractable user prompt
                                  (rare; only blocks scoring for buckets that
                                  depend on prompt context).
      - `below_threshold:<s>`   — scored, but final reward < threshold.
      - `scoring_failed:<exc>`  — the reward function raised; the record is
                                  rejected so a broken scorer never lets bad
                                  data through. Components are zero-filled.
    """
    extracted = extract_record(record)

    if not extracted.response.strip():
        return JudgeOutcome(
            keep=False,
            score=float("-inf"),
            components=RewardComponents(notes=["no_model_response"]),
            reason="no_model_response",
        )
    if not extracted.prompt.strip():
        # Prompt is required by the AI judge and by some bucket scorers; treat
        # as a hard reject rather than silently scoring against an empty string.
        return JudgeOutcome(
            keep=False,
            score=float("-inf"),
            components=RewardComponents(notes=["no_user_prompt"]),
            reason="no_user_prompt",
        )

    try:
        components = judge_fn(
            extracted.prompt, extracted.response, extracted.ground_truth,
        )
    except Exception as exc:  # noqa: BLE001 — never let a scoring bug pass
                              # through; route the record to reject with the
                              # exception captured.
        return JudgeOutcome(
            keep=False,
            score=float("-inf"),
            components=RewardComponents(notes=[f"scoring_failed:{exc!r}"]),
            reason=f"scoring_failed:{type(exc).__name__}:{exc}",
        )

    score = float(components.final)
    keep = score >= threshold
    reason = "" if keep else f"below_threshold:{score:.4f}"
    return JudgeOutcome(keep=keep, score=score, components=components, reason=reason)


# ───────────────────────────── tagging / routing ─────────────────────────────


def tag_kept(record: dict[str, Any], outcome: JudgeOutcome) -> dict[str, Any]:
    """Return a copy of `record` with `judge_score` / `judge_components` set.

    Mirrors `judge_score` into `metadata.judge_score` when a metadata dict
    exists, so downstream transforms that filter on metadata can read it.
    """
    out = dict(record)
    out["judge_score"] = outcome.score
    out["judge_components"] = outcome.to_components_dict()
    metadata = out.get("metadata")
    if isinstance(metadata, dict):
        new_metadata = dict(metadata)
        new_metadata["judge_score"] = outcome.score
        out["metadata"] = new_metadata
    return out


def tag_rejected(record: dict[str, Any], outcome: JudgeOutcome) -> dict[str, Any]:
    """Return a copy of `record` with reject-side metadata for review.

    Stores the score (may be `-inf` for unscoreable records), the components
    breakdown, and a human-readable `judge_reject_reason`.
    """
    out = dict(record)
    # `-inf` is not JSON-encodable as a number in the canonical sense; store
    # the raw value as a string sentinel so the reject file stays valid JSON.
    score: Any = outcome.score
    if score == float("-inf") or score == float("inf"):
        score = "unscored"
    out["judge_score"] = score
    out["judge_components"] = outcome.to_components_dict()
    out["judge_reject_reason"] = outcome.reason
    return out


# ───────────────────────────── stream driver ─────────────────────────────


@dataclass
class FilterStats:
    """Per-run counters surfaced to stdout + summary JSON."""

    seen: int = 0
    kept: int = 0
    rejected: int = 0
    parse_failed: int = 0
    reject_reasons: dict[str, int] = field(default_factory=dict)
    score_sum_kept: float = 0.0

    def mean_score_kept(self) -> float:
        return self.score_sum_kept / self.kept if self.kept else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "seen": self.seen,
            "kept": self.kept,
            "rejected": self.rejected,
            "parse_failed": self.parse_failed,
            "mean_score_kept": round(self.mean_score_kept(), 4),
            "reject_reasons": dict(self.reject_reasons),
        }


def filter_stream(
    input_path: Path,
    keep_path: Path,
    reject_path: Path,
    *,
    threshold: float,
    judge_fn: JudgeFn = compute_reward_components,
) -> FilterStats:
    """Stream `input_path` → split into keep/reject JSONL files.

    Returns a populated `FilterStats`. Caller is responsible for printing /
    persisting the summary; this function only writes the two JSONL files.
    """
    stats = FilterStats()
    keep_path.parent.mkdir(parents=True, exist_ok=True)
    reject_path.parent.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", encoding="utf-8") as in_f, \
            keep_path.open("w", encoding="utf-8") as keep_f, \
            reject_path.open("w", encoding="utf-8") as reject_f:
        for line_no, raw_line in enumerate(in_f, start=1):
            line = raw_line.strip()
            if not line:
                continue
            stats.seen += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                # Parse failure: write the raw line into reject with a parse
                # error wrapper so nothing is silently dropped.
                stats.parse_failed += 1
                stats.rejected += 1
                reason = f"parse_failed:line_{line_no}:{exc.msg}"
                stats.reject_reasons[reason] = stats.reject_reasons.get(reason, 0) + 1
                reject_f.write(json.dumps({
                    "raw_line": line,
                    "judge_score": "unscored",
                    "judge_components": RewardComponents().to_dict(),
                    "judge_reject_reason": reason,
                }, ensure_ascii=False) + "\n")
                continue
            if not isinstance(record, dict):
                # Top-level non-object — treat like a parse failure for routing.
                stats.parse_failed += 1
                stats.rejected += 1
                reason = "parse_failed:non_object"
                stats.reject_reasons[reason] = stats.reject_reasons.get(reason, 0) + 1
                reject_f.write(json.dumps({
                    "raw_value": record,
                    "judge_score": "unscored",
                    "judge_components": RewardComponents().to_dict(),
                    "judge_reject_reason": reason,
                }, ensure_ascii=False) + "\n")
                continue

            outcome = judge_record(record, threshold=threshold, judge_fn=judge_fn)
            if outcome.keep:
                stats.kept += 1
                stats.score_sum_kept += outcome.score
                tagged = tag_kept(record, outcome)
                keep_f.write(json.dumps(tagged, ensure_ascii=False) + "\n")
            else:
                stats.rejected += 1
                stats.reject_reasons[outcome.reason] = (
                    stats.reject_reasons.get(outcome.reason, 0) + 1
                )
                tagged = tag_rejected(record, outcome)
                reject_f.write(json.dumps(tagged, ensure_ascii=False) + "\n")
    return stats


# ───────────────────────────── CLI ─────────────────────────────


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="synth.judge_filter",
        description="LLM-judge pre-training filter for synthetic trajectories "
                    "(closes M7 / W1-S3).",
    )
    p.add_argument(
        "--input", type=Path, required=True,
        help="JSONL of synth records to filter.",
    )
    p.add_argument(
        "--output-keep", type=Path, required=True,
        help="JSONL written with records whose judge score >= --threshold.",
    )
    p.add_argument(
        "--output-reject", type=Path, required=True,
        help="JSONL written with rejected records, each tagged with score + "
             "reject reason. No record is ever silently dropped.",
    )
    p.add_argument(
        "--threshold", type=float, default=0.5,
        help="Keep records whose final reward is >= threshold. Default 0.5.",
    )
    p.add_argument(
        "--summary", type=Path, default=None,
        help="Optional path to write the run summary JSON (counts, reasons). "
             "If omitted, summary is printed to stdout only.",
    )
    p.add_argument(
        "--log-level", default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    if not args.input.exists():
        log.error("input not found: %s", args.input)
        return 2
    if args.threshold < -1.0 or args.threshold > 1.0:
        # The reward function clamps to [-1, 1]; a threshold outside that band
        # is a configuration error, not a data issue.
        log.error("threshold %s outside reward range [-1, 1]", args.threshold)
        return 2

    stats = filter_stream(
        args.input, args.output_keep, args.output_reject,
        threshold=args.threshold,
    )
    summary = {
        "input": str(args.input),
        "output_keep": str(args.output_keep),
        "output_reject": str(args.output_reject),
        "threshold": args.threshold,
        **stats.to_dict(),
    }
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
