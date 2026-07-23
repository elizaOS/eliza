"""Builds an isolated OpenClaw runtime for benchmark-owned model and tool boundaries.

Each benchmark turn runs OpenClaw's embedded agent loop against the shared
loopback completion gateway. A generated native plugin exposes only the tools
from that turn and records their execution so the Python scorer can consume
the exact name and arguments selected by OpenClaw.
"""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

PLUGIN_ID = "eliza-benchmark-tool-bridge"
PROVIDER_ID = "eliza-benchmark-gateway"
AGENT_ID = "benchmark"
_SAFE_TOOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


@dataclass(frozen=True)
class BenchmarkTool:
    original_name: str
    runtime_name: str
    description: str
    parameters: dict[str, object]
    capture_result: dict[str, object] | None = None


@dataclass(frozen=True)
class NativeRuntimePaths:
    state_dir: Path
    config_path: Path
    plugin_dir: Path
    capture_path: Path
    workspace_dir: Path
    agents_path: Path
    tool_names: tuple[str, ...]
    config_sha256: str
    system_prompt_sha256: str | None


@dataclass(frozen=True)
class NativeSessionEvidence:
    """Independent terminal-state evidence from OpenClaw's native transcript."""

    status: str
    session_sha256: str | None
    terminal_stop_reason: str | None
    assistant_model_call_count: int
    usage: dict[str, object] | None
    effective_thinking_level: str | None
    trajectory_status: str
    trajectory_sha256: str | None
    trajectory_runtime_version: str | None
    trajectory_runtime_git_sha: str | None
    trajectory_thinking_level: str | None
    trajectory_reasoning_level: str | None


def normalize_benchmark_tools(raw_tools: object) -> tuple[BenchmarkTool, ...]:
    """Validate OpenAI function tools and assign collision-free runtime names."""

    if raw_tools in (None, []):
        return ()
    if not isinstance(raw_tools, Sequence) or isinstance(raw_tools, (str, bytes)):
        raise TypeError("OpenClaw benchmark tools must be an OpenAI-format list")

    normalized: list[BenchmarkTool] = []
    used: set[str] = set()
    for index, raw in enumerate(raw_tools):
        if not isinstance(raw, Mapping) or raw.get("type") != "function":
            raise TypeError(f"OpenClaw benchmark tool {index} is not a function tool")
        function = raw.get("function")
        if not isinstance(function, Mapping):
            raise TypeError(f"OpenClaw benchmark tool {index} has no function schema")
        original_name = function.get("name")
        if not isinstance(original_name, str) or not original_name.strip():
            raise ValueError(f"OpenClaw benchmark tool {index} has no name")
        parameters = function.get("parameters")
        if parameters is None:
            parameters = {"type": "object", "properties": {}}
        elif not isinstance(parameters, Mapping):
            raise TypeError(
                f"OpenClaw benchmark tool {original_name!r} has invalid JSON Schema parameters"
            )
        description_raw = function.get("description")
        description = description_raw if isinstance(description_raw, str) else ""
        runtime_name = _runtime_tool_name(original_name, index=index, used=used)
        if runtime_name != original_name:
            description = (
                f"{description} Original benchmark function name: {original_name}."
            ).strip()
        capture_result: dict[str, object] | None = None
        benchmark_config = raw.get("x-eliza-benchmark")
        if benchmark_config is not None:
            if not isinstance(benchmark_config, Mapping):
                raise TypeError(
                    f"OpenClaw benchmark tool {original_name!r} has invalid capture metadata"
                )
            result = benchmark_config.get("result")
            if (
                benchmark_config.get("mode") != "capture_only"
                or not isinstance(result, Mapping)
                or result.get("captured") is not True
                or result.get("effect") != "not_executed"
            ):
                raise ValueError(
                    f"OpenClaw benchmark tool {original_name!r} has invalid capture-only contract"
                )
            capture_result = {
                "captured": True,
                "effect": "not_executed",
            }
        normalized.append(
            BenchmarkTool(
                original_name=original_name,
                runtime_name=runtime_name,
                description=description,
                parameters={str(key): value for key, value in parameters.items()},
                capture_result=capture_result,
            )
        )
    return tuple(normalized)


def prepare_native_runtime(
    *,
    tools: tuple[BenchmarkTool, ...],
    model: str,
    base_url: str,
    timeout_s: float,
    max_tokens: int | None,
    temperature: float | None = None,
    thinking_level: str = "medium",
    system_prompt: str | None = None,
    state_dir: Path | None = None,
    capture_stop: bool = False,
) -> NativeRuntimePaths:
    """Materialize a key-free OpenClaw config, system prompt, and tool plugin.

    ``capture_stop`` selects the env-owned tool-execution contract: the caller
    (a benchmark env speaking OpenAI chat-completions) executes captured tool
    calls itself and feeds their real results back on the next turn, so the
    embedded loop must end after the first tool batch instead of iterating on
    the bridge's placeholder acknowledgements. See ``_write_plugin``.
    """

    if not base_url.startswith("http://127.0.0.1:") and not base_url.startswith(
        "http://localhost:"
    ):
        raise ValueError(
            "Comparable OpenClaw benchmark runs require a loopback completion gateway"
        )
    root = state_dir or Path(tempfile.mkdtemp(prefix="openclaw-benchmark-"))
    root.mkdir(parents=True, exist_ok=True)
    plugin_dir = root / "benchmark-tool-bridge"
    workspace_dir = root / "workspace"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    agents_path = workspace_dir / "AGENTS.md"
    normalized_system_prompt = (
        system_prompt.strip()
        if isinstance(system_prompt, str) and system_prompt.strip()
        else None
    )
    system_prompt_sha256: str | None = None
    if normalized_system_prompt is not None:
        agents_path.write_text(normalized_system_prompt, encoding="utf-8")
        system_prompt_sha256 = hashlib.sha256(
            normalized_system_prompt.encode("utf-8")
        ).hexdigest()
    capture_path = root / "tool-calls.jsonl"
    capture_path.write_text("", encoding="utf-8")

    _write_plugin(plugin_dir, tools, capture_stop=capture_stop)
    config = _runtime_config(
        root=root,
        plugin_dir=plugin_dir,
        workspace_dir=workspace_dir,
        tools=tools,
        model=model,
        base_url=base_url,
        timeout_s=timeout_s,
        max_tokens=max_tokens,
        temperature=temperature,
        thinking_level=thinking_level,
    )
    config_text = json.dumps(config, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    config_path = root / "openclaw.json"
    config_path.write_text(config_text, encoding="utf-8")
    return NativeRuntimePaths(
        state_dir=root,
        config_path=config_path,
        plugin_dir=plugin_dir,
        capture_path=capture_path,
        workspace_dir=workspace_dir,
        agents_path=agents_path,
        tool_names=tuple(tool.runtime_name for tool in tools),
        config_sha256=hashlib.sha256(config_text.encode("utf-8")).hexdigest(),
        system_prompt_sha256=system_prompt_sha256,
    )


def read_captured_tool_executions(path: Path) -> list[dict[str, object]]:
    """Read tool executions and exact handler results from the native plugin."""

    if not path.exists():
        raise FileNotFoundError(f"OpenClaw tool capture is missing: {path}")
    calls: list[dict[str, object]] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as error:
            # error-policy:J2 identify the corrupt capture line while retaining
            # the decoder failure for harness diagnostics.
            raise RuntimeError(
                f"OpenClaw tool capture line {line_number} is invalid JSON"
            ) from error
        if not isinstance(raw, Mapping):
            raise RuntimeError(
                f"OpenClaw tool capture line {line_number} is not an object"
            )
        name = raw.get("original_name")
        arguments = raw.get("arguments")
        result = raw.get("result")
        if not isinstance(name, str) or not name:
            raise RuntimeError(
                f"OpenClaw tool capture line {line_number} has no original_name"
            )
        if not isinstance(arguments, Mapping):
            raise RuntimeError(
                f"OpenClaw tool capture line {line_number} has non-object arguments"
            )
        if (
            not isinstance(result, Mapping)
            or result.get("captured") is not True
            or result.get("tool") != name
            or not isinstance(result.get("sequence"), int)
            or isinstance(result.get("sequence"), bool)
        ):
            raise RuntimeError(
                f"OpenClaw tool capture line {line_number} has invalid handler result"
            )
        calls.append(
            {
                "id": str(raw.get("call_id") or f"call_{len(calls)}"),
                "name": name,
                "arguments": {str(key): value for key, value in arguments.items()},
                "result": {str(key): value for key, value in result.items()},
            }
        )
    return calls


def read_captured_tool_calls(path: Path) -> list[dict[str, object]]:
    """Read standard tool calls while keeping handler outcomes separate."""

    return [
        {
            "id": execution["id"],
            "name": execution["name"],
            "arguments": execution["arguments"],
        }
        for execution in read_captured_tool_executions(path)
    ]


def inspect_native_session(
    paths: NativeRuntimePaths,
    *,
    expected_thinking_level: str | None = None,
    expected_runtime_version: str | None = None,
    expected_runtime_git_sha: str | None = None,
) -> NativeSessionEvidence:
    """Verify the terminal assistant record rather than OpenClaw's summary status.

    OpenClaw can currently classify a turn as successful when an earlier
    assistant text exists even if the final provider continuation failed. The
    append-only session transcript retains that final ``stopReason=error`` and
    is therefore the authoritative publication boundary.
    """

    sessions_root = paths.state_dir / "agents"
    session_paths = sorted(
        path
        for path in sessions_root.glob("*/sessions/*.jsonl")
        if path.is_file() and not path.name.endswith(".trajectory.jsonl")
    )
    if not session_paths:
        return NativeSessionEvidence(
            status="missing",
            session_sha256=None,
            terminal_stop_reason=None,
            assistant_model_call_count=0,
            usage=None,
            effective_thinking_level=None,
            trajectory_status="missing",
            trajectory_sha256=None,
            trajectory_runtime_version=None,
            trajectory_runtime_git_sha=None,
            trajectory_thinking_level=None,
            trajectory_reasoning_level=None,
        )
    if len(session_paths) != 1:
        raise RuntimeError(
            "OpenClaw native turn produced an ambiguous session transcript set "
            f"({len(session_paths)} files)"
        )

    session_path = session_paths[0]
    session_bytes = session_path.read_bytes()
    final_assistant: Mapping[str, object] | None = None
    assistant_messages: list[Mapping[str, object]] = []
    thinking_levels: list[str] = []
    for line_number, raw_line in enumerate(session_bytes.splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            # error-policy:J2 identify the corrupt native evidence line while
            # preserving the decoder failure for harness diagnostics.
            raise RuntimeError(
                f"OpenClaw native session line {line_number} is invalid JSON"
            ) from error
        if not isinstance(record, Mapping):
            continue
        if record.get("type") == "thinking_level_change":
            thinking_level = record.get("thinkingLevel")
            if not isinstance(thinking_level, str) or not thinking_level.strip():
                raise RuntimeError(
                    "OpenClaw native session has a malformed thinking-level record"
                )
            thinking_levels.append(thinking_level.strip())
            continue
        if record.get("type") != "message":
            continue
        message = record.get("message")
        if isinstance(message, Mapping) and message.get("role") == "assistant":
            final_assistant = message
            assistant_messages.append(message)

    if final_assistant is None:
        raise RuntimeError("OpenClaw native session has no assistant record")

    stop_reason_raw = final_assistant.get("stopReason")
    stop_reason = stop_reason_raw if isinstance(stop_reason_raw, str) else None
    error_message_raw = final_assistant.get("errorMessage")
    error_message = (
        error_message_raw.strip()
        if isinstance(error_message_raw, str) and error_message_raw.strip()
        else None
    )
    if error_message_raw is not None and not isinstance(error_message_raw, str):
        raise RuntimeError(
            "OpenClaw native session has a malformed assistant errorMessage"
        )
    if stop_reason in {"error", "aborted"} or error_message is not None:
        detail = error_message or f"stopReason={stop_reason}"
        raise RuntimeError(
            f"OpenClaw native session ended with an assistant runtime error: {detail}"
        )
    if stop_reason not in {"stop", "length", "toolUse"}:
        raise RuntimeError(
            "OpenClaw native session ended with an unknown assistant stop reason: "
            f"{stop_reason!r}"
        )

    usage = _aggregate_native_session_usage(assistant_messages)
    effective_thinking_level = thinking_levels[-1] if thinking_levels else None
    trajectory = _inspect_native_trajectory(session_path)
    if usage is not None and trajectory["usage"] is not None:
        if usage != trajectory["usage"]:
            raise RuntimeError(
                "OpenClaw native session and trajectory usage aggregates differ"
            )
    if (
        effective_thinking_level is not None
        and trajectory["thinking_level"] is not None
        and effective_thinking_level != trajectory["thinking_level"]
    ):
        raise RuntimeError(
            "OpenClaw native session and trajectory thinking levels differ"
        )
    if (
        expected_thinking_level is not None
        and effective_thinking_level is not None
        and effective_thinking_level != expected_thinking_level
    ):
        raise RuntimeError(
            "OpenClaw native thinking level does not match the requested level"
        )
    if (
        trajectory["status"] == "succeeded"
        and expected_thinking_level is not None
        and trajectory["thinking_level"] != expected_thinking_level
    ):
        raise RuntimeError(
            "OpenClaw trajectory thinking level does not match the requested level"
        )
    if (
        trajectory["status"] == "succeeded"
        and expected_runtime_version is not None
        and trajectory["runtime_version"] != expected_runtime_version
    ):
        raise RuntimeError(
            "OpenClaw trajectory runtime version does not match CLI health"
        )
    if (
        trajectory["status"] == "succeeded"
        and expected_runtime_git_sha is not None
        and trajectory["runtime_git_sha"] != expected_runtime_git_sha
    ):
        raise RuntimeError(
            "OpenClaw trajectory runtime commit does not match CLI health"
        )

    return NativeSessionEvidence(
        status="succeeded",
        session_sha256=hashlib.sha256(session_bytes).hexdigest(),
        terminal_stop_reason=stop_reason,
        assistant_model_call_count=len(assistant_messages),
        usage=usage,
        effective_thinking_level=effective_thinking_level,
        trajectory_status=str(trajectory["status"]),
        trajectory_sha256=(
            str(trajectory["sha256"]) if isinstance(trajectory["sha256"], str) else None
        ),
        trajectory_runtime_version=(
            str(trajectory["runtime_version"])
            if isinstance(trajectory["runtime_version"], str)
            else None
        ),
        trajectory_runtime_git_sha=(
            str(trajectory["runtime_git_sha"])
            if isinstance(trajectory["runtime_git_sha"], str)
            else None
        ),
        trajectory_thinking_level=(
            str(trajectory["thinking_level"])
            if isinstance(trajectory["thinking_level"], str)
            else None
        ),
        trajectory_reasoning_level=(
            str(trajectory["reasoning_level"])
            if isinstance(trajectory["reasoning_level"], str)
            else None
        ),
    )


def _usage_integer(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    integer = int(value)
    return integer if integer == value and integer >= 0 else None


def _aggregate_native_session_usage(
    assistant_messages: Sequence[Mapping[str, object]],
) -> dict[str, object] | None:
    """Sum every native model continuation without inventing missing fields."""

    if not assistant_messages:
        return None
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "cache_write_tokens": 0,
    }
    for message in assistant_messages:
        usage = message.get("usage")
        if usage is None:
            return None
        if not isinstance(usage, Mapping):
            raise RuntimeError("OpenClaw native session has malformed usage")
        values = {
            "prompt_tokens": _usage_integer(
                usage.get("input", usage.get("prompt_tokens"))
            ),
            "completion_tokens": _usage_integer(
                usage.get("output", usage.get("completion_tokens"))
            ),
            "total_tokens": _usage_integer(
                usage.get("totalTokens", usage.get("total_tokens"))
            ),
            "cached_tokens": _usage_integer(
                usage.get("cacheRead", usage.get("cache_read_input_tokens", 0))
            ),
            "cache_write_tokens": _usage_integer(
                usage.get("cacheWrite", usage.get("cache_creation_input_tokens", 0))
            ),
        }
        if any(value is None for value in values.values()):
            raise RuntimeError("OpenClaw native session usage omits required counters")
        for key, value in values.items():
            assert value is not None
            totals[key] += value
    return {
        "prompt_tokens": totals["prompt_tokens"],
        "completion_tokens": totals["completion_tokens"],
        "total_tokens": totals["total_tokens"],
        "prompt_tokens_details": {
            "cached_tokens": totals["cached_tokens"],
            "cache_write_tokens": totals["cache_write_tokens"],
        },
    }


def _inspect_native_trajectory(session_path: Path) -> dict[str, object]:
    """Read OpenClaw's redacted trajectory as independent turn provenance."""

    trajectory_path = session_path.with_name(
        f"{session_path.name.removesuffix('.jsonl')}.trajectory.jsonl"
    )
    if not trajectory_path.is_file():
        return {
            "status": "missing",
            "sha256": None,
            "runtime_version": None,
            "runtime_git_sha": None,
            "thinking_level": None,
            "reasoning_level": None,
            "usage": None,
        }
    trajectory_bytes = trajectory_path.read_bytes()
    metadata: Mapping[str, object] | None = None
    completed: Mapping[str, object] | None = None
    ended: Mapping[str, object] | None = None
    for line_number, raw_line in enumerate(trajectory_bytes.splitlines(), 1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            # error-policy:J2 identify the corrupt trajectory line while
            # retaining the decoder failure for harness diagnostics.
            raise RuntimeError(
                f"OpenClaw native trajectory line {line_number} is invalid JSON"
            ) from error
        if not isinstance(record, Mapping):
            raise RuntimeError(
                f"OpenClaw native trajectory line {line_number} is not an object"
            )
        record_type = record.get("type")
        data = record.get("data")
        if record_type in {"trace.metadata", "model.completed", "session.ended"}:
            if not isinstance(data, Mapping):
                raise RuntimeError(
                    f"OpenClaw native trajectory {record_type} has no data object"
                )
            if record_type == "trace.metadata":
                if metadata is not None:
                    raise RuntimeError(
                        "OpenClaw native trajectory has duplicate metadata"
                    )
                metadata = data
            elif record_type == "model.completed":
                if completed is not None:
                    raise RuntimeError(
                        "OpenClaw native trajectory has duplicate completion evidence"
                    )
                completed = data
            else:
                if ended is not None:
                    raise RuntimeError(
                        "OpenClaw native trajectory has duplicate terminal evidence"
                    )
                ended = data
    if metadata is None or completed is None or ended is None:
        raise RuntimeError(
            "OpenClaw native trajectory omits metadata, completion, or terminal evidence"
        )
    if (
        ended.get("status") != "success"
        or ended.get("aborted") is not False
        or ended.get("timedOut") is not False
    ):
        raise RuntimeError("OpenClaw native trajectory did not end successfully")
    harness = metadata.get("harness")
    model = metadata.get("model")
    if not isinstance(harness, Mapping) or harness.get("type") != "openclaw":
        raise RuntimeError("OpenClaw native trajectory has invalid runtime identity")
    if not isinstance(model, Mapping):
        raise RuntimeError("OpenClaw native trajectory has invalid model identity")
    raw_usage = completed.get("usage")
    if not isinstance(raw_usage, Mapping):
        raise RuntimeError("OpenClaw native trajectory omits aggregate usage")
    input_tokens = _usage_integer(raw_usage.get("input"))
    output_tokens = _usage_integer(raw_usage.get("output"))
    total_tokens = _usage_integer(raw_usage.get("total"))
    if input_tokens is None or output_tokens is None or total_tokens is None:
        raise RuntimeError("OpenClaw native trajectory usage is malformed")
    usage = {
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": total_tokens,
        "prompt_tokens_details": {
            "cached_tokens": _usage_integer(raw_usage.get("cacheRead", 0)),
            "cache_write_tokens": _usage_integer(raw_usage.get("cacheWrite", 0)),
        },
    }
    if None in usage["prompt_tokens_details"].values():
        raise RuntimeError("OpenClaw native trajectory cache usage is malformed")
    runtime_version = harness.get("version")
    runtime_git_sha = harness.get("gitSha")
    thinking_level = model.get("thinkLevel")
    reasoning_level = model.get("reasoningLevel")
    for name, value in (
        ("runtime version", runtime_version),
        ("runtime commit", runtime_git_sha),
        ("thinking level", thinking_level),
        ("reasoning level", reasoning_level),
    ):
        if not isinstance(value, str) or not value.strip():
            raise RuntimeError(f"OpenClaw native trajectory omits {name}")
    return {
        "status": "succeeded",
        "sha256": hashlib.sha256(trajectory_bytes).hexdigest(),
        "runtime_version": runtime_version,
        "runtime_git_sha": runtime_git_sha,
        "thinking_level": thinking_level,
        "reasoning_level": reasoning_level,
        "usage": usage,
    }


def benchmark_runtime_env(
    *, paths: NativeRuntimePaths, gateway_token: str, parent: Mapping[str, str]
) -> dict[str, str]:
    """Build the isolated child environment without persisting gateway auth."""

    if not gateway_token:
        raise ValueError("CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN is required")
    env = dict(parent)
    env["OPENCLAW_STATE_DIR"] = str(paths.state_dir)
    env["OPENCLAW_CONFIG_PATH"] = str(paths.config_path)
    env["OPENCLAW_BENCHMARK_CAPTURE_PATH"] = str(paths.capture_path)
    env["CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN"] = gateway_token
    env["BENCHMARK_HARNESS"] = "openclaw"
    return env


def _runtime_tool_name(original: str, *, index: int, used: set[str]) -> str:
    if _SAFE_TOOL_RE.fullmatch(original) and original not in used:
        used.add(original)
        return original
    stem = re.sub(r"[^A-Za-z0-9_-]", "_", original).strip("_") or "tool"
    if not stem[0].isalpha():
        stem = f"tool_{stem}"
    digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:8]
    stem = stem[: max(1, 54 - len(str(index)))]
    candidate = f"{stem}_{index}_{digest}"[:64]
    suffix = 2
    while candidate in used:
        marker = f"_{suffix}"
        candidate = f"{candidate[: 64 - len(marker)]}{marker}"
        suffix += 1
    used.add(candidate)
    return candidate


def _runtime_config(
    *,
    root: Path,
    plugin_dir: Path,
    workspace_dir: Path,
    tools: tuple[BenchmarkTool, ...],
    model: str,
    base_url: str,
    timeout_s: float,
    max_tokens: int | None,
    temperature: float | None,
    thinking_level: str,
) -> dict[str, object]:
    model_ref = f"{PROVIDER_ID}/{model}"
    model_max_tokens = (
        max_tokens if isinstance(max_tokens, int) and max_tokens > 0 else 8192
    )
    request_params: dict[str, object] = {"maxTokens": model_max_tokens}
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        request_params["temperature"] = float(temperature)
    tool_names = [tool.runtime_name for tool in tools]
    tool_policy: dict[str, object]
    plugin_config: dict[str, object]
    if tool_names:
        tool_policy = {"allow": tool_names}
        plugin_config = {
            "enabled": True,
            "allow": [PLUGIN_ID],
            "deny": [],
            "load": {"paths": [str(plugin_dir)]},
            "entries": {PLUGIN_ID: {"enabled": True}},
        }
    else:
        tool_policy = {"deny": ["*"]}
        plugin_config = {"enabled": False, "allow": [], "deny": []}
    return {
        "agents": {
            "defaults": {
                "model": {"primary": model_ref, "fallbacks": []},
                "models": {model_ref: {"agentRuntime": {"id": "openclaw"}}},
                "workspace": str(workspace_dir),
                "skipBootstrap": True,
                "contextInjection": "always",
                "timeoutSeconds": max(1, int(timeout_s)),
                "thinkingDefault": thinking_level,
            },
            "list": [
                {
                    "id": AGENT_ID,
                    "default": True,
                    "name": "Benchmark Agent",
                    "workspace": str(workspace_dir),
                    "agentDir": str(root / "agents" / AGENT_ID / "agent"),
                    "model": {"primary": model_ref, "fallbacks": []},
                    "models": {model_ref: {"agentRuntime": {"id": "openclaw"}}},
                    "params": request_params,
                    "skills": [],
                    "tools": tool_policy,
                    "sandbox": {"mode": "off"},
                    "contextInjection": "always",
                }
            ],
        },
        "models": {
            "mode": "replace",
            "providers": {
                PROVIDER_ID: {
                    "baseUrl": (
                        base_url.rstrip("/")
                        if base_url.rstrip("/").endswith("/v1")
                        else base_url.rstrip("/") + "/v1"
                    ),
                    "apiKey": "${CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN}",
                    "api": "openai-completions",
                    "timeoutSeconds": max(1, int(timeout_s)),
                    "agentRuntime": {"id": "openclaw"},
                    "models": [
                        {
                            "id": model,
                            "name": model,
                            "reasoning": True,
                            "compat": {"supportsReasoningEffort": True},
                            "input": ["text"],
                            "cost": {
                                "input": 0,
                                "output": 0,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                            },
                            "contextWindow": 200000,
                            "maxTokens": model_max_tokens,
                        }
                    ],
                }
            },
        },
        "tools": tool_policy,
        "plugins": plugin_config,
        "logging": {"level": "warn", "consoleLevel": "error"},
    }


def _write_plugin(
    plugin_dir: Path,
    tools: tuple[BenchmarkTool, ...],
    *,
    capture_stop: bool = False,
) -> None:
    manifest = {
        "id": PLUGIN_ID,
        "name": "elizaOS Benchmark Tool Bridge",
        "description": "Scoped benchmark-owned tools for one isolated OpenClaw turn.",
        "version": "0.1.0",
        "activation": {"onStartup": True},
        "contracts": {"tools": [tool.runtime_name for tool in tools]},
        "configSchema": {"type": "object", "additionalProperties": False},
    }
    package = {
        "name": "@elizaos/openclaw-benchmark-tool-bridge",
        "version": "0.1.0",
        "type": "module",
        "private": True,
        "openclaw": {"extensions": ["./index.mjs"]},
    }
    descriptors = [
        {
            "originalName": tool.original_name,
            "runtimeName": tool.runtime_name,
            "description": tool.description,
            "parameters": tool.parameters,
            "captureResult": tool.capture_result,
        }
        for tool in tools
    ]
    plugin_source = f"""/**
 * Registers the exact tool catalog supplied by one benchmark turn.
 *
 * Handlers record the selected call for the Python scorer. This bridge never
 * executes anything: the benchmark env replays captured calls against the
 * real environment and feeds genuine results back on the next turn. In
 * capture-stop mode every result therefore sets `terminate` so the embedded
 * loop ends after the first tool batch — iterating on the bridge's
 * placeholder acknowledgements would bill one provider completion per fake
 * round while telling the model nothing. The `async`/`status: "started"`
 * details mark the batch as deferred external work so OpenClaw's terminal
 * classifier treats the captured handoff as delivery rather than an empty
 * (non-deliverable) turn. The capture file keeps the bare scorer contract
 * either way.
 */
import {{ appendFileSync }} from "node:fs";

const tools = {json.dumps(descriptors, ensure_ascii=True)};
const captureStop = {json.dumps(bool(capture_stop))};
const callSequences = new Map();

export default {{
  id: {json.dumps(PLUGIN_ID)},
  name: "elizaOS Benchmark Tool Bridge",
  description: "Scoped benchmark-owned tools for one isolated OpenClaw turn.",
  register(api) {{
    for (const descriptor of tools) {{
      api.registerTool({{
        name: descriptor.runtimeName,
        description: descriptor.description,
        parameters: descriptor.parameters,
        async execute(callId, params) {{
          const capturePath = process.env.OPENCLAW_BENCHMARK_CAPTURE_PATH;
          if (!capturePath) {{
            throw new Error("OPENCLAW_BENCHMARK_CAPTURE_PATH is required");
          }}
          const sequence = Number(
            callSequences.get(descriptor.runtimeName) ?? 0,
          );
          callSequences.set(descriptor.runtimeName, sequence + 1);
          const outcome = descriptor.captureResult
            ? {{
                ...descriptor.captureResult,
                sequence,
                tool: descriptor.originalName,
              }}
            : {{ captured: true, tool: descriptor.originalName, sequence }};
          appendFileSync(
            capturePath,
            `${{JSON.stringify({{
              call_id: callId,
              original_name: descriptor.originalName,
              runtime_name: descriptor.runtimeName,
              arguments: params,
              result: outcome,
            }})}}\\n`,
            {{ encoding: "utf8" }},
          );
          return {{
            content: [{{
              type: "text",
              text: JSON.stringify(outcome),
            }}],
            details: captureStop
              ? {{ ...outcome, async: true, status: "started" }}
              : outcome,
            ...(captureStop ? {{ terminate: true }} : {{}}),
          }};
        }},
      }});
    }}
  }},
}};
"""
    (plugin_dir / "openclaw.plugin.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (plugin_dir / "package.json").write_text(
        json.dumps(package, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (plugin_dir / "index.mjs").write_text(plugin_source, encoding="utf-8")


__all__ = [
    "AGENT_ID",
    "BenchmarkTool",
    "NativeRuntimePaths",
    "PROVIDER_ID",
    "benchmark_runtime_env",
    "normalize_benchmark_tools",
    "prepare_native_runtime",
    "read_captured_tool_calls",
    "read_captured_tool_executions",
]
