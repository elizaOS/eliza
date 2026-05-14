"""Build a small Mind2Web fixture for the ranker test.

Pulls 5 action steps from the HuggingFace ``osunlp/Mind2Web`` ``test_task``
split, flattens them with their cleaned_html + candidates, and pickles them
under ``tests/fixtures/mind2web_sample.pkl``.

Run once with network access; the resulting pickle can be committed and used
offline by ``test_ranker_recall_above_threshold_on_fixture``.

Usage:
    PYTHONPATH=packages python -m benchmarks.mind2web.tests.build_ranker_fixture
"""

from __future__ import annotations

import logging
import pickle
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main(n_steps: int = 5, split: str = "test_task") -> None:
    from datasets import load_dataset  # type: ignore[import-not-found]

    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.types import Mind2WebSplit

    ds = Mind2WebDataset(split=Mind2WebSplit(split))
    # Use a small slice via HF directly to keep the fixture build fast.
    hf = load_dataset("osunlp/Mind2Web", split=f"{split}[:3]")

    samples: list[tuple[str, list[str], object]] = []
    for task_dict in hf:
        task = ds._parse_task(task_dict)
        if not task:
            continue
        previous: list[str] = []
        for i, step in enumerate(task.actions):
            if not step.pos_candidates:
                # Skip steps without GT positives; recall would be undefined.
                continue
            samples.append((task.confirmed_task, list(previous), step))
            if task.action_reprs and i < len(task.action_reprs):
                previous.append(task.action_reprs[i])
            if len(samples) >= n_steps:
                break
        if len(samples) >= n_steps:
            break

    if not samples:
        raise SystemExit("No usable samples extracted; check dataset access.")

    out = Path(__file__).resolve().parent / "fixtures" / "mind2web_sample.pkl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        pickle.dump(samples, f)
    logger.info("Wrote %d-step fixture to %s", len(samples), out)


if __name__ == "__main__":
    main()
