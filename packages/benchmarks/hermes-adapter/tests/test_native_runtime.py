"""Native Hermes bridge tests using deterministic fake upstream modules.

No test contacts a model endpoint. The fakes implement only the pinned
``run_agent.AIAgent`` lifecycle while the generated plugin itself is imported
and exercised through a fake ``PluginContext``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from benchmarks.orchestrator_lifecycle.contract import LIFECYCLE_SYSTEM_HINT
from hermes_adapter.native_runtime import (
    HEALTH_TOOL_NAME,
    NATIVE_RUNTIME_CLASS,
    NATIVE_TRANSPORT,
    PLUGIN_ID,
    PLUGIN_TOOLSET,
    NativeRuntimeError,
    is_loopback_base_url,
    prepare_scoped_benchmark_plugin,
    run_health_probe,
    run_native_turn,
)


def _tool(name: str = "lookup") -> dict[str, object]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": "Look up a benchmark record.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }


def _lifecycle_tool() -> dict[str, object]:
    contract_path = (
        Path(__file__).resolve().parents[2]
        / "orchestrator_lifecycle"
        / "tasks-tool.json"
    )
    payload = json.loads(contract_path.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def _payload(
    repo_path: Path,
    home: Path,
    bridge: object,
    *,
    tools: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "repo_path": str(repo_path),
        "workspace_path": str(Path.cwd().resolve()),
        "hermes_home": str(home),
        "bridge": bridge.as_payload(),
        "text": "find the orchid",
        "context": {
            "messages": [
                {"role": "system", "content": "Use the listed tool."},
                {"role": "user", "content": "prior question"},
                {"role": "assistant", "content": "prior answer"},
                {"role": "user", "content": "find the orchid"},
            ]
        },
        "system_prompt": "Benchmark instructions",
        "tools": tools,
        "model": "claude-sonnet-test",
        "base_url": "http://127.0.0.1:9411/v1",
        "api_key": "gateway-token",
        "temperature": 0.2,
        "reasoning_effort": "low",
        "max_tokens": 2048,
        "tool_choice": "required",
        "task_id": "case-1",
        "benchmark": "bfcl",
    }


def _fake_run_agent(
    repo_path: Path,
    home: Path,
    expected_names: list[str],
    *,
    extra_names: tuple[str, ...] = (),
    invocations: list[tuple[str, dict[str, object]]] | None = None,
    result_overrides: dict[str, object] | None = None,
    honor_capture_terminal_hint: bool = False,
) -> tuple[ModuleType, type[Any]]:
    module_path = repo_path / "run_agent.py"
    module_path.write_text("# deterministic fake upstream\n", encoding="utf-8")
    module = ModuleType("run_agent")
    module.__file__ = str(module_path)

    class AIAgent:
        instances: list[Any] = []

        def __init__(self, **kwargs: object) -> None:
            self.kwargs = dict(kwargs)
            self.request_overrides = dict(kwargs.get("request_overrides") or {})
            self.valid_tool_names = set(expected_names) | set(extra_names)
            self.closed = False
            self.interrupt_message: str | None = None
            self.run_args: tuple[object, ...] | None = None
            self.run_kwargs: dict[str, object] | None = None
            type(self).instances.append(self)

        def run_conversation(
            self, *args: object, **kwargs: object
        ) -> dict[str, object]:
            self.run_args = args
            self.run_kwargs = dict(kwargs)
            history = list(kwargs.get("conversation_history") or [])
            messages: list[dict[str, object]] = [
                *history,
                {"role": "user", "content": args[0]},
            ]
            turn_invocations = (
                invocations
                if invocations is not None
                else [(expected_names[0], {"query": "orchid"})]
                if expected_names
                else []
            )
            if honor_capture_terminal_hint:
                system_message = kwargs.get("system_message")
                assert isinstance(system_message, str)
                if (
                    "terminal for the current user turn" in system_message
                    and "do not retry it or substitute another TASKS action solely"
                    in system_message
                ):
                    turn_invocations = turn_invocations[:1]
            executed_invocations = 0
            if turn_invocations:
                bridge = json.loads(
                    (home / "plugins" / PLUGIN_ID / "bridge.json").read_text(
                        encoding="utf-8"
                    )
                )
                callback = self.kwargs.get("tool_complete_callback")
                assert callable(callback)
                for sequence, (name, arguments) in enumerate(turn_invocations):
                    benchmark_config = next(
                        (
                            tool.get("x-eliza-benchmark", {})
                            for tool in bridge["tools"]
                            if tool["function"]["name"] == name
                        ),
                        {},
                    )
                    outcome = {
                        **benchmark_config.get("result", {"captured": True}),
                        "sequence": sequence,
                        "tool": name,
                    }
                    with Path(bridge["capture_path"]).open(
                        "a", encoding="utf-8"
                    ) as handle:
                        handle.write(
                            json.dumps(
                                {
                                    "sequence": sequence,
                                    "name": name,
                                    "arguments": arguments,
                                    "result": outcome,
                                    "task_id": str(kwargs.get("task_id") or ""),
                                    "session_id": "fake-session",
                                },
                                sort_keys=True,
                            )
                            + "\n"
                        )
                    call_id = f"call-native-{sequence + 1}"
                    tool_call = {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments, sort_keys=True),
                        },
                    }
                    messages.extend(
                        [
                            {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [tool_call],
                            },
                            {
                                "role": "tool",
                                "name": name,
                                "tool_call_id": call_id,
                                "content": '{"captured":true}',
                            },
                        ]
                    )
                    callback(call_id, name, arguments, "captured")
                    executed_invocations += 1
                    if self.interrupt_message is not None:
                        break
            interrupted = self.interrupt_message is not None
            if not interrupted:
                messages.append({"role": "assistant", "content": "done"})
            result: dict[str, object] = {
                "final_response": "" if interrupted else "done",
                "last_reasoning": "native reasoning",
                "messages": messages,
                "api_calls": executed_invocations
                if interrupted
                else executed_invocations + 1,
                "completed": not interrupted,
                "failed": False,
                "interrupted": interrupted,
                "turn_exit_reason": (
                    "interrupted_by_user"
                    if interrupted
                    else "text_response(finish_reason=stop)"
                ),
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_tokens": 30,
                "cache_write_tokens": 4,
                "reasoning_tokens": 6,
            }
            result.update(result_overrides or {})
            return result

        def interrupt(self, message: str | None = None) -> None:
            self.interrupt_message = message

        def close(self) -> None:
            self.closed = True

    AIAgent.__module__ = "run_agent"
    module.AIAgent = AIAgent  # type: ignore[attr-defined]
    return module, AIAgent


@pytest.mark.parametrize(
    "url",
    (
        "http://localhost:8000/v1",
        "http://127.0.0.1:8000/v1",
        "http://127.42.3.9/v1",
        "http://[::1]:8000/v1",
    ),
)
def test_loopback_url_accepts_only_local_hosts(url: str) -> None:
    assert is_loopback_base_url(url) is True


@pytest.mark.parametrize(
    "url",
    ("https://api.openai.com/v1", "http://localhost.evil/v1", "not-a-url", ""),
)
def test_loopback_url_rejects_remote_or_invalid_hosts(url: str) -> None:
    assert is_loopback_base_url(url) is False


def test_generated_plugin_registers_only_scoped_tools_and_captures_calls(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    spec = prepare_scoped_benchmark_plugin(
        home,
        [_tool("lookup")],
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    module_spec = importlib.util.spec_from_file_location(
        "hermes_plugins.eliza_benchmark_tools",
        spec.plugin_dir / "__init__.py",
    )
    assert module_spec is not None and module_spec.loader is not None
    plugin = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(plugin)

    registrations: list[dict[str, object]] = []

    class Context:
        def register_tool(self, **kwargs: object) -> None:
            registrations.append(dict(kwargs))

    plugin.register(Context())
    assert len(registrations) == 1
    registration = registrations[0]
    assert registration["name"] == "lookup"
    assert registration["toolset"] == PLUGIN_TOOLSET
    assert registration["override"] is True
    handler = registration["handler"]
    assert callable(handler)
    result = json.loads(handler({"query": "orchid"}, task_id="case-1"))
    assert result == {"captured": True, "sequence": 0, "tool": "lookup"}
    capture = json.loads(spec.capture_path.read_text(encoding="utf-8"))
    assert capture["name"] == "lookup"
    assert capture["arguments"] == {"query": "orchid"}

    config = json.loads((home / "config.yaml").read_text(encoding="utf-8"))
    assert config["plugins"]["enabled"] == [PLUGIN_ID]
    assert config["plugins"]["entries"][PLUGIN_ID]["allow_tool_override"] is True
    assert config["tools"]["tool_search"]["enabled"] == "off"


def test_generated_plugin_returns_shared_capture_only_result_in_sequence(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    contract = _lifecycle_tool()
    spec = prepare_scoped_benchmark_plugin(
        home,
        [contract],
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    module_spec = importlib.util.spec_from_file_location(
        "hermes_plugins.eliza_benchmark_tasks",
        spec.plugin_dir / "__init__.py",
    )
    assert module_spec is not None and module_spec.loader is not None
    plugin = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(plugin)
    registrations: list[dict[str, object]] = []

    class Context:
        def register_tool(self, **kwargs: object) -> None:
            registrations.append(dict(kwargs))

    plugin.register(Context())
    assert registrations[0]["description"] == contract["function"]["description"]
    assert (
        registrations[0]["schema"]["parameters"] == contract["function"]["parameters"]
    )
    handler = registrations[0]["handler"]
    assert callable(handler)

    first = json.loads(handler({"action": "spawn_agent", "task": "fix tests"}))
    second = json.loads(handler({"action": "list_agents"}))

    assert first == {
        "captured": True,
        "effect": "not_executed",
        "sequence": 0,
        "tool": "TASKS",
    }
    assert second == {
        "captured": True,
        "effect": "not_executed",
        "sequence": 1,
        "tool": "TASKS",
    }


def test_native_turn_uses_aia_agent_loop_and_emits_gate_provenance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool("lookup")]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(repo_path, home, ["lookup"])

    result = run_native_turn(
        _payload(repo_path, home, bridge, tools=tools),
        module_loader=lambda name: module,
    )

    assert result["text"] == "done"
    assert result["thought"] == "native reasoning"
    assert result["actions"] == ["lookup"]
    params = result["params"]
    assert params["tool_calls"] == [
        {
            "id": "call-native-1",
            "name": "lookup",
            "arguments": '{"query": "orchid"}',
        }
    ]
    assert params["usage"]["cache_read_input_tokens"] == 30
    meta = params["_meta"]
    assert meta["agent_runtime"] == "hermes"
    assert meta["native_runtime_class"] == NATIVE_RUNTIME_CLASS
    assert meta["transport"] == NATIVE_TRANSPORT
    assert meta["publishable_native"] is True
    assert meta["tool_bridge_captured_calls"] == 1
    assert meta["capture_stop_after_scored_action"] is False

    instance = agent_class.instances[-1]
    assert instance.kwargs["base_url"] == "http://127.0.0.1:9411/v1"
    assert instance.kwargs["provider"] == "custom"
    assert instance.kwargs["api_mode"] == "chat_completions"
    assert instance.kwargs["enabled_toolsets"] == [PLUGIN_TOOLSET]
    assert instance.kwargs["skip_context_files"] is True
    assert instance.kwargs["skip_memory"] is True
    assert instance.kwargs["max_iterations"] == 2
    assert instance.request_overrides["tool_choice"] == "auto"
    assert instance.closed is True
    assert instance.run_args == ("find the orchid",)
    assert instance.run_kwargs["system_message"].startswith("Use the listed tool.")
    assert instance.run_kwargs["conversation_history"] == [
        {"role": "user", "content": "prior question"},
        {"role": "assistant", "content": "prior answer"},
    ]


def test_action_calling_stops_after_the_scored_native_action(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool("lookup")]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        ["lookup"],
        invocations=[
            ("lookup", {"query": "orchid"}),
            ("lookup", {"query": "unscored-follow-up"}),
        ],
    )
    payload = _payload(repo_path, home, bridge, tools=tools)
    payload["benchmark"] = "action-calling"

    result = run_native_turn(payload, module_loader=lambda name: module)

    assert result["text"] == ""
    assert result["actions"] == ["lookup"]
    meta = result["params"]["_meta"]
    assert meta["capture_stop_after_scored_action"] is True
    assert meta["native_api_calls"] == 1
    assert meta["native_completed"] is False
    assert meta["native_failed"] is False
    assert meta["native_interrupted"] is True
    assert meta["native_turn_exit_reason"] == "interrupted_by_user"
    assert (
        agent_class.instances[-1].interrupt_message
        == "benchmark_scored_action_captured"
    )


def test_caller_declared_capture_stop_stops_after_first_tool_batch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The env-owned contract (``capture_stop`` payload flag, declared by the
    harness proxy for single-step env turns) must end the native loop at the
    first captured batch — the failure mode it guards is the tblite turn dying
    at max_iterations_reached while looping on bridge acknowledgements."""
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool("lookup")]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        ["lookup"],
        invocations=[
            ("lookup", {"query": "orchid"}),
            ("lookup", {"query": "unscored-follow-up"}),
        ],
    )
    payload = _payload(repo_path, home, bridge, tools=tools)
    payload["capture_stop"] = True

    result = run_native_turn(payload, module_loader=lambda name: module)

    assert result["actions"] == ["lookup"]
    meta = result["params"]["_meta"]
    assert meta["capture_stop_after_scored_action"] is True
    assert meta["native_api_calls"] == 1
    assert meta["native_interrupted"] is True
    assert meta["native_turn_exit_reason"] == "interrupted_by_user"
    assert (
        agent_class.instances[-1].interrupt_message
        == "benchmark_scored_action_captured"
    )


def test_lifecycle_turn_consumes_explicit_history_and_allows_two_tool_rounds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_lifecycle_tool()]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        ["TASKS"],
        invocations=[
            ("TASKS", {"action": "spawn_agent", "task": "fix tests"}),
            ("TASKS", {"action": "list_agents"}),
        ],
    )
    payload = _payload(repo_path, home, bridge, tools=tools)
    payload["benchmark"] = "orchestrator_lifecycle"
    payload["context"] = {
        "benchmark_messages": [
            {"role": "user", "content": "Cancel this task."},
            {"role": "assistant", "content": "The task is cancelled."},
        ]
    }

    result = run_native_turn(payload, module_loader=lambda name: module)

    instance = agent_class.instances[-1]
    assert result["actions"] == ["TASKS", "TASKS"]
    assert [
        json.loads(call["arguments"])["action"]
        for call in result["params"]["tool_calls"]
    ] == ["spawn_agent", "list_agents"]
    assert result["params"]["_meta"]["tool_bridge_captured_calls"] == 2
    assert result["params"]["_meta"]["native_api_calls"] == 3
    assert result["params"]["lifecycle_results"] == [
        {
            "name": "TASKS",
            "arguments": {"action": "spawn_agent", "task": "fix tests"},
            "result": {
                "captured": True,
                "effect": "not_executed",
                "sequence": 0,
                "tool": "TASKS",
            },
        },
        {
            "name": "TASKS",
            "arguments": {"action": "list_agents"},
            "result": {
                "captured": True,
                "effect": "not_executed",
                "sequence": 1,
                "tool": "TASKS",
            },
        },
    ]
    assert instance.kwargs["max_iterations"] == 4
    assert instance.run_args == ("find the orchid",)
    assert instance.run_kwargs["conversation_history"] == [
        {"role": "user", "content": "Cancel this task."},
        {"role": "assistant", "content": "The task is cancelled."},
    ]


def test_lifecycle_capture_hint_finishes_native_loop_after_one_recorded_intent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_lifecycle_tool()]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        ["TASKS"],
        invocations=[
            ("TASKS", {"action": "create", "task": "inspect login timeout"}),
            ("TASKS", {"action": "list_agents", "all": True}),
            ("TASKS", {"action": "history"}),
            (
                "TASKS",
                {"action": "spawn_agent", "task": "inspect login timeout"},
            ),
        ],
        honor_capture_terminal_hint=True,
    )
    payload = _payload(repo_path, home, bridge, tools=tools)
    payload["benchmark"] = "orchestrator_lifecycle"
    payload["system_prompt"] = LIFECYCLE_SYSTEM_HINT

    result = run_native_turn(payload, module_loader=lambda name: module)

    assert result["text"] == "done"
    assert result["actions"] == ["TASKS"]
    assert len(result["params"]["lifecycle_results"]) == 1
    meta = result["params"]["_meta"]
    assert meta["native_api_calls"] == 2
    assert meta["native_completed"] is True
    assert meta["native_interrupted"] is False
    assert meta["native_turn_exit_reason"] == "text_response(finish_reason=stop)"
    assert agent_class.instances[-1].interrupt_message is None


def test_health_probe_instantiates_and_closes_aia_agent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool(HEALTH_TOOL_NAME)]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(repo_path, home, [HEALTH_TOOL_NAME])

    result = run_health_probe(
        _payload(repo_path, home, bridge, tools=tools),
        module_loader=lambda name: module,
    )

    assert result["status"] == "ready"
    assert result["publishable_native"] is True
    assert result["tool_bridge_loaded_tools"] == [HEALTH_TOOL_NAME]
    assert agent_class.instances[-1].closed is True
    assert agent_class.instances[-1].run_args is None


def test_native_runtime_rejects_process_cwd_outside_declared_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool(HEALTH_TOOL_NAME)]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, _ = _fake_run_agent(repo_path, home, [HEALTH_TOOL_NAME])
    payload = _payload(repo_path, home, bridge, tools=tools)
    declared_workspace = tmp_path / "different-workspace"
    declared_workspace.mkdir()
    payload["workspace_path"] = str(declared_workspace)

    with pytest.raises(NativeRuntimeError, match="process cwd does not match"):
        run_health_probe(payload, module_loader=lambda name: module)


def test_native_turn_rejects_failed_aia_agent_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    bridge = prepare_scoped_benchmark_plugin(
        home,
        [],
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        [],
        result_overrides={
            "final_response": "API call failed: HTTP 404: Route not found.",
            "completed": False,
            "failed": True,
            "turn_exit_reason": None,
        },
    )

    with pytest.raises(NativeRuntimeError, match="did not complete successfully"):
        run_native_turn(
            _payload(repo_path, home, bridge, tools=[]),
            module_loader=lambda name: module,
        )

    assert agent_class.instances[-1].closed is True


def test_native_import_fails_closed_when_aia_agent_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    (repo_path / "run_agent.py").write_text("# missing class\n", encoding="utf-8")
    home = tmp_path / "home"
    tools = [_tool(HEALTH_TOOL_NAME)]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module = ModuleType("run_agent")
    module.__file__ = str(repo_path / "run_agent.py")

    with pytest.raises(NativeRuntimeError, match="AIAgent is missing"):
        run_health_probe(
            _payload(repo_path, home, bridge, tools=tools),
            module_loader=lambda name: module,
        )


def test_native_import_rejects_unpinned_module_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool(HEALTH_TOOL_NAME)]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    other_repo = tmp_path / "other"
    other_repo.mkdir()
    module, _ = _fake_run_agent(other_repo, home, [HEALTH_TOOL_NAME])

    with pytest.raises(NativeRuntimeError, match="pinned Hermes checkout"):
        run_health_probe(
            _payload(repo_path, home, bridge, tools=tools),
            module_loader=lambda name: module,
        )


def test_native_instantiation_rejects_unrelated_tools(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool(HEALTH_TOOL_NAME)]
    bridge = prepare_scoped_benchmark_plugin(
        home,
        tools,
        model="claude-sonnet-test",
        base_url="http://127.0.0.1:9411/v1",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, _ = _fake_run_agent(
        repo_path,
        home,
        [HEALTH_TOOL_NAME],
        extra_names=("terminal",),
    )

    with pytest.raises(NativeRuntimeError, match="tool surface mismatch"):
        run_health_probe(
            _payload(repo_path, home, bridge, tools=tools),
            module_loader=lambda name: module,
        )
    assert module.AIAgent.instances[-1].closed is True


def test_remote_gateway_cannot_generate_publishable_plugin(tmp_path: Path) -> None:
    with pytest.raises(NativeRuntimeError, match="loopback"):
        prepare_scoped_benchmark_plugin(
            tmp_path / "home",
            [_tool()],
            model="claude-sonnet-test",
            base_url="https://api.example.test/v1",
        )


def test_no_tool_turn_raises_iteration_ceiling_for_empty_retry_ladder(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A no-tool turn must budget enough iterations for the empty-retry ladder.

    Two iterations exhaust the budget before Hermes emits its clean terminal
    "(empty)", turning a plain empty generation into a spurious
    ``max_iterations_reached`` non-completion. Tool turns keep the tight budget.
    """
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    bridge = prepare_scoped_benchmark_plugin(
        home, [], model="claude-sonnet-test", base_url="http://127.0.0.1:9411/v1"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(repo_path, home, [])

    run_native_turn(
        _payload(repo_path, home, bridge, tools=[]),
        module_loader=lambda name: module,
    )

    assert agent_class.instances[-1].kwargs["max_iterations"] == 6


def test_no_tool_empty_generation_is_scoreable_not_raised(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty/non-terminal no-tool generation returns a scoreable empty turn.

    This is the scambench Thai-classification crash: gemma returned empty
    content, the loop exhausted its empty-retry ladder, and the turn ended
    ``completed=False`` with the ``(empty)`` sentinel. That is a wrong/abstain
    answer, not a transport failure — the runner must return it, not raise.
    """
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    bridge = prepare_scoped_benchmark_plugin(
        home, [], model="claude-sonnet-test", base_url="http://127.0.0.1:9411/v1"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, agent_class = _fake_run_agent(
        repo_path,
        home,
        [],
        result_overrides={
            "final_response": "(empty)",
            "completed": False,
            "failed": False,
            "interrupted": False,
            "turn_exit_reason": "empty_response_exhausted",
        },
    )

    result = run_native_turn(
        _payload(repo_path, home, bridge, tools=[]),
        module_loader=lambda name: module,
    )

    # "(empty)" is an internal sentinel — normalized to a true empty answer.
    assert result["text"] == ""
    assert result["actions"] == []
    meta = result["params"]["_meta"]
    assert meta["native_incomplete_turn"] is True
    assert meta["native_completed"] is False
    assert meta["native_turn_exit_reason"] == "empty_response_exhausted"
    assert meta["publishable_native"] is True
    assert agent_class.instances[-1].closed is True


def test_no_tool_max_iterations_without_final_response_is_scoreable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A no-tool turn that hits max_iterations with no answer scores empty."""
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    bridge = prepare_scoped_benchmark_plugin(
        home, [], model="claude-sonnet-test", base_url="http://127.0.0.1:9411/v1"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, _agent_class = _fake_run_agent(
        repo_path,
        home,
        [],
        result_overrides={
            "final_response": None,
            "completed": False,
            "failed": False,
            "interrupted": False,
            "turn_exit_reason": "max_iterations_reached(6/6)",
        },
    )

    result = run_native_turn(
        _payload(repo_path, home, bridge, tools=[]),
        module_loader=lambda name: module,
    )

    assert result["text"] == ""
    assert result["params"]["_meta"]["native_incomplete_turn"] is True


def test_tool_turn_non_completion_still_raises(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The benign carve-out is scoped to no-tool turns.

    A tool turn that fails to complete is a real orchestration failure and must
    still fail closed rather than be silently scored as an empty answer.
    """
    repo_path = tmp_path / "upstream"
    repo_path.mkdir()
    home = tmp_path / "home"
    tools = [_tool("lookup")]
    bridge = prepare_scoped_benchmark_plugin(
        home, tools, model="claude-sonnet-test", base_url="http://127.0.0.1:9411/v1"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, _agent_class = _fake_run_agent(
        repo_path,
        home,
        ["lookup"],
        invocations=[],
        result_overrides={
            "final_response": "(empty)",
            "completed": False,
            "failed": False,
            "interrupted": False,
            "turn_exit_reason": "max_iterations_reached(2/2)",
        },
    )

    with pytest.raises(NativeRuntimeError, match="did not complete successfully"):
        run_native_turn(
            _payload(repo_path, home, bridge, tools=tools),
            module_loader=lambda name: module,
        )
