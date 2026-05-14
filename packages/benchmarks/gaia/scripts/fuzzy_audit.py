"""
GAIA fuzzy-scorer false-positive audit.

Runs both the strict and the legacy fuzzy-enabled GAIA evaluator on a set of
synthetic wrong-answer cases (and, if available, the GAIA validation split)
to surface cases where the fuzzy scorer would inflate correctness.

The output is written to packages/benchmarks/gaia/fuzzy_audit.md so the
divergent cases can be reviewed before defaulting strict_mode to True.
"""

from __future__ import annotations

import os
from pathlib import Path

from elizaos_gaia.evaluator import GAIAEvaluator


SYNTHETIC_CASES: list[tuple[str, str, str]] = [
    # (description, ground_truth, model_prediction)
    # Cases crafted to actually exercise the fuzzy / substring branches.
    # The substring branch triggers when shorter/longer > 0.8 after
    # normalization. The Levenshtein branch triggers at similarity >= 0.9.
    ("substring: GT contained in slightly longer pred",
     "Margaret Hamilton", "Margaret Hamilton."),
    ("substring: extra short qualifier (>0.8 ratio)",
     "George Washington Carver", "George Washington Carver."),
    ("Levenshtein typo within 0.9 threshold",
     "Massachusetts", "Massachussets"),  # 1 char diff in 13 chars → 0.92
    ("Levenshtein single-char swap on medium word",
     "Schwarzenegger", "Schwartzenegger"),  # 1 char in ~14 → 0.93
    ("substring: trailing role suffix close in length",
     "Marie Curie scientist", "Marie Curie scientists"),
    ("misspelled name (short, below threshold)", "John Smith", "Jon Smith"),
    ("verbose city answer (different)", "Paris", "Paris, France"),
    ("scratch-work prefix on number", "42", "approximately 42 cars"),
    ("substring containment (long pred)", "Mona Lisa", "the Mona Lisa painting"),
    ("plural vs singular (short)", "cat", "cats"),
    ("partial list", "red, blue, green", "red and blue"),
    ("compound name", "New York City", "New York"),
    ("correct exact answer (control)", "Paris", "Paris"),
    ("correct numeric (control)", "42", "42"),
    ("correct with prefix (control)", "42", "The answer is 42"),
]


def run_audit() -> str:
    strict = GAIAEvaluator(strict_mode=True)
    fuzzy = GAIAEvaluator(strict_mode=False)

    lines: list[str] = []
    lines.append("# GAIA fuzzy-scorer false-positive audit")
    lines.append("")
    lines.append(
        "This audit compares the strict GAIA scorer (default after this change) "
        "against the previous fuzzy-enabled scorer. Rows marked 'DIVERGENT' are "
        "cases where the fuzzy scorer would have inflated the score by counting "
        "a wrong answer as correct."
    )
    lines.append("")
    lines.append("Reference scorer (official): "
                 "https://huggingface.co/spaces/gaia-benchmark/leaderboard/raw/main/scorer.py")
    lines.append("")
    lines.append("| # | description | ground truth | prediction | strict | fuzzy | divergent? |")
    lines.append("|---|---|---|---|---|---|---|")

    divergent = 0
    total = 0
    for i, (desc, gt, pred) in enumerate(SYNTHETIC_CASES, start=1):
        s_ok, _, _ = strict.evaluate(pred, gt)
        f_ok, _, _ = fuzzy.evaluate(pred, gt)
        diverges = s_ok != f_ok
        if diverges:
            divergent += 1
        total += 1
        lines.append(
            f"| {i} | {desc} | `{gt}` | `{pred}` | "
            f"{'OK' if s_ok else 'X'} | {'OK' if f_ok else 'X'} | "
            f"{'DIVERGENT' if diverges else ''} |"
        )

    lines.append("")
    lines.append(f"**Synthetic cases divergent: {divergent} / {total}**")
    lines.append("")

    # Try a quick HF validation sample if available (best-effort; skipped if gated).
    hf_token = os.environ.get("HF_TOKEN")
    try:
        from elizaos_gaia.dataset import DatasetAccessError, GAIADataset
        import asyncio

        ds = GAIADataset()

        async def _load() -> list:
            try:
                return await ds.load(split="validation", hf_token=hf_token)
            except DatasetAccessError as exc:
                raise RuntimeError(f"gated: {exc}") from exc

        questions = asyncio.run(_load())
        lines.append(f"## HF validation split sample ({len(questions)} questions)")
        lines.append("")
        lines.append("Synthetic wrong predictions derived from each ground truth "
                     "by appending ', verified' or prepending 'about '. Only divergent rows shown.")
        lines.append("")
        lines.append("| task_id | ground truth | prediction | strict | fuzzy |")
        lines.append("|---|---|---|---|---|")
        diverged_hf = 0
        for q in questions[:25]:
            gt = (q.final_answer or "").strip()
            if not gt:
                continue
            for pred in (f"about {gt}", f"{gt}, verified"):
                s_ok, _, _ = strict.evaluate(pred, gt)
                f_ok, _, _ = fuzzy.evaluate(pred, gt)
                if s_ok != f_ok:
                    diverged_hf += 1
                    lines.append(
                        f"| {q.task_id} | `{gt}` | `{pred}` | "
                        f"{'OK' if s_ok else 'X'} | {'OK' if f_ok else 'X'} |"
                    )
        lines.append("")
        lines.append(f"**HF rows divergent: {diverged_hf}**")
    except Exception as exc:  # noqa: BLE001
        lines.append("## HF validation split sample")
        lines.append("")
        lines.append(f"Skipped (could not load HF split): `{exc}`")

    return "\n".join(lines) + "\n"


def main() -> None:
    out_path = Path(__file__).resolve().parents[1] / "fuzzy_audit.md"
    out_path.write_text(run_audit(), encoding="utf-8")
    print(f"Wrote audit to {out_path}")


if __name__ == "__main__":
    main()
