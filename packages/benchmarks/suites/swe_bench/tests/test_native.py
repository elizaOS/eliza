"""Native coding receipts are transport evidence, not issue-resolution scores."""
import json

import pytest

from benchmarks.swe_bench.native import parse_native_result, validate_native_trajectory


def test_native_receipt_preserves_complete_response() -> None:
    row = {"id": "task", "success": True, "actions_taken": ["READ", "EDIT", "SHELL"], "response": "complete " * 20000}
    assert parse_native_result("runtime log\n" + json.dumps(row), "task") == row


@pytest.mark.parametrize("row", [
    {"id": "task", "success": True, "actions_taken": ["REPLY"]},
    {"id": "task", "success": False, "actions_taken": ["EDIT"], "error": "denied"},
    {"id": "other", "success": True, "actions_taken": ["EDIT"]},
])
def test_native_receipt_requires_successful_task_and_mutation_tool(row) -> None:
    with pytest.raises((ValueError, RuntimeError)):
        parse_native_result(json.dumps(row), "task")


def test_duplicate_native_receipts_are_ambiguous() -> None:
    row = json.dumps({"id": "task", "success": True, "actions_taken": ["EDIT"]})
    with pytest.raises(ValueError, match="received 2"):
        parse_native_result(row + "\n" + row, "task")


TASK = {"prompt": "Repair the exact issue \u2603", "context": {"workspace": "/workspace", "benchmark": "swe_bench"}}


def trajectory(**overrides):
    record = {"trajectoryId": "tj-task", "traceId": "attempt-1", "status": "finished",
              "startedAt": 100, "endedAt": 200, "stages": [{"kind": "planner"}, {"kind": "tool"}],
              "rootMessage": {"id": "message-1", "text": TASK["prompt"] + "\n\nTask context (JSON):\n" + json.dumps(TASK["context"], ensure_ascii=False)}}
    record.update(overrides)
    return record


def save_trace(tmp_path, record, name="tj-task.json"):
    path = tmp_path / "agent" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))
    return path


def test_native_trace_requires_final_correlated_evidence(tmp_path):
    path = save_trace(tmp_path, trajectory())
    evidence = validate_native_trajectory(tmp_path, "attempt-1", TASK)
    assert evidence["path"] == str(path)
    assert evidence["trace_id"] == "attempt-1"
    assert evidence["trajectory_id"] == "tj-task"
    assert len(evidence["sha256"]) == 64


@pytest.mark.parametrize("updates", [
    {"status": "running"}, {"status": "failed"}, {"endedAt": None}, {"endedAt": 99},
    {"endedAt": float("inf")}, {"startedAt": True}, {"stages": []},
    {"stages": [{"kind": "planner"}]}, {"traceId": "previous-attempt"},
    {"rootMessage": {"text": "a different task"}},
    {"rootMessage": {"text": TASK["prompt"] + "\n\nTask context (JSON):\n{}"}},
])
def test_native_trace_rejects_incomplete_or_unrelated_evidence(tmp_path, updates):
    save_trace(tmp_path, trajectory(**updates))
    with pytest.raises(RuntimeError):
        validate_native_trajectory(tmp_path, "attempt-1", TASK)


def test_native_trace_rejects_missing_malformed_and_duplicate_files(tmp_path):
    with pytest.raises(RuntimeError, match="received 0"):
        validate_native_trajectory(tmp_path, "attempt-1", TASK)
    path = save_trace(tmp_path, trajectory())
    path.write_text('{"truncated":')
    with pytest.raises(RuntimeError, match="Invalid native trajectory"):
        validate_native_trajectory(tmp_path, "attempt-1", TASK)
    save_trace(tmp_path, trajectory())
    save_trace(tmp_path, trajectory(), "tj-duplicate.json")
    with pytest.raises(RuntimeError, match="received 2"):
        validate_native_trajectory(tmp_path, "attempt-1", TASK)


def test_native_trace_does_not_accept_previous_attempt(tmp_path):
    save_trace(tmp_path, trajectory(traceId="previous-attempt"), "tj-old.json")
    save_trace(tmp_path, trajectory())
    assert validate_native_trajectory(tmp_path, "attempt-1", TASK)["trajectory_id"] == "tj-task"


@pytest.mark.parametrize("complete", [False, True])
@pytest.mark.parametrize("exit_code", [0, 1])
def test_native_runner_gates_grading_and_preserves_generated_patch(tmp_path, monkeypatch, complete, exit_code):
    """Controlled process/evaluator boundaries verify the runner, not agent quality."""
    import asyncio
    from pathlib import Path
    import benchmarks.swe_bench.native as native
    from benchmarks.swe_bench.types import PatchStatus, SWEBenchConfig, SWEBenchInstance, SWEBenchResult

    patch = "diff --git a/code.py b/code.py\n--- a/code.py\n+++ b/code.py\n@@ -1 +1 @@\n-bad\n+good\n"
    managers = []
    traces = []
    evaluated = []

    class Manager:
        def __init__(self, workspace):
            self.cleaned = False
            managers.append(self)

        async def setup_repo(self, instance):
            repo = tmp_path / "checkout"
            repo.mkdir(exist_ok=True)
            return repo

        async def get_diff(self):
            return patch

        def cleanup_current_repo(self):
            self.cleaned = True

    class Process:
        returncode = exit_code

        async def wait(self):
            return exit_code

    async def create_process(*args, **kwargs):
        task = json.loads(Path(args[-1]).read_text())
        trace_id = kwargs["env"]["ELIZA_TRACE_ID"]
        traces.append(trace_id)
        record = trajectory(traceId=trace_id, status="finished" if complete else "running")
        record["rootMessage"]["text"] = task["prompt"] + "\n\nTask context (JSON):\n" + json.dumps(task["context"])
        save_trace(Path(kwargs["env"]["ELIZA_STATE_DIR"]) / "trajectories", record)
        kwargs["stdout"].write(json.dumps({"id": task["id"], "success": True, "actions_taken": ["EDIT"]}).encode())
        return Process()

    class Evaluator:
        async def evaluate_patch(self, instance, generated):
            assert complete, "Incomplete trajectory must never reach the evaluator"
            evaluated.append(generated)
            return SWEBenchResult(instance.instance_id, generated, PatchStatus.TESTS_PASSED, ["fixed"], [], True, 0, None)

    monkeypatch.setattr(native, "RepositoryManager", Manager)
    monkeypatch.setattr(native.asyncio, "create_subprocess_exec", create_process)
    instance = SWEBenchInstance("repo__task-1", "owner/repo", "base", "Fix behavior", "", "", "", "", [], [])
    config = SWEBenchConfig(output_dir=str(tmp_path / "output"), workspace_dir=str(tmp_path / "work"), model_name="test-model")
    results = [asyncio.run(native.run_native_instance(instance, Evaluator(), config)) for _ in range(2)]
    assert len(set(traces)) == 2
    assert all(manager.cleaned for manager in managers)
    assert all(result.generated_patch == patch for result in results)
    assert all(result.success is (complete and exit_code == 0) for result in results)
    if complete and exit_code == 0:
        assert evaluated == [patch, patch]
        assert len(list((tmp_path / "output").rglob("trace-evidence.json"))) == 2
    else:
        assert evaluated == []
        assert all(result.patch_status == PatchStatus.GENERATED for result in results)
        expected_error = "Native CLI exited 1" if exit_code else "trajectory is incomplete"
        assert all(expected_error in result.error for result in results)


def test_native_timeout_settles_child_and_retains_attempted_patch(tmp_path, monkeypatch):
    """Real subprocess timeout lifecycle; this is not an agent-quality test."""
    import asyncio
    import sys
    import benchmarks.swe_bench.native as native
    from benchmarks.swe_bench.types import PatchStatus, SWEBenchConfig, SWEBenchInstance

    processes = []
    cleaned = []
    patch = "diff --git a/code.py b/code.py\n--- a/code.py\n+++ b/code.py\n@@ -1 +1 @@\n-bad\n+attempt\n"
    ready = tmp_path / "attempted.patch"
    spawn = asyncio.create_subprocess_exec

    class Manager:
        def __init__(self, workspace):
            pass

        async def setup_repo(self, instance):
            return tmp_path

        async def get_diff(self):
            assert processes[0].returncode is not None
            return ready.read_text()

        def cleanup_current_repo(self):
            assert processes[0].returncode is not None
            cleaned.append(True)

    async def create_process(*args, **kwargs):
        process = await spawn(
            sys.executable, "-c",
            "from pathlib import Path; import time; "
            f"Path({str(ready)!r}).write_text({patch!r}); time.sleep(30)",
            **kwargs,
        )
        processes.append(process)
        # Avoid racing Python startup against the runner's deadline.
        for _ in range(200):
            if ready.exists():
                return process
            await asyncio.sleep(0.01)
        process.kill()
        await process.wait()
        raise AssertionError("Test subprocess did not initialize")

    class Evaluator:
        async def evaluate_patch(self, *_):
            raise AssertionError("Timed-out turns must not be graded")

    monkeypatch.setattr(native, "RepositoryManager", Manager)
    monkeypatch.setattr(native.asyncio, "create_subprocess_exec", create_process)
    instance = SWEBenchInstance("repo__task-1", "owner/repo", "base", "Fix behavior", "", "", "", "", [], [])
    config = SWEBenchConfig(output_dir=str(tmp_path / "output"), workspace_dir=str(tmp_path / "work"), model_name="test-model", timeout_seconds=1)
    result = asyncio.run(native.run_native_instance(instance, Evaluator(), config))
    assert result.success is False
    assert result.patch_status == PatchStatus.GENERATED
    assert result.generated_patch == patch
    assert "Native CLI exceeded" in result.error
    assert cleaned == [True]
    assert processes[0].returncode is not None
    assert next((tmp_path / "output").rglob("attempted.patch")).read_text() == patch
