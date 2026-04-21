"""Tests for orchestrator provider fallback parsing and edit behavior."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from types import SimpleNamespace
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_PYTHON_PKG = _ROOT / "packages" / "python"
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
sys.path.insert(0, str(_ROOT))
if _PYTHON_PKG.exists():
    sys.path.insert(0, str(_PYTHON_PKG))
if _ORCH_PKG.exists():
    sys.path.insert(0, str(_ORCH_PKG))

from elizaos_plugin_agent_orchestrator import (
    OrchestratedTask,
    OrchestratedTaskMetadata,
    ProviderTaskExecutionContext,
    TaskStatus,
    TaskUserStatus,
)
from benchmarks.swe_bench.orchestrator.providers import (
    ElizaCodeProvider,
    SWEAgentProvider,
    SWEBenchTraceHook,
)
from benchmarks.swe_bench.repo_manager import RepositoryManager


class _RuntimeStub:
    agent_id = "test-agent"


@pytest.fixture
def eliza_provider(tmp_path):
    """Create an ElizaCodeProvider with a temporary repo manager."""
    manager = RepositoryManager(str(tmp_path / "workspace"))
    return ElizaCodeProvider(
        runtime=_RuntimeStub(),
        repo_manager=manager,
        max_steps=5,
    )


def test_parse_fallback_action_response_accepts_json_params(eliza_provider) -> None:
    """Fallback parser should accept JSON PARAMS blocks."""
    text = (
        "DISCUSSION: apply fix\n\n"
        "ACTION: EDIT_FILE\n"
        "PARAMS:\n"
        "{\n"
        '  "file_path": "astropy/modeling/separable.py",\n'
        '  "old_str": "foo",\n'
        '  "new_str": "bar"\n'
        "}"
    )
    action, params = eliza_provider._parse_fallback_action_response(text)
    assert action == "EDIT_FILE"
    assert params["file_path"] == "astropy/modeling/separable.py"
    assert params["old_str"] == "foo"
    assert params["new_str"] == "bar"


def test_parse_fallback_action_response_trims_clipped_noise(eliza_provider) -> None:
    """Parser should not include clipped transcript noise in scalar params."""
    text = (
        "DISCUSSION: inspect file\n\n"
        "ACTION: READ_FILE\n"
        "PARAMS:\n"
        "  file_path: astropy/modeling/separable.py\n\n"
        "<response clipped><NOTE>content omitted</NOTE>\n"
        "Step 21: ACTION=READ_FILE\n"
        "PARAMS={'file_path': 'astropy/modeling/separable.py'}"
    )
    action, params = eliza_provider._parse_fallback_action_response(text)
    assert action == "READ_FILE"
    assert params == {"file_path": "astropy/modeling/separable.py"}


@pytest.mark.asyncio
async def test_edit_file_fallback_replaces_symbol_when_old_str_misses(
    eliza_provider,
    tmp_path,
) -> None:
    """EDIT_FILE should fall back to replacing a top-level symbol block."""
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True, exist_ok=True)
    source_file = repo_root / "sample.py"
    source_file.write_text(
        "def sample():\n"
        "    \"\"\"original docstring\"\"\"\n"
        "    return 1\n\n"
        "def untouched():\n"
        "    return 2\n",
        encoding="utf-8",
    )

    manager = eliza_provider.repo_manager
    manager.current_repo = repo_root
    manager._current_repo_resolved = repo_root.resolve()

    ok, message = await eliza_provider._execute_tool(
        "EDIT_FILE",
        {
            "file_path": "sample.py",
            "old_str": "def sample():\n    \"\"\"different docstring\"\"\"\n    return 1",
            "new_str": "def sample():\n    return 42",
        },
        _ctx=None,  # _execute_tool does not use context for EDIT_FILE.
    )
    assert ok
    assert "fallback" in message

    updated = source_file.read_text(encoding="utf-8")
    assert "def sample():\n    return 42\n" in updated
    assert "def untouched():" in updated


def test_parse_swe_agent_response_accepts_json_params(tmp_path) -> None:
    """SWE-Agent parser should handle JSON-style PARAMS blocks."""
    provider = SWEAgentProvider(
        runtime=_SingleResponseRuntime(""),
        repo_manager=RepositoryManager(str(tmp_path / "workspace")),
        max_steps=1,
    )
    text = (
        "DISCUSSION: apply change\n"
        "ACTION: EDIT_FILE\n"
        "PARAMS:\n"
        "{\n"
        '  "file_path": "sample.py",\n'
        '  "old_str": "return 1",\n'
        '  "new_str": "return 2"\n'
        "}"
    )
    action, params = provider._parse_swe_agent_response(text)
    assert action == "EDIT_FILE"
    assert params["file_path"] == "sample.py"
    assert params["old_str"] == "return 1"
    assert params["new_str"] == "return 2"


def test_parse_swe_agent_response_preserves_multiline_edit_values(tmp_path) -> None:
    """SWE-Agent parser should preserve multiline old/new edit blocks."""
    provider = SWEAgentProvider(
        runtime=_SingleResponseRuntime(""),
        repo_manager=RepositoryManager(str(tmp_path / "workspace")),
        max_steps=1,
    )
    text = (
        "DISCUSSION: apply patch\n"
        "ACTION: EDIT_FILE\n"
        "PARAMS:\n"
        "  file_path: sample.py\n"
        "  old_str: \"\"\"def sample():\n"
        "      return 1\n"
        "  \"\"\"\n"
        "  new_str: \"\"\"def sample():\n"
        "      return 2\n"
        "  \"\"\"\n"
    )
    action, params = provider._parse_swe_agent_response(text)
    assert action == "EDIT_FILE"
    assert params["file_path"] == "sample.py"
    assert str(params["old_str"]).strip() == "def sample():\n      return 1"
    assert str(params["new_str"]).strip() == "def sample():\n      return 2"


class _SingleResponseRuntime:
    agent_id = "test-agent"

    def __init__(self, response_text: str) -> None:
        self._response_text = response_text

    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        _ = model_type, params
        return self._response_text


@pytest.mark.asyncio
async def test_swe_trace_hook_flushes_events() -> None:
    events: list[tuple[str, str, dict[str, object]]] = []

    async def _trace_fn(actor: str, event: str, data: dict[str, object]) -> None:
        events.append((actor, event, data))

    hook = SWEBenchTraceHook(
        loop=asyncio.get_running_loop(),
        trace_fn=_trace_fn,
    )
    hook.on_run_start()
    hook.on_step_done(
        SimpleNamespace(
            thought="think",
            action="ACT",
            output="ok",
            submission=None,
        ),
        None,
    )
    hook.on_run_done(None, None)
    await hook.flush()

    assert [event for _, event, _ in events] == ["run_start", "step_done", "run_done"]


@pytest.mark.asyncio
async def test_swe_agent_auto_submits_when_patch_exists(tmp_path) -> None:
    """SWE-Agent should auto-submit if patch exists at max-step boundary."""
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    source_file = repo_root / "sample.py"
    source_file.write_text("def sample():\n    return 1\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "sample.py"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    manager = RepositoryManager(str(tmp_path / "workspace"))
    manager.current_repo = repo_root
    manager._current_repo_resolved = repo_root.resolve()

    response_text = (
        "DISCUSSION: apply direct edit\n"
        "ACTION: EDIT_FILE\n"
        "PARAMS:\n"
        "  file_path: sample.py\n"
        "  old_str: return 1\n"
        "  new_str: return 2"
    )
    provider = SWEAgentProvider(
        runtime=_SingleResponseRuntime(response_text),
        repo_manager=manager,
        max_steps=1,
    )

    async def append_output(_text: str) -> None:
        return None

    async def update_progress(_value: int) -> None:
        return None

    async def update_step(_step_id: str, _status: TaskStatus, _output: str | None) -> None:
        return None

    task = OrchestratedTask(
        id="task-1",
        name="auto-submit-test",
        description="Update sample function.",
        tags=[],
        metadata=OrchestratedTaskMetadata(
            status=TaskStatus.PENDING,
            progress=0,
            output=[],
            steps=[],
            working_directory=str(repo_root),
            provider_id="swe-agent",
            provider_label="SWE-Agent",
            sub_agent_type="swe-agent",
            user_status=TaskUserStatus.OPEN,
            user_status_updated_at=int(time.time() * 1000),
            files_created=[],
            files_modified=[],
            created_at=int(time.time() * 1000),
        ),
    )
    ctx = ProviderTaskExecutionContext(
        runtime_agent_id="test-agent",
        working_directory=str(repo_root),
        append_output=append_output,
        update_progress=update_progress,
        update_step=update_step,
        is_cancelled=lambda: False,
        is_paused=lambda: False,
    )

    result = await provider.execute_task(task, ctx)
    assert result.success
    assert result.extra.get("submitted") is True
    updated = source_file.read_text(encoding="utf-8")
    assert "return 2" in updated
