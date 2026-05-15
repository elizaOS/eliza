from __future__ import annotations

import argparse
import os

import lib_run_single
from eliza_adapter.osworld import ElizaBridgeOSWorldAgent
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


def test_osworld_adapter_does_not_inline_screenshot_by_default(monkeypatch) -> None:
    class FakeClient:
        context = {}

        def wait_until_ready(self, timeout=120):
            return None

        def reset(self, **_kwargs):
            return {"ready": True}

        def send_message(self, text, context=None):
            self.context = dict(context or {})
            assert "Ubuntu Linux" in text

            class Response:
                text = "WAIT"
                params = {}

            return Response()

    monkeypatch.delenv("OSWORLD_INLINE_SCREENSHOT", raising=False)
    client = FakeClient()
    agent = ElizaBridgeOSWorldAgent(client=client, max_steps=1)

    response, actions = agent.predict(
        "Open the browser",
        {
            "screenshot": b"not-a-real-png",
            "accessibility_tree": "node\n" * 20000,
        },
    )

    assert response == "WAIT"
    assert actions == ["WAIT"]
    assert client.context["screenshot_present"] is True
    assert client.context["screenshot_inline"] is False
    assert client.context["screenshot_base64"] is None
    assert "[... truncated ...]" in client.context["accessibility_tree"]
