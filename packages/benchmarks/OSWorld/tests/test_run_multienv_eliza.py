from __future__ import annotations

import argparse
import os

import lib_run_single
from scripts.python import run_multienv_eliza


def _dry_args(tmp_path) -> argparse.Namespace:
    return argparse.Namespace(
        provider_name="docker",
        path_to_vm=None,
        region=None,
        headless=True,
        snapshot_name="init_state",
        model="openai/gpt-oss-120b",
        observation_type="screenshot_a11y_tree",
        action_space="pyautogui",
        max_steps=1,
        temperature=0.0,
        max_tokens=128,
        max_trajectory_length=1,
        a11y_tree_max_tokens=100,
        result_dir=str(tmp_path),
        task_id=None,
        domain=None,
        max_tasks=None,
        num_envs=1,
        sleep_after_execution=0.0,
        dry_run=True,
    )


def test_dry_run_uses_synthetic_task_and_restores_sleep(tmp_path, monkeypatch) -> None:
    def fail_load_tasks(_args):
        raise AssertionError("dry-run must not load real OSWorld benchmark tasks")

    monkeypatch.setattr(run_multienv_eliza, "load_tasks", fail_load_tasks)
    original_sleep = lib_run_single.time.sleep

    summary = run_multienv_eliza.run_benchmark(_dry_args(tmp_path))

    assert summary["total_tasks"] == 1
    assert summary["passed_tasks"] == 1
    assert summary["results"][0]["task_id"] == "osworld_eliza_dry_run"
    assert lib_run_single.time.sleep is original_sleep


def test_delegate_harness_does_not_start_eliza_server(monkeypatch) -> None:
    monkeypatch.delenv("ELIZA_BENCH_URL", raising=False)
    monkeypatch.setenv("BENCHMARK_HARNESS", "openclaw")

    assert run_multienv_eliza.should_start_eliza_server() is False


def test_model_env_is_forwarded(monkeypatch) -> None:
    monkeypatch.delenv("BENCHMARK_MODEL_NAME", raising=False)
    monkeypatch.delenv("OPENAI_LARGE_MODEL", raising=False)

    run_multienv_eliza._configure_bridge_model_env("openai/gpt-oss-120b")

    assert os.environ["BENCHMARK_MODEL_NAME"] == "openai/gpt-oss-120b"
    assert os.environ["OPENAI_LARGE_MODEL"] == "openai/gpt-oss-120b"
