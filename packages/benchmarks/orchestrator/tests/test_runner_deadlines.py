"""Exercises subprocess deadline policy and durable progress without model calls."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from benchmarks.campaign_profile import FULL_CAMPAIGN_PROFILE
from benchmarks.orchestrator import runner
from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    list_runs,
)
from benchmarks.orchestrator.types import (
    AdapterDiscovery,
    BenchmarkAdapter,
    RunRequest,
    ScoreSummary,
)


def _adapter(*, timeout_seconds: int = 73) -> BenchmarkAdapter:
    return BenchmarkAdapter(
        id="deadline-test",
        directory="deadline-test",
        description="deadline test",
        cwd=".",
        command_builder=lambda _ctx, _adapter: [],
        result_locator=lambda _ctx, _adapter, _root: None,
        score_extractor=lambda _path: ScoreSummary(1.0, "ratio", True),
        default_timeout_seconds=timeout_seconds,
    )


def _request(*, full: bool, silent_timeout: float = 1.0) -> RunRequest:
    extra = (
        {
            "campaign_profile": FULL_CAMPAIGN_PROFILE,
            "campaign_silent_timeout_s": silent_timeout,
        }
        if full
        else {}
    )
    return RunRequest(
        benchmarks=("deadline-test",),
        agent="eliza",
        provider="mock",
        model="mock",
        extra_config=extra,
    )


def _execute(
    tmp_path: Path,
    *,
    script: str,
    policy: runner.ProcessDeadlinePolicy,
    execution_cancel_event: threading.Event | None = None,
) -> tuple[runner.ProcessExecutionResult, list[dict[str, object]]]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    output_root = tmp_path / "output"
    output_root.mkdir()
    stdout_path = tmp_path / "stdout.log"
    stderr_path = tmp_path / "stderr.log"
    telemetry_path = output_root / "telemetry.jsonl"
    progress_path = tmp_path / "process-progress.ndjson"
    with (
        stdout_path.open("w", encoding="utf-8") as stdout_file,
        stderr_path.open("w", encoding="utf-8") as stderr_file,
    ):
        result = runner._run_command_with_deadlines(
            [sys.executable, "-u", "-c", script],
            cwd=str(tmp_path),
            env={},
            stdout_file=stdout_file,
            stderr_file=stderr_file,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            telemetry_path=telemetry_path,
            output_root=output_root,
            progress_path=progress_path,
            policy=policy,
            execution_cancel_event=execution_cancel_event,
        )
    events = [json.loads(line) for line in progress_path.read_text().splitlines()]
    return result, events


def test_full_profile_has_no_wall_timeout_but_keeps_silent_watchdog() -> None:
    full = runner._process_deadline_policy(
        _adapter(),
        _request(full=True, silent_timeout=901),
    )
    smoke = runner._process_deadline_policy(_adapter(), _request(full=False))

    assert full.wall_timeout_seconds is None
    assert full.silent_timeout_seconds == 901
    assert smoke.wall_timeout_seconds == 73
    assert smoke.silent_timeout_seconds is None


def test_acceptance_parent_interrupt_terminates_owned_benchmark(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(runner.ACCEPTANCE_PARENT_BOUNDARY_ENV, "1")
    process = object()
    terminated: list[object] = []
    monkeypatch.setattr(
        runner,
        "_terminate_benchmark_process",
        lambda active: terminated.append(active),
    )

    registration = runner._install_acceptance_parent_interrupt_handler(process)
    assert registration is not None
    signal_number, _previous = registration
    installed = signal.getsignal(signal_number)
    assert callable(installed)
    try:
        with pytest.raises(
            KeyboardInterrupt,
            match="acceptance-gate parent interrupted",
        ):
            installed(signal_number, None)
    finally:
        runner._restore_acceptance_parent_interrupt_handler(registration)

    assert terminated == [process]
    assert signal_number == (
        getattr(signal, "SIGBREAK", signal.SIGTERM)
        if os.name == "nt"
        else signal.SIGINT
    )


def test_normalized_harness_timeouts_reach_every_runtime_environment(
    tmp_path: Path,
) -> None:
    request = _request(full=True)
    request.extra_config.update(
        {
            "eliza_bench_http_timeout_s": 1800.0,
            "hermes_timeout_s": 1800.0,
            "openclaw_timeout_s": 1800.0,
        }
    )

    env = runner._default_env(tmp_path, request)

    assert env["ELIZA_BENCH_HTTP_TIMEOUT"] == "1800.0"
    assert env["HERMES_TIMEOUT_S"] == "1800.0"
    assert env["OPENCLAW_TIMEOUT_S"] == "1800.0"


def test_observed_output_resets_silent_watchdog_and_is_durable(
    tmp_path: Path,
) -> None:
    result, events = _execute(
        tmp_path,
        script=(
            "import time\n"
            "for value in range(7):\n"
            " print(value, flush=True)\n"
            " time.sleep(0.2)\n"
        ),
        policy=runner.ProcessDeadlinePolicy(
            wall_timeout_seconds=None,
            silent_timeout_seconds=0.75,
            poll_interval_seconds=0.02,
        ),
    )

    assert result.returncode == 0
    assert result.timeout_error is None
    assert events[0]["event"] == "process_started"
    assert events[-1]["event"] == "process_exited"
    assert any(event["event"] == "output_observed" for event in events)
    assert all("success" not in event for event in events)


def test_silent_full_process_is_stopped_by_progress_watchdog(tmp_path: Path) -> None:
    result, events = _execute(
        tmp_path,
        script="import time; time.sleep(5)",
        policy=runner.ProcessDeadlinePolicy(
            wall_timeout_seconds=None,
            silent_timeout_seconds=0.1,
            poll_interval_seconds=0.01,
        ),
    )

    assert result.returncode == 124
    assert result.timeout_error == "Command made no observable progress for 0.1s"
    assert events[-1]["event"] == "deadline_exceeded"


def test_smoke_process_retains_fixed_wall_timeout(tmp_path: Path) -> None:
    result, events = _execute(
        tmp_path,
        script="import time; time.sleep(5)",
        policy=runner.ProcessDeadlinePolicy(
            wall_timeout_seconds=0.1,
            silent_timeout_seconds=None,
            poll_interval_seconds=0.01,
        ),
    )

    assert result.returncode == 124
    assert result.timeout_error == "Command exceeded wall timeout after 0.1s"
    assert events[-1]["event"] == "deadline_exceeded"


def test_cohort_cancellation_stops_three_process_groups_only(
    tmp_path: Path,
) -> None:
    cancel_event = threading.Event()
    unrelated = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        start_new_session=True,
    )
    timer = threading.Timer(0.2, cancel_event.set)
    timer.start()
    try:
        policy = runner.ProcessDeadlinePolicy(
            wall_timeout_seconds=10,
            silent_timeout_seconds=None,
            poll_interval_seconds=0.02,
        )
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [
                executor.submit(
                    _execute,
                    tmp_path / f"lane-{index}",
                    script="import time; time.sleep(30)",
                    policy=policy,
                    execution_cancel_event=cancel_event,
                )
                for index in range(3)
            ]
            completed = [future.result(timeout=5) for future in futures]

        assert [result.returncode for result, _events in completed] == [130, 130, 130]
        assert all(
            result.cancellation_error
            == "Command cancelled by the benchmark cohort coordinator"
            for result, _events in completed
        )
        assert all(events[-1]["event"] == "cohort_cancelled" for _, events in completed)
        assert unrelated.poll() is None
    finally:
        timer.cancel()
        unrelated.terminate()
        unrelated.wait(timeout=5)


def test_generic_runner_inserts_row_and_reaches_real_process_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "packages"
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    output_root.mkdir(parents=True)
    database_path = output_root / "orchestrator.sqlite"
    connection = connect_database(database_path)
    initialize_database(connection)
    create_run_group(
        connection,
        run_group_id="rg-generic-process",
        created_at="2026-07-22T00:00:00+00:00",
        request={},
        benchmarks=["generic-process"],
        repo_meta={},
    )
    connection.close()

    script = (
        "import json, os\n"
        "from pathlib import Path\n"
        "output = Path(os.environ['BENCHMARK_OUTPUT_ROOT'])\n"
        "(output / 'result.json').write_text(json.dumps({'score': 0.75}))\n"
        "print('generic-process-reached', flush=True)\n"
    )
    adapter = BenchmarkAdapter(
        id="generic-process",
        directory="generic-process",
        description="real generic process boundary regression",
        cwd=str(tmp_path),
        command_builder=lambda _ctx, _adapter: [
            sys.executable,
            "-u",
            "-c",
            script,
        ],
        result_locator=lambda _ctx, _adapter, output: output / "result.json",
        score_extractor=lambda path: ScoreSummary(
            float(json.loads(path.read_text(encoding="utf-8"))["score"]),
            "ratio",
            True,
        ),
        agent_compatibility=("eliza",),
    )
    monkeypatch.setattr(
        runner,
        "discover_adapters",
        lambda _root: AdapterDiscovery(
            adapters={adapter.id: adapter},
            all_directories=(adapter.directory,),
        ),
    )

    run_group_id, outcomes, _viewer = runner.run_benchmarks(
        workspace_root=workspace_root,
        request=RunRequest(
            benchmarks=(adapter.id,),
            agent="eliza",
            provider="mock",
            model="mock",
            extra_config={},
            force=True,
        ),
        shared_run_group_id="rg-generic-process",
        defer_publication=True,
        execution_repo_meta={},
    )

    assert run_group_id == "rg-generic-process"
    assert len(outcomes) == 1
    assert outcomes[0].status == "succeeded"
    assert outcomes[0].score == 0.75
    assert "generic-process-reached" in Path(outcomes[0].stdout_path).read_text(
        encoding="utf-8"
    )
    connection = connect_database(database_path)
    rows = list_runs(connection, limit=None)
    connection.close()
    assert len(rows) == 1
    assert rows[0]["run_group_id"] == "rg-generic-process"
    assert rows[0]["status"] == "succeeded"
