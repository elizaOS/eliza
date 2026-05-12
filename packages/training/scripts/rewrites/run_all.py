"""Sweep `data/final/train.jsonl` and apply per-source structural rewrites.

Reads every record, routes by `metadata.source_dataset` to the matching
rewriter, validates the new TOON round-trips through the decoder, and writes
the result to `data/final/train_rewritten.jsonl`.

Records flagged `_needs_human_review = True` are also written to
`data/final/train_rewritten.review.jsonl` so they can be inspected separately.
The main output omits review-flagged records entirely (the trainer should not
see ambiguous shapes).

Run:
    uv run python scripts/rewrites/run_all.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.lib.toon import ToonDecoder, ToonEncoder  # noqa: E402

from scripts.rewrites import (  # noqa: E402
    agent_trove,
    mcp_routing_dataset,
    nubilio_trajectories,
    openclaw_operator,
    regularizer_reasoning_tool,
)


REWRITERS = {
    "mcp-routing-dataset": mcp_routing_dataset.rewrite,
    "openclaw-operator": openclaw_operator.rewrite,
    "nubilio-trajectories": nubilio_trajectories.rewrite,
    "regularizer-reasoning-tool": regularizer_reasoning_tool.rewrite,
    "agent-trove": agent_trove.rewrite,
}


def make_stats() -> dict[str, int]:
    return {
        "input": 0,
        "attempted": 0,
        "rewritten": 0,
        "failed": 0,
        "decode_revert": 0,
        "needs_human_review": 0,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--input",
        default=str(ROOT / "data" / "final" / "train.jsonl"),
    )
    p.add_argument(
        "--output",
        default=str(ROOT / "data" / "final" / "train_rewritten.jsonl"),
    )
    p.add_argument(
        "--review-output",
        default=str(ROOT / "data" / "final" / "train_rewritten.review.jsonl"),
    )
    p.add_argument(
        "--manifest",
        default=str(ROOT / "data" / "final" / "manifest_rewritten.json"),
    )
    p.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Process only the first N records (0 = all).",
    )
    p.add_argument(
        "--progress-every",
        type=int,
        default=50_000,
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    stats: dict[str, dict[str, int]] = {name: make_stats() for name in REWRITERS}
    timing: dict[str, float] = {name: 0.0 for name in REWRITERS}
    overall = {
        "passed_through": 0,
        "rewritten": 0,
        "dropped": 0,
        "review": 0,
        "total": 0,
    }
    samples: dict[str, list[dict[str, str]]] = {name: [] for name in REWRITERS}

    decoder = ToonDecoder()
    encoder = ToonEncoder()

    in_path = Path(args.input)
    out_path = Path(args.output)
    review_path = Path(args.review_output)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()

    with (
        in_path.open("r", encoding="utf-8") as f_in,
        out_path.open("w", encoding="utf-8") as f_out,
        review_path.open("w", encoding="utf-8") as f_review,
    ):
        for line_no, line in enumerate(f_in, start=1):
            if not line.strip():
                continue
            if args.limit and line_no > args.limit:
                break

            record = json.loads(line)
            md = record.get("metadata") or {}
            source = md.get("source_dataset")
            overall["total"] += 1

            if source in REWRITERS:
                stats[source]["input"] += 1
                stats[source]["attempted"] += 1
                t0 = time.time()
                original = record
                try:
                    rewritten = REWRITERS[source](record, decoder=decoder, encoder=encoder)
                except Exception as exc:  # noqa: BLE001
                    print(
                        f"[rewrite-error] line={line_no} source={source}: {exc!r}",
                        file=sys.stderr,
                    )
                    rewritten = None
                timing[source] += time.time() - t0

                if rewritten is None:
                    stats[source]["failed"] += 1
                    overall["dropped"] += 1
                    continue

                # Validate the rewritten expectedResponse decodes cleanly.
                # Pass-through records (rewriter returned the original) skip
                # this check — they didn't change the TOON.
                if rewritten.get("expectedResponse") != original.get(
                    "expectedResponse"
                ):
                    try:
                        decoder.decode(rewritten["expectedResponse"])
                    except Exception as exc:  # noqa: BLE001
                        print(
                            f"[decode-revert] line={line_no} source={source}: {exc!r}",
                            file=sys.stderr,
                        )
                        stats[source]["decode_revert"] += 1
                        rewritten = original

                new_md = rewritten.get("metadata") or {}
                if new_md.get("_needs_human_review"):
                    stats[source]["needs_human_review"] += 1
                    overall["review"] += 1
                    f_review.write(json.dumps(rewritten, ensure_ascii=False) + "\n")
                    continue

                if rewritten is not original:
                    stats[source]["rewritten"] += 1
                    overall["rewritten"] += 1
                    if len(samples[source]) < 3:
                        samples[source].append(
                            {
                                "before": original.get("expectedResponse", "")[:1500],
                                "after": rewritten.get("expectedResponse", "")[:1500],
                                "before_task_type": (
                                    original.get("metadata") or {}
                                ).get("task_type"),
                                "after_task_type": new_md.get("task_type"),
                                "currentMessage_after": (
                                    rewritten.get("currentMessage") or {}
                                ).get("content", "")[:300],
                            }
                        )
                else:
                    overall["passed_through"] += 1

                f_out.write(json.dumps(rewritten, ensure_ascii=False) + "\n")
            else:
                overall["passed_through"] += 1
                f_out.write(line if line.endswith("\n") else line + "\n")

            if line_no % args.progress_every == 0:
                elapsed = time.time() - started
                rate = line_no / elapsed if elapsed > 0 else 0.0
                print(
                    f"[progress] {line_no:>9} records  elapsed={elapsed:7.1f}s  rate={rate:6.0f}/s",
                    file=sys.stderr,
                )

    decoder.close()
    encoder.close()

    elapsed_total = time.time() - started

    manifest = {
        "input": str(in_path),
        "output": str(out_path),
        "review_output": str(review_path),
        "elapsed_seconds": round(elapsed_total, 2),
        "overall": overall,
        "per_source": {
            name: {**stats[name], "elapsed_seconds": round(timing[name], 2)}
            for name in REWRITERS
        },
        "samples": samples,
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"\n[done] wrote {out_path}")
    print(f"[done] manifest at {args.manifest}")
    print(f"[done] review records at {review_path}")
    print(json.dumps({"overall": overall}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
