"""Smoke tests for the throughput benchmark scripts.

These tests verify that the throughput benchmarks import cleanly, run
end-to-end on tiny configurations, and produce expected output schemas. They
are NOT the full benchmarks — those should be run as standalone scripts.

The full grids would take minutes; here we monkeypatch the grids down to
a single tiny configuration each so the tests finish in a few seconds.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture
def tiny_horde(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Return the horde_throughput module with grids reduced to one config."""
    mod = importlib.import_module("benchmarks.horde_throughput")
    monkeypatch.setattr(mod, "N_DEMONS_GRID", [3])
    monkeypatch.setattr(mod, "HIDDEN_SIZES_GRID", [(8,)])
    monkeypatch.setattr(mod, "TRACES_GRID", [False])
    monkeypatch.setattr(mod, "NORMALIZER_GRID", [None])
    return mod


@pytest.fixture
def tiny_sarsa(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Return the sarsa_throughput module with grids reduced to one config."""
    mod = importlib.import_module("benchmarks.sarsa_throughput")
    monkeypatch.setattr(mod, "N_ACTIONS_GRID", [2])
    monkeypatch.setattr(mod, "HIDDEN_SIZES_GRID", [(8,)])
    monkeypatch.setattr(mod, "TRACES_GRID", [False])
    return mod


@pytest.fixture
def tiny_step1(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Return the step1_throughput module with grids reduced to one config."""
    mod = importlib.import_module("benchmarks.step1_throughput")
    monkeypatch.setattr(mod, "OPTIMIZER_FACTORIES", {"LMS": mod.OPTIMIZER_FACTORIES["LMS"]})
    monkeypatch.setattr(
        mod, "NORMALIZER_FACTORIES", {"none": mod.NORMALIZER_FACTORIES["none"]}
    )
    return mod


class TestStep1ThroughputSmoke:
    """Verify the Step 1 benchmark imports and runs end-to-end on tiny inputs."""

    def test_imports_cleanly(self) -> None:
        """The module imports without side effects beyond what's expected."""
        mod = importlib.import_module("benchmarks.step1_throughput")
        assert hasattr(mod, "run_all_benchmarks")
        assert hasattr(mod, "print_results_table")
        assert hasattr(mod, "save_results_csv")
        assert hasattr(mod, "save_results_json")
        assert hasattr(mod, "save_results_markdown")
        assert hasattr(mod, "main")

    def test_run_tiny(self, tiny_step1: Any) -> None:
        """A single tiny configuration produces valid scan and batched results."""
        results = tiny_step1.run_all_benchmarks(
            n_steps=20,
            feature_dim=4,
            batch_size=2,
            seed=0,
            optimizers=["LMS"],
            normalizers=["none"],
            modes=["scan", "batched"],
        )
        assert len(results) == 2
        for r in results:
            assert r.error == ""
            assert r.steps_per_sec > 0
            assert r.learner_updates_per_sec > 0
            assert r.run_seconds > 0
            assert r.warmup_seconds > 0
            assert r.n_steps == 20

    def test_csv_json_markdown_output(self, tiny_step1: Any, tmp_path: Path) -> None:
        """CSV, JSON, and Markdown are written with expected columns."""
        results = tiny_step1.run_all_benchmarks(
            n_steps=10,
            feature_dim=4,
            batch_size=2,
            seed=0,
            optimizers=["LMS"],
            normalizers=["none"],
            modes=["scan"],
        )
        csv_path, json_path, md_path = tiny_step1.save_all_outputs(results, tmp_path)

        csv_content = csv_path.read_text()
        for column in [
            "optimizer",
            "normalizer",
            "mode",
            "steps_per_sec",
            "learner_updates_per_sec",
            "warmup_seconds",
            "run_seconds",
            "n_steps",
            "feature_dim",
            "batch_size",
            "stream",
            "device",
            "error",
        ]:
            assert column in csv_content

        payload = json.loads(json_path.read_text())
        assert payload["benchmark"] == "step1_throughput"
        assert payload["results"][0]["optimizer"] == "LMS"
        assert "learner_updates_per_sec" in payload["results"][0]

        md_content = md_path.read_text()
        assert "Step 1 CPU Throughput" in md_content
        assert "Learner updates/sec" in md_content

    def test_main_returns_zero_on_success(
        self, tiny_step1: Any, tmp_path: Path
    ) -> None:
        """``main(...)`` exits with 0 when nothing failed."""
        rc = tiny_step1.main(
            [
                "--n-steps",
                "10",
                "--feature-dim",
                "4",
                "--batch-size",
                "2",
                "--optimizers",
                "LMS",
                "--normalizers",
                "none",
                "--modes",
                "scan",
                "--output-dir",
                str(tmp_path),
            ]
        )
        assert rc == 0
        assert len(list(tmp_path.glob("step1_throughput_*.csv"))) == 1
        assert len(list(tmp_path.glob("step1_throughput_*.json"))) == 1
        assert len(list(tmp_path.glob("step1_throughput_*.md"))) == 1

    def test_print_table_runs(
        self, tiny_step1: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """``print_results_table`` runs without error and produces output."""
        results = tiny_step1.run_all_benchmarks(
            n_steps=10,
            feature_dim=4,
            batch_size=2,
            seed=0,
            optimizers=["LMS"],
            normalizers=["none"],
            modes=["scan"],
        )
        tiny_step1.print_results_table(results)
        captured = capsys.readouterr()
        assert "Step 1 Throughput Results" in captured.out
        assert "updates/sec" in captured.out


class TestHordeThroughputSmoke:
    """Verify the Horde benchmark imports and runs end-to-end on tiny inputs."""

    def test_imports_cleanly(self) -> None:
        """The module imports without side effects beyond what's expected."""
        mod = importlib.import_module("benchmarks.horde_throughput")
        # Public functions
        assert hasattr(mod, "run_all_benchmarks")
        assert hasattr(mod, "print_results_table")
        assert hasattr(mod, "save_results_csv")
        assert hasattr(mod, "main")
        assert hasattr(mod, "run_horde_learning_loop_final_state")

    def test_run_tiny(self, tiny_horde: Any) -> None:
        """A single tiny configuration produces a valid result."""
        results = tiny_horde.run_all_benchmarks(
            n_steps=50, feature_dim=4, seed=0
        )
        assert len(results) == 1
        r = results[0]
        assert r.error == ""
        assert r.steps_per_sec > 0
        assert r.total_seconds > 0
        assert r.jit_warmup_seconds > 0
        assert r.n_steps == 50

    def test_csv_output(self, tiny_horde: Any, tmp_path: Path) -> None:
        """The CSV is written with the expected columns."""
        results = tiny_horde.run_all_benchmarks(
            n_steps=20, feature_dim=4, seed=0
        )
        csv_path = tiny_horde.save_results_csv(results, tmp_path)
        assert csv_path.exists()
        content = csv_path.read_text()
        assert "n_demons" in content
        assert "hidden_sizes_str" in content
        assert "traces" in content
        assert "normalizer" in content
        assert "steps_per_sec" in content
        assert "total_seconds" in content
        assert "jit_warmup_seconds" in content

    def test_main_returns_zero_on_success(
        self, tiny_horde: Any, tmp_path: Path
    ) -> None:
        """``main(...)`` exits with 0 when nothing failed."""
        rc = tiny_horde.main(
            [
                "--n-steps",
                "20",
                "--feature-dim",
                "4",
                "--output-dir",
                str(tmp_path),
            ]
        )
        assert rc == 0
        # CSV should exist in tmp_path
        csvs = list(tmp_path.glob("horde_throughput_*.csv"))
        assert len(csvs) == 1

    def test_print_table_runs(
        self, tiny_horde: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """``print_results_table`` runs without error and produces output."""
        results = tiny_horde.run_all_benchmarks(
            n_steps=20, feature_dim=4, seed=0
        )
        tiny_horde.print_results_table(results)
        captured = capsys.readouterr()
        assert "Horde Throughput Results" in captured.out
        assert "steps/sec" in captured.out


class TestSARSAThroughputSmoke:
    """Verify the SARSA benchmark imports and runs end-to-end on tiny inputs."""

    def test_imports_cleanly(self) -> None:
        """The module imports without side effects beyond what's expected."""
        mod = importlib.import_module("benchmarks.sarsa_throughput")
        assert hasattr(mod, "run_all_benchmarks")
        assert hasattr(mod, "print_results_table")
        assert hasattr(mod, "save_results_csv")
        assert hasattr(mod, "main")
        assert hasattr(mod, "run_sarsa_from_arrays_final_state")

    def test_run_tiny(self, tiny_sarsa: Any) -> None:
        """A single tiny configuration produces a valid result."""
        results = tiny_sarsa.run_all_benchmarks(
            n_steps=50, feature_dim=4, seed=0
        )
        assert len(results) == 1
        r = results[0]
        assert r.error == ""
        assert r.steps_per_sec > 0
        assert r.total_seconds > 0
        assert r.jit_warmup_seconds > 0
        assert r.n_steps == 50

    def test_csv_output(self, tiny_sarsa: Any, tmp_path: Path) -> None:
        """The CSV is written with the expected columns."""
        results = tiny_sarsa.run_all_benchmarks(
            n_steps=20, feature_dim=4, seed=0
        )
        csv_path = tiny_sarsa.save_results_csv(results, tmp_path)
        assert csv_path.exists()
        content = csv_path.read_text()
        assert "n_actions" in content
        assert "hidden_sizes_str" in content
        assert "traces" in content
        assert "steps_per_sec" in content
        assert "total_seconds" in content
        assert "jit_warmup_seconds" in content

    def test_main_returns_zero_on_success(
        self, tiny_sarsa: Any, tmp_path: Path
    ) -> None:
        """``main(...)`` exits with 0 when nothing failed."""
        rc = tiny_sarsa.main(
            [
                "--n-steps",
                "20",
                "--feature-dim",
                "4",
                "--output-dir",
                str(tmp_path),
            ]
        )
        assert rc == 0
        csvs = list(tmp_path.glob("sarsa_throughput_*.csv"))
        assert len(csvs) == 1

    def test_print_table_runs(
        self, tiny_sarsa: Any, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """``print_results_table`` runs without error and produces output."""
        results = tiny_sarsa.run_all_benchmarks(
            n_steps=20, feature_dim=4, seed=0
        )
        tiny_sarsa.print_results_table(results)
        captured = capsys.readouterr()
        assert "SARSA Throughput Results" in captured.out
        assert "steps/sec" in captured.out
