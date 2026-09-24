"""Exercises evaluation stopping rules, checkpoint ranking, and CLI configuration."""

from __future__ import annotations

from typing import Any

import pytest

import finetune_kokoro_full  # type: ignore  # noqa: E402


# ---------------------------------------------------------------------------
# 2. Eval gate decision logic.
# ---------------------------------------------------------------------------


class TestDecideContinue:
    """Spec: stop training when SpkSim stalls or regresses for `patience` evals."""

    def test_warmup_returns_continue(self) -> None:
        """Not enough history → always continue."""
        cont, reason = finetune_kokoro_full._decide_continue(
            [{"speaker_similarity": 0.4}],
            patience=3,
        )
        assert cont is True
        assert reason == "warmup"

    def test_strictly_improving_continues(self) -> None:
        cont, _ = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.4},
                {"speaker_similarity": 0.45},
                {"speaker_similarity": 0.5},
                {"speaker_similarity": 0.55},
            ],
            patience=3,
        )
        assert cont is True

    def test_stalled_for_patience_stops(self) -> None:
        """Three consecutive evals at or below the baseline → stop."""
        cont, reason = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.50},
                {"speaker_similarity": 0.48},
                {"speaker_similarity": 0.49},
                {"speaker_similarity": 0.47},
            ],
            patience=3,
        )
        assert cont is False
        assert "stalled" in reason or "regressed" in reason

    def test_partial_regression_continues(self) -> None:
        """If even one eval in the patience window beats baseline, continue."""
        cont, _ = finetune_kokoro_full._decide_continue(
            [
                {"speaker_similarity": 0.50},
                {"speaker_similarity": 0.48},
                {"speaker_similarity": 0.55},  # this one beats baseline
                {"speaker_similarity": 0.49},
            ],
            patience=3,
        )
        assert cont is True


class TestUpdateTopK:
    """Spec: maintain top-k by SpkSim; older entries dropped from disk."""

    def test_first_entry_keeps_one(self) -> None:
        kept, drop = finetune_kokoro_full._update_top_k(
            [],
            step=200,
            path="/x/step_200.pt",
            bin_path="/x/step_200.bin",
            speaker_similarity=0.55,
            k=3,
        )
        assert len(kept) == 1
        assert kept[0]["step"] == 200
        assert drop == []

    def test_top_k_drops_when_full(self) -> None:
        top_k: list[dict[str, Any]] = [
            {"step": 200, "path": "/x/step_200.pt", "binPath": "/x/step_200.bin", "speaker_similarity": 0.55},
            {"step": 400, "path": "/x/step_400.pt", "binPath": "/x/step_400.bin", "speaker_similarity": 0.50},
            {"step": 600, "path": "/x/step_600.pt", "binPath": "/x/step_600.bin", "speaker_similarity": 0.45},
        ]
        kept, drop = finetune_kokoro_full._update_top_k(
            top_k,
            step=800,
            path="/x/step_800.pt",
            bin_path="/x/step_800.bin",
            speaker_similarity=0.60,
            k=3,
        )
        assert len(kept) == 3
        kept_steps = sorted([e["step"] for e in kept])
        assert 800 in kept_steps
        assert 600 not in kept_steps  # worst-perf was step 600
        # Dropping deletes both .pt and .bin paths.
        assert "/x/step_600.pt" in drop
        assert "/x/step_600.bin" in drop

    def test_top_k_ignores_when_under_threshold(self) -> None:
        top_k: list[dict[str, Any]] = [
            {"step": 200, "path": "/x/step_200.pt", "binPath": "/x/step_200.bin", "speaker_similarity": 0.55},
            {"step": 400, "path": "/x/step_400.pt", "binPath": "/x/step_400.bin", "speaker_similarity": 0.50},
            {"step": 600, "path": "/x/step_600.pt", "binPath": "/x/step_600.bin", "speaker_similarity": 0.45},
        ]
        kept, drop = finetune_kokoro_full._update_top_k(
            top_k,
            step=800,
            path="/x/step_800.pt",
            bin_path="/x/step_800.bin",
            speaker_similarity=0.40,  # worse than every kept entry
            k=3,
        )
        assert len(kept) == 3
        # The new entry should be the one that got dropped.
        assert "/x/step_800.pt" in drop


# ---------------------------------------------------------------------------
# 3. CLI surface + config loading.
# ---------------------------------------------------------------------------


def test_cli_default_config_is_sam_full() -> None:
    parser = finetune_kokoro_full.build_parser()
    # parse a minimal argv that doesn't error.
    ns = parser.parse_args(["--run-dir", "/tmp/x"])
    assert ns.config == "kokoro_same_full.yaml"
    assert ns.init_from_voice == "af_bella"


def test_config_has_full_mode_and_correct_thresholds() -> None:
    """The shipped config must declare mode=full + relaxed SpkSim gate."""
    from _config import load_config  # type: ignore  # noqa: PLC0415

    cfg = load_config("kokoro_same_full.yaml")
    assert cfg["mode"] == "full"
    assert cfg["max_steps"] == 1500
    assert cfg["learning_rate"] == pytest.approx(5e-5)
    assert cfg["gates"]["speaker_similarity_min"] == pytest.approx(0.55)
    assert cfg["gates"]["utmos_min"] == pytest.approx(3.8)
    assert cfg["gates"]["wer_max"] == pytest.approx(0.08)
    assert cfg["gates"]["rtf_min"] == pytest.approx(5.0)
    # APOLLO-only policy.
    assert cfg["optimizer"] in ("apollo", "apollo_mini")
    # Tags reflect the full-finetune lineage.
    assert "full-finetune" in cfg["voice_tags"]


