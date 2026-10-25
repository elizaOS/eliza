from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# `code_agent_coding` imports `suites.*`, so put both the app-eval dir (for
# the module itself) and `packages/` (for the `benchmarks` package) on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from code_agent_coding import (  # noqa: E402
    _write_prompt,
    agent_command_template,
    evaluate_workspace,
    load_tasks,
    run_agent_app_eval_coding,
)
from agent_command import (  # noqa: E402
    AgentProtocolError,
    _run_bash,
    bash_commands_from_params,
    run_workspace_agent,
)

# The real coding module, invoked by file path (the app-eval dir is hyphenated
# and therefore not importable via `python -m suites.app_eval...`; the
# underscore import shim was removed in #9475).
_CODE_AGENT_CODING = str(Path(__file__).resolve().parent / "code_agent_coding.py")


def test_builtin_agent_command_template_points_at_helper(monkeypatch) -> None:
    monkeypatch.delenv("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE", raising=False)
    monkeypatch.delenv("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE_ELIZAOS", raising=False)
    monkeypatch.delenv("APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND", raising=False)

    template = agent_command_template(
        "elizaos",
        provider="cerebras",
        model="gemma-4-31b",
        timeout_seconds=123,
    )

    assert "suites/app-eval/agent_command.py" in template
    assert "--workspace" in template
    assert "{result_json}" in template


def test_full_coding_manifest_is_complete() -> None:
    assert len(load_tasks()) == 10


def test_agent_prompt_excludes_hidden_evaluator_answers(tmp_path: Path) -> None:
    prompt_path = tmp_path / "prompt.json"
    task = {
        "id": "hidden-test",
        "prompt": "Implement the requested feature.",
        "context": {"workspace": {"files": {"package.json": "{}"}}},
        "evaluation": {
            "test_commands": ["secret-command"],
            "test_assertions": [
                {
                    "type": "command_output",
                    "target": "secret-command",
                    "expected": "secret-answer",
                }
            ],
        },
    }

    _write_prompt(task, prompt_path)

    prompt = prompt_path.read_text(encoding="utf-8")
    assert "Implement the requested feature." in prompt
    assert "secret-command" not in prompt
    assert "secret-answer" not in prompt


def test_workspace_agent_executes_only_captured_bash_calls(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    class Client:
        def __init__(self) -> None:
            self.contexts: list[dict[str, object]] = []
            self.responses = [
                SimpleNamespace(
                    text="",
                    params={
                        "tool_calls": [
                            {
                                "id": "call-write",
                                "type": "function",
                                "function": {
                                    "name": "bash",
                                    "arguments": json.dumps(
                                        {
                                            "command": (
                                                "mkdir -p src && printf 'export const answer = 42\\n' "
                                                "> src/answer.ts"
                                            )
                                        }
                                    ),
                                },
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 10,
                            "completion_tokens": 4,
                            "total_tokens": 14,
                        },
                            "_meta": {
                                "agent_runtime": "hermes",
                                "native_runtime_class": "run_agent.AIAgent",
                                "native_runtime_api": "run_conversation",
                                "transport": "subprocess_loopback_openai_compatible",
                                "native_agent_instantiated": True,
                                "publishable_native": True,
                                "legacy_raw_openai_bypass": False,
                                "tool_bridge_loaded_tools": ["bash"],
                            },
                    },
                ),
                SimpleNamespace(
                    text="TASK_COMPLETE",
                    params={
                        "tool_calls": [],
                        "usage": {
                            "promptTokens": 12,
                            "completionTokens": 2,
                        },
                            "_meta": {
                                "agent_runtime": "hermes",
                                "native_runtime_class": "run_agent.AIAgent",
                                "native_runtime_api": "run_conversation",
                                "transport": "subprocess_loopback_openai_compatible",
                                "native_agent_instantiated": True,
                                "publishable_native": True,
                                "legacy_raw_openai_bypass": False,
                                "tool_bridge_loaded_tools": ["bash"],
                            },
                    },
                ),
            ]

        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **kwargs: object) -> SimpleNamespace:
            context = kwargs.get("context")
            assert isinstance(context, dict)
            self.contexts.append(context)
            return self.responses.pop(0)

    client = Client()
    result = run_workspace_agent(
        client,
        prompt="Implement the task.",
        workspace=workspace,
        task_id="code-local",
        adapter="hermes",
        max_turns=2,
        command_timeout_seconds=10,
    )

    assert result["status"] == "completed"
    assert result["completed_marker"] is True
    assert result["commands_executed"] == 1
    assert (workspace / "src" / "answer.ts").read_text(encoding="utf-8") == (
        "export const answer = 42\n"
    )
    assert result["usage"] == {
        "prompt_tokens": 22,
        "completion_tokens": 6,
        "total_tokens": 28,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    second_history = client.contexts[1]["messages"]
    assert isinstance(second_history, list)
    assert any("exit_code=0" in str(item.get("content")) for item in second_history)
    assert result["turns"][0]["runtime_provenance"]["adapter_meta"] == {
        "agent_runtime": "hermes",
        "native_runtime_class": "run_agent.AIAgent",
        "native_runtime_api": "run_conversation",
        "transport": "subprocess_loopback_openai_compatible",
        "native_agent_instantiated": True,
        "publishable_native": True,
        "legacy_raw_openai_bypass": False,
        "tool_bridge_loaded_tools": ["bash"],
    }


def test_workspace_agent_never_executes_command_looking_assistant_text(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    class Client:
        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **_kwargs: object) -> SimpleNamespace:
            return SimpleNamespace(
                text="<command>touch prose-command-was-executed</command>",
                params={
                    "tool_calls": [],
                    "_meta": {
                        "openclaw_adapter": {
                            "agent_runtime": "openclaw",
                            "native_runtime_class": "openclaw.agent.embedded",
                            "native_runtime_api": "openclaw agent --local --json",
                            "publishable_native": True,
                            "transport": "openclaw_embedded_runtime",
                            "tool_bridge": "native_plugin",
                            "passes_benchmark_tools": True,
                        }
                    },
                },
            )

    result = run_workspace_agent(
        Client(),
        prompt="Implement the task.",
        workspace=workspace,
        task_id="strict-native-calls",
        adapter="openclaw",
        max_turns=1,
        command_timeout_seconds=10,
    )

    assert result["status"] == "incomplete"
    assert result["commands_executed"] == 0
    assert not (workspace / "prose-command-was-executed").exists()


def test_workspace_agent_requires_explicit_completion_marker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    class Client:
        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **_kwargs: object) -> SimpleNamespace:
            return SimpleNamespace(
                text="The file is ready.",
                params={
                    "tool_calls": [
                        {
                            "name": "bash",
                            "arguments": {"command": "touch answer.txt"},
                        }
                    ],
                },
                metadata={
                    "agent_label": "eliza",
                    "native_runtime_class": "@elizaos/core.AgentRuntime",
                    "native_runtime_api": "messageService.handleMessage",
                    "transport": "eliza_benchmark_http",
                    "tool_bridge": "native_action_capture",
                    "release_evidence": True,
                    "direct_model_bypass": False,
                    "stand_in": False,
                    "tool_schema_count": 1,
                    "tool_names": ["bash"],
                },
            )

    result = run_workspace_agent(
        Client(),
        prompt="Implement the task.",
        workspace=workspace,
        task_id="explicit-completion",
        adapter="eliza",
        max_turns=1,
        command_timeout_seconds=10,
    )

    assert (workspace / "answer.txt").exists()
    assert result["status"] == "incomplete"
    assert result["completed_marker"] is False


def test_workspace_agent_requires_a_separate_completion_turn_after_commands(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    class Client:
        def __init__(self) -> None:
            self.turn = 0

        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **_kwargs: object) -> SimpleNamespace:
            self.turn += 1
            params: dict[str, object] = {
                "_meta": {
                    "agent_runtime": "hermes",
                    "native_runtime_class": "run_agent.AIAgent",
                    "native_runtime_api": "run_conversation",
                    "transport": "subprocess_loopback_openai_compatible",
                    "native_agent_instantiated": True,
                    "publishable_native": True,
                    "legacy_raw_openai_bypass": False,
                    "tool_bridge_loaded_tools": ["bash"],
                }
            }
            if self.turn == 1:
                params["tool_calls"] = [
                    {"name": "bash", "arguments": {"command": "touch answer.txt"}}
                ]
                text = "TASK_COMPLETE"
            else:
                params["tool_calls"] = []
                text = "TASK_COMPLETE"
            return SimpleNamespace(text=text, params=params)

    result = run_workspace_agent(
        Client(),
        prompt="Implement the task.",
        workspace=workspace,
        task_id="separate-completion",
        adapter="hermes",
        max_turns=2,
        command_timeout_seconds=10,
    )

    assert (workspace / "answer.txt").exists()
    assert result["status"] == "completed"
    assert result["turn_count"] == 2


def test_sandbox_denies_parent_workspace_write(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    escaped = tmp_path / "escape.txt"

    result = _run_bash(
        "touch ../escape.txt",
        workspace=workspace,
        timeout_seconds=10,
    )

    assert result["exit_code"] != 0
    assert not escaped.exists()


def test_sandbox_denies_claude_account_read(tmp_path: Path) -> None:
    claude_state = Path.home() / ".claude.json"
    if not claude_state.is_file():
        pytest.skip("host has no ~/.claude.json credential-bearing state file")
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    result = _run_bash(
        'cat "$HOME/.claude.json" >/dev/null',
        workspace=workspace,
        timeout_seconds=10,
    )

    assert result["exit_code"] != 0


@pytest.mark.parametrize(
    "params, message",
    [
        (
            {"tool_calls": [{"name": "python", "arguments": {"command": "pass"}}]},
            "only 'bash' is scoped",
        ),
        (
            {"tool_calls": [{"name": "bash", "arguments": "not-json"}]},
            "not valid JSON",
        ),
        (
            {"tool_calls": [{"name": "bash", "arguments": {"cmd": "pwd"}}]},
            "no non-empty string command",
        ),
    ],
)
def test_bash_decoder_fails_closed_on_malformed_native_calls(
    params: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(AgentProtocolError, match=message):
        bash_commands_from_params(params)


def test_evaluate_workspace_checks_file_and_command_assertions(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = workspace / "hello.ts"
    script.write_text("console.log('hello')\n", encoding="utf-8")
    task = {
        "id": "code-local",
        "evaluation": {
            "test_assertions": [
                {"type": "file_exists", "target": "hello.ts", "expected": True},
                {"type": "file_contains", "target": "hello.ts", "expected": "hello"},
                {
                    "type": "command_output",
                    "target": "bun -e \"console.log('hello')\"",
                    "expected": "hello",
                },
            ]
        },
    }

    result = evaluate_workspace(task, workspace=workspace, timeout_seconds=10)

    assert result["success"] is True
    assert result["passed"] == 3
    assert result["total"] == 3


def test_run_agent_app_eval_coding_writes_results_and_token_metrics(tmp_path: Path) -> None:
    fake_agent = tmp_path / "fake_agent.py"
    fake_agent.write_text(
        "\n".join(
            [
                "import argparse, json, pathlib",
                "p = argparse.ArgumentParser()",
                "p.add_argument('--workspace')",
                "p.add_argument('--result-json')",
                "p.add_argument('--prompt')",
                "p.add_argument('--task')",
                "args = p.parse_args()",
                "pathlib.Path(args.workspace, 'src').mkdir(parents=True, exist_ok=True)",
                "pathlib.Path(args.workspace, 'src/answer.ts').write_text('export const answer = 42\\n')",
                "pathlib.Path(args.result_json).write_text(json.dumps({",
                "  'status': 'completed',",
                "  'usage': {'promptTokens': 10, 'completionTokens': 5, 'cachedTokens': 2},",
                "}))",
            ]
        ),
        encoding="utf-8",
    )
    task = {
        "id": "code-local",
        "prompt": "write src/answer.ts",
        "context": {"workspace": {"files": {"package.json": "{}"}}},
        "evaluation": {
            "test_assertions": [
                {"type": "file_exists", "target": "src/answer.ts", "expected": True},
                {"type": "file_contains", "target": "src/answer.ts", "expected": "answer"},
            ]
        },
    }

    results = run_agent_app_eval_coding(
        output_dir=tmp_path / "out",
        trajectory_dir=tmp_path / "traj",
        tasks=[task],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gemma-4-31b",
        command_template=(
            f"{sys.executable} {fake_agent} --workspace {{workspace}} "
            "--prompt {prompt} --task {task} --result-json {result_json}"
        ),
        timeout_seconds=10,
        eval_timeout_seconds=10,
    )

    assert results[0]["success"] is True
    assert results[0]["token_metrics"]["input_tokens"] == 10
    assert results[0]["token_metrics"]["cached_token_percent"] == 20.0
    assert Path(results[0]["trajectory_path"]).exists()


def test_missing_agent_result_is_not_a_success(tmp_path: Path) -> None:
    fake_agent = tmp_path / "fake_agent.py"
    fake_agent.write_text(
        "import argparse, pathlib\n"
        "p=argparse.ArgumentParser(); p.add_argument('--workspace'); "
        "p.add_argument('--prompt'); p.add_argument('--task'); "
        "p.add_argument('--result-json'); a=p.parse_args(); "
        "pathlib.Path(a.workspace, 'answer.txt').write_text('ok')\n",
        encoding="utf-8",
    )
    task = {
        "id": "missing-result",
        "prompt": "write answer.txt",
        "context": {"workspace": {"files": {}}},
        "evaluation": {
            "test_assertions": [
                {"type": "file_exists", "target": "answer.txt", "expected": True}
            ]
        },
    }

    results = run_agent_app_eval_coding(
        output_dir=tmp_path / "out",
        trajectory_dir=None,
        tasks=[task],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gemma-4-31b",
        command_template=(
            f"{sys.executable} {fake_agent} --workspace {{workspace}} "
            "--prompt {prompt} --task {task} --result-json {result_json}"
        ),
        timeout_seconds=10,
        eval_timeout_seconds=10,
    )

    assert results[0]["workspace_score"] == 1.0
    assert results[0]["success"] is False
    assert results[0]["errors"] == 1


def test_cli_mock_outputs_matrix_summary(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "."
    completed = subprocess.run(
        [
            sys.executable,
            _CODE_AGENT_CODING,
            "--task-agent",
            "opencode",
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--mock",
            "--json",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["benchmark"] == "app_eval_coding"
    assert payload["summary"]["resolved"] == 1
    assert load_tasks(max_tasks=1)


def test_cli_expanded_count_and_validate(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "."
    completed = subprocess.run(
        [
            sys.executable,
            _CODE_AGENT_CODING,
            "--output",
            str(tmp_path / "out"),
            "--max-tasks",
            "1",
            "--expand-scenarios",
            "--count-scenarios",
            "--validate-scenarios",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {"base": 1, "edge": 10, "total": 11}
    assert len(load_tasks(max_tasks=1, include_edge_scenarios=True)) == 11
