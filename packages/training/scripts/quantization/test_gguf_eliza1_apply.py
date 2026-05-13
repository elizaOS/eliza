from __future__ import annotations

import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.quantization.gguf_eliza1_apply import main  # noqa: E402


def test_q4_polar_refuses_missing_polar_sidecar_by_default(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q4_polar",
            "--dry-run",
        ]
    )

    assert rc == 2


def test_q4_polar_fallback_requires_explicit_escape_hatch(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()

    rc = main(
        [
            "--checkpoint",
            str(checkpoint),
            "--output",
            str(tmp_path / "model.gguf"),
            "--outtype",
            "q4_polar",
            "--allow-unoptimized-fallback",
            "--dry-run",
        ]
    )

    assert rc == 0
