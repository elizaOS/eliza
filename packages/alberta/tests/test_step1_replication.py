"""Regression tests for Step 1 canonical replication results.

These tests load the JSON files written by ``examples/The Alberta Plan/Step1/
step1_full_baselines.py`` (and friends) and assert that the canonical Step 1
claims still hold.  They auto-skip when the JSON has not been generated yet,
so a fresh checkout that never ran the experiments still passes the suite.

Each numeric threshold is intentionally generous: the goal is to catch
silent regressions in IDBD / Autostep correctness, not to encode brittle
random-seed-specific values.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

CANONICAL_DIR = (
    Path(__file__).resolve().parents[1]
    / "outputs"
    / "step1_canonical"
)


def _load_json_or_skip(filename: str) -> dict:
    """Return the parsed JSON, or skip if the file is missing."""
    path = CANONICAL_DIR / filename
    if not path.exists():
        pytest.skip(
            f"{path} not generated yet; run "
            "'examples/The Alberta Plan/Step1/step1_full_baselines.py' first."
        )
    with path.open() as f:
        return json.load(f)


class TestMultiBaselineReplication:
    """Assertions over ``multi_baseline_results.json``."""

    @pytest.fixture
    def results(self) -> dict:
        return _load_json_or_skip("multi_baseline_results.json")

    def test_results_have_required_top_level_keys(self, results: dict) -> None:
        for key in ("config", "per_run", "tuned", "paired_vs_lms"):
            assert key in results, f"missing top-level key {key!r}"

    def test_seed_count_at_least_30(self, results: dict) -> None:
        assert results["config"]["seeds"] >= 30, (
            "Step 1 canonical replication must use at least 30 seeds"
        )

    def test_all_public_step1_optimizers_evaluated(self, results: dict) -> None:
        expected = {
            "LMS",
            "IDBD",
            "Autostep",
            "AdaGain",
            "Adam",
            "RMSprop",
            "NADALINE",
        }
        for stream_key, by_opt in results["tuned"].items():
            assert expected.issubset(set(by_opt.keys())), (
                f"stream {stream_key!r} missing optimizers: "
                f"{expected - set(by_opt.keys())}"
            )

    def test_idbd_beats_lms_on_sutton_with_noise(self, results: dict) -> None:
        """IDBD with meta-learned step-sizes should beat best-tuned LMS
        on the Alberta-Plan-compliant noisy Sutton stream by at least 20%
        (the original Sutton 1992 paper reports ~57% improvement on the
        noiseless variant).
        """
        # Be tolerant about exact stream key naming
        candidates = [
            k for k in results["tuned"]
            if "sutton" in k.lower() and "noise" in k.lower()
        ]
        if not candidates:
            pytest.skip(
                "No noisy-Sutton stream key in results; cannot enforce headline."
            )
        for stream_key in candidates:
            by_opt = results["tuned"][stream_key]
            lms_mse = by_opt["LMS"]["mean_mse"]
            idbd_mse = by_opt["IDBD"]["mean_mse"]
            assert idbd_mse < 0.8 * lms_mse, (
                f"On {stream_key}: IDBD mean MSE {idbd_mse:.4f} should be "
                f"< 80% of LMS mean MSE {lms_mse:.4f}"
            )

    def test_paired_diffs_have_required_fields(self, results: dict) -> None:
        for stream_key, by_opt in results["paired_vs_lms"].items():
            for opt_name, stats in by_opt.items():
                for field in ("mean_diff", "stderr_diff", "wins", "n_seeds"):
                    assert field in stats, (
                        f"{stream_key}/{opt_name} missing {field!r}"
                    )
                # n_seeds may be 0 if every seed produced NaN (divergence) —
                # this is itself a meaningful finding (e.g. IDBD on
                # XDistShift). Just make sure the field is an int and
                # is at most the configured seed count.
                assert isinstance(stats["n_seeds"], int)
                assert 0 <= stats["n_seeds"] <= results["config"]["seeds"]

    def test_idbd_or_autostep_dominate_sutton1992(self, results: dict) -> None:
        """On the original Sutton 1992 task (noiseless) and the
        Alberta-Plan noisy variant, at least one of IDBD/Autostep should
        beat best-tuned LMS on every seed (paired wins == n_seeds).
        This is the canonical Step 1 success criterion.
        """
        for stream_key in results["paired_vs_lms"]:
            if "sutton" not in stream_key.lower():
                continue
            cells = results["paired_vs_lms"][stream_key]
            wins = max(
                cells.get("IDBD", {}).get("wins", -1),
                cells.get("Autostep", {}).get("wins", -1),
            )
            n = cells.get("IDBD", {}).get("n_seeds", 0)
            assert wins == n, (
                f"On {stream_key}: best of IDBD/Autostep wins only "
                f"{wins}/{n} seeds against best-tuned LMS"
            )


class TestNormalizationAblation:
    """Assertions over ``normalization_ablation_results.json``."""

    @pytest.fixture
    def results(self) -> dict:
        return _load_json_or_skip("normalization_ablation_results.json")

    def test_four_normalizers_present(self, results: dict) -> None:
        rows = results.get("per_run")
        if not rows:
            pytest.skip("no per_run data")
        # per_run is a dict keyed by "{stream}|{optimizer}|{normalizer}"
        # mapping to per-cell stats. Pull normalizer names from the values.
        if isinstance(rows, dict):
            norms = {v.get("normalizer") for v in rows.values()}
        else:
            norms = {row.get("normalizer") for row in rows}
        norm_names = {str(n) for n in norms}
        # Accept either short ("EMA", "Welford") or full class names.
        assert "None" in norm_names
        assert any(n.startswith("EMA") for n in norm_names), norm_names
        assert any(n.startswith("Welford") for n in norm_names), norm_names
        if not any(n.startswith("StreamingBatch") for n in norm_names):
            pytest.skip(
                "canonical normalization ablation predates StreamingBatch; "
                "rerun step1_normalization_ablation.py to enforce it"
            )

    def test_streaming_batch_paired_comparisons_present(self, results: dict) -> None:
        paired = results.get("paired") or {}
        if not paired:
            pytest.skip("no paired data")
        rows = results.get("per_run") or {}
        norm_names = {str(v.get("normalizer")) for v in rows.values()}
        if not any(n.startswith("StreamingBatch") for n in norm_names):
            pytest.skip(
                "canonical normalization ablation predates StreamingBatch; "
                "rerun step1_normalization_ablation.py to enforce it"
            )
        expected_suffixes = {
            "None_vs_StreamingBatch",
            "EMA_vs_StreamingBatch",
            "Welford_vs_StreamingBatch",
        }
        found_suffixes = {
            key.rsplit("|", maxsplit=1)[-1]
            for key in paired
            if key.endswith("StreamingBatch")
        }
        assert expected_suffixes.issubset(found_suffixes), (
            f"missing StreamingBatch paired comparisons: "
            f"{expected_suffixes - found_suffixes}"
        )


class TestRobustnessStudy:
    """Assertions over ``robustness_study_results.json``."""

    @pytest.fixture
    def results(self) -> dict:
        return _load_json_or_skip("robustness_study_results.json")

    def test_idbd_more_robust_than_lms(self, results: dict) -> None:
        """The whole point of Step 1: meta-learners cope with a wider
        range of their hyperparameter than LMS does with alpha.

        Operational definition: number of grid points at which the run
        produced a finite final-window MSE (rather than NaN/inf).
        IDBD must be at least as good as LMS by this measure.
        """
        agg = (
            results.get("summary")
            or results.get("aggregate")
            or results.get("per_optimizer")
            or {}
        )
        if not agg or "LMS" not in agg or "IDBD" not in agg:
            pytest.skip("summary dict missing LMS/IDBD entries")
        lms = agg["LMS"]
        idbd = agg["IDBD"]
        lms_finite = lms.get("num_finite_grid_points")
        idbd_finite = idbd.get("num_finite_grid_points")
        if lms_finite is None or idbd_finite is None:
            pytest.skip("num_finite_grid_points not recorded")
        assert idbd_finite >= lms_finite, (
            f"IDBD's working range ({idbd_finite} finite grid points) "
            f"should be at least as wide as LMS's ({lms_finite}); "
            "the meta-learner is supposed to be more tolerant of "
            "hyperparameter mis-tuning."
        )
