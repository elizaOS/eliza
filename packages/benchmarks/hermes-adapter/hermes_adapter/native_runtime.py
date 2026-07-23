"""Isolated native Hermes runtime bridge for one benchmark turn.

The parent adapter generates a temporary user plugin containing only the
benchmark-provided tools, then executes this module with the pinned Hermes
interpreter.  Importing ``run_agent`` happens only after ``HERMES_HOME`` and
the plugin config exist because Hermes discovers plugins during import.
"""

from __future__ import annotations

import hashlib
import importlib
import inspect
import ipaddress
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlparse


PLUGIN_ID = "eliza-benchmark-tools"
PLUGIN_TOOLSET = "eliza_benchmark_scoped"
PLUGIN_API = "hermes_cli.plugins.PluginContext.register_tool"
HEALTH_TOOL_NAME = "eliza_benchmark_health_probe"
NATIVE_RUNTIME_CLASS = "run_agent.AIAgent"
NATIVE_RUNTIME_API = "run_conversation"
NATIVE_TRANSPORT = "subprocess_loopback_openai_compatible"
PROTOCOL_VERSION = 1
_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_ALLOWED_TOOL_CHOICES = {"auto", "required", "none"}

# A no-tool text turn has no tool round to spend iterations on; its only
# reason to loop is Hermes's own empty-response retry ladder (up to three
# retries before it emits a clean terminal "(empty)" and marks the turn
# complete). Two iterations exhaust the budget before the ladder reaches that
# terminal, so a model that simply returns empty content (e.g. on a long
# multilingual classification prompt) exits via ``max_iterations_reached`` with
# ``completed=False`` — a spurious non-completion. Give the ladder room to
# terminate so an empty generation becomes a scoreable empty answer rather than
# a harness failure. Tool turns keep the tight budget so runaway tool loops
# still fail fast.
_NO_TOOL_MAX_ITERATIONS = 6


class NativeRuntimeError(RuntimeError):
    """The benchmark request cannot be proven to use native Hermes safely."""


@dataclass(frozen=True)
class BridgeSpec:
    """Materialized plugin identity shared by the parent and native child."""

    hermes_home: Path
    plugin_dir: Path
    capture_path: Path
    digest: str
    tool_names: tuple[str, ...]

    def as_payload(self) -> dict[str, object]:
        return {
            "plugin_id": PLUGIN_ID,
            "toolset": PLUGIN_TOOLSET,
            "capture_path": str(self.capture_path),
            "digest": self.digest,
            "tool_names": list(self.tool_names),
        }


_PLUGIN_SOURCE = '''"""Generated benchmark-only Hermes tool bridge.

The isolated benchmark profile enables this plugin as its sole toolset. Each
handler records the exact arguments Hermes executed and returns a deterministic
acknowledgement so the native agent loop can continue.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path


_ROOT = Path(__file__).resolve().parent
_BRIDGE = json.loads((_ROOT / "bridge.json").read_text(encoding="utf-8"))
_CAPTURE_PATH = Path(_BRIDGE["capture_path"])
_LOCK = threading.Lock()
_SEQUENCE = 0


def _handler_for(tool_name, benchmark_config):
    def _handler(args, **kwargs):
        global _SEQUENCE
        arguments = dict(args) if isinstance(args, dict) else {}
        with _LOCK:
            sequence = _SEQUENCE
            _SEQUENCE += 1
            if benchmark_config.get("mode") == "capture_only":
                outcome = {
                    **benchmark_config["result"],
                    "sequence": sequence,
                    "tool": tool_name,
                }
            else:
                outcome = {"captured": True, "tool": tool_name, "sequence": sequence}
            record = {
                "sequence": sequence,
                "name": tool_name,
                "arguments": arguments,
                "result": outcome,
                "task_id": str(kwargs.get("task_id") or ""),
                "session_id": str(kwargs.get("session_id") or ""),
            }
            with _CAPTURE_PATH.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True) + "\\n")
        return json.dumps(outcome, ensure_ascii=True, sort_keys=True, separators=(",", ":"))

    return _handler


def register(ctx):
    for tool in _BRIDGE["tools"]:
        function = tool["function"]
        ctx.register_tool(
            name=function["name"],
            toolset=_BRIDGE["toolset"],
            schema={
                "description": function.get("description", "Benchmark-scoped tool"),
                "parameters": function["parameters"],
            },
            handler=_handler_for(
                function["name"], tool.get("x-eliza-benchmark", {})
            ),
            description=function.get("description", "Benchmark-scoped tool"),
            override=True,
        )
'''


def is_loopback_base_url(value: object) -> bool:
    """Return whether an HTTP(S) URL resolves syntactically to loopback."""

    if not isinstance(value, str) or not value.strip():
        return False
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _normalized_tools(raw_tools: object) -> list[dict[str, object]]:
    if raw_tools is None:
        return []
    if not isinstance(raw_tools, Sequence) or isinstance(
        raw_tools, (str, bytes, bytearray)
    ):
        raise NativeRuntimeError("benchmark tools must be an OpenAI-format list")

    normalized: list[dict[str, object]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_tools):
        if not isinstance(item, Mapping) or item.get("type") != "function":
            raise NativeRuntimeError(
                f"benchmark tool {index} is not an OpenAI function tool"
            )
        function = item.get("function")
        if not isinstance(function, Mapping):
            raise NativeRuntimeError(f"benchmark tool {index} has no function schema")
        name = function.get("name")
        if not isinstance(name, str) or not _TOOL_NAME_RE.fullmatch(name):
            raise NativeRuntimeError(f"benchmark tool {index} has an invalid name")
        if name in seen:
            raise NativeRuntimeError(f"duplicate benchmark tool name: {name}")
        seen.add(name)
        parameters = function.get("parameters")
        if parameters is None:
            parameters = {
                "type": "object",
                "properties": {},
                "additionalProperties": True,
            }
        if not isinstance(parameters, Mapping):
            raise NativeRuntimeError(
                f"benchmark tool {name!r} parameters must be an object schema"
            )
        description = function.get("description")
        normalized_tool: dict[str, object] = {
            "type": "function",
            "function": {
                "name": name,
                "description": description if isinstance(description, str) else "",
                "parameters": dict(parameters),
            },
        }
        benchmark_config = item.get("x-eliza-benchmark")
        if benchmark_config is not None:
            if not isinstance(benchmark_config, Mapping):
                raise NativeRuntimeError(
                    f"benchmark tool {name!r} has invalid capture metadata"
                )
            result = benchmark_config.get("result")
            if (
                benchmark_config.get("mode") != "capture_only"
                or not isinstance(result, Mapping)
                or result.get("captured") is not True
                or result.get("effect") != "not_executed"
            ):
                raise NativeRuntimeError(
                    f"benchmark tool {name!r} has invalid capture-only contract"
                )
            normalized_tool["x-eliza-benchmark"] = {
                "mode": "capture_only",
                "result": {
                    "captured": True,
                    "effect": "not_executed",
                },
            }
        normalized.append(normalized_tool)
    return normalized


def prepare_scoped_benchmark_plugin(
    hermes_home: Path,
    raw_tools: object,
    *,
    model: str,
    base_url: str,
) -> BridgeSpec:
    """Generate the sole enabled Hermes plugin inside an isolated profile."""

    if not is_loopback_base_url(base_url):
        raise NativeRuntimeError(
            "native Hermes benchmarks require a loopback OpenAI-compatible gateway"
        )
    tools = _normalized_tools(raw_tools)
    home = Path(hermes_home).resolve()
    plugin_dir = home / "plugins" / PLUGIN_ID
    plugin_dir.mkdir(parents=True, exist_ok=True)
    capture_path = home / "benchmark-tool-calls.jsonl"
    capture_path.write_text("", encoding="utf-8")

    bridge_without_digest: dict[str, object] = {
        "protocol_version": PROTOCOL_VERSION,
        "plugin_id": PLUGIN_ID,
        "toolset": PLUGIN_TOOLSET,
        "capture_path": str(capture_path),
        "tools": tools,
    }
    canonical = json.dumps(
        bridge_without_digest, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    bridge = {**bridge_without_digest, "digest": digest}

    (plugin_dir / "bridge.json").write_text(
        json.dumps(bridge, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (plugin_dir / "__init__.py").write_text(_PLUGIN_SOURCE, encoding="utf-8")
    manifest = {
        "name": PLUGIN_ID,
        "version": "1.0.0",
        "description": "Generated benchmark-scoped tool capture bridge.",
        "kind": "standalone",
        "provides_tools": [tool["function"]["name"] for tool in tools],
    }
    (plugin_dir / "plugin.yaml").write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    # JSON is valid YAML. Replacing the whole isolated config prevents ambient
    # user plugins, MCP servers, memory, or tool-search bridges entering the
    # benchmark surface while retaining an explicit override gate for names
    # that intentionally collide with built-in Hermes tools.
    config = {
        "plugins": {
            "enabled": [PLUGIN_ID],
            "entries": {PLUGIN_ID: {"allow_tool_override": True}},
        },
        "tools": {"tool_search": {"enabled": "off"}},
        "model": {
            "provider": "custom",
            "model": model,
            "base_url": base_url,
            "context_length": 200000,
            "ollama_num_ctx": 0,
        },
        "agent": {
            "environment_probe": False,
            "parallel_tool_call_guidance": False,
        },
    }
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        json.dumps(config, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return BridgeSpec(
        hermes_home=home,
        plugin_dir=plugin_dir,
        capture_path=capture_path,
        digest=digest,
        tool_names=tuple(tool["function"]["name"] for tool in tools),
    )


def _bridge_from_payload(payload: Mapping[str, object]) -> BridgeSpec:
    raw_home = payload.get("hermes_home")
    raw_bridge = payload.get("bridge")
    if not isinstance(raw_home, str) or not isinstance(raw_bridge, Mapping):
        raise NativeRuntimeError("native payload is missing isolated bridge metadata")
    home = Path(raw_home).resolve()
    configured_home = os.environ.get("HERMES_HOME", "").strip()
    if not configured_home or Path(configured_home).resolve() != home:
        raise NativeRuntimeError(
            "HERMES_HOME was not set to the isolated benchmark profile"
        )
    plugin_dir = home / "plugins" / PLUGIN_ID
    bridge_path = plugin_dir / "bridge.json"
    try:
        disk_bridge = json.loads(bridge_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise NativeRuntimeError(
            f"generated benchmark plugin is unreadable: {exc}"
        ) from exc
    if not isinstance(disk_bridge, Mapping):
        raise NativeRuntimeError("generated benchmark plugin metadata is invalid")
    disk_digest = disk_bridge.get("digest")
    expected_digest = raw_bridge.get("digest")
    if not isinstance(disk_digest, str) or disk_digest != expected_digest:
        raise NativeRuntimeError("generated benchmark plugin digest mismatch")
    canonical_payload = {
        key: value for key, value in disk_bridge.items() if key != "digest"
    }
    canonical = json.dumps(
        canonical_payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != disk_digest:
        raise NativeRuntimeError(
            "generated benchmark plugin content failed verification"
        )
    tools = _normalized_tools(disk_bridge.get("tools"))
    tool_names = tuple(tool["function"]["name"] for tool in tools)
    payload_names = raw_bridge.get("tool_names")
    if not isinstance(payload_names, list) or tool_names != tuple(payload_names):
        raise NativeRuntimeError("generated benchmark plugin tool inventory mismatch")
    capture_path = Path(str(disk_bridge.get("capture_path") or "")).resolve()
    if capture_path.parent != home:
        raise NativeRuntimeError("benchmark tool capture escaped the isolated profile")
    return BridgeSpec(home, plugin_dir, capture_path, disk_digest, tool_names)


def _verified_workspace_path(payload: Mapping[str, object]) -> Path:
    """Prove Hermes is running in the benchmark target, not its source checkout."""

    raw_workspace = payload.get("workspace_path")
    if not isinstance(raw_workspace, str) or not raw_workspace.strip():
        raise NativeRuntimeError("native payload is missing the benchmark workspace")
    workspace = Path(raw_workspace).resolve()
    if not workspace.is_dir():
        raise NativeRuntimeError(f"benchmark workspace is not a directory: {workspace}")
    process_cwd = Path.cwd().resolve()
    if process_cwd != workspace:
        raise NativeRuntimeError(
            "native Hermes process cwd does not match the benchmark workspace: "
            f"expected={workspace} actual={process_cwd}"
        )
    return workspace


def _load_agent_class(
    payload: Mapping[str, object],
    module_loader: Callable[[str], ModuleType],
) -> tuple[type[Any], str]:
    raw_repo_path = payload.get("repo_path")
    if not isinstance(raw_repo_path, str) or not raw_repo_path:
        raise NativeRuntimeError(
            "native payload is missing the pinned Hermes repo path"
        )
    repo_path = Path(raw_repo_path).resolve()
    if str(repo_path) not in sys.path:
        sys.path.insert(0, str(repo_path))
    try:
        module = module_loader("run_agent")
    except Exception as exc:
        raise NativeRuntimeError(
            f"cannot import pinned Hermes run_agent: {exc}"
        ) from exc
    agent_class = getattr(module, "AIAgent", None)
    if not inspect.isclass(agent_class):
        raise NativeRuntimeError("pinned Hermes run_agent.AIAgent is missing")
    if agent_class.__name__ != "AIAgent" or agent_class.__module__ != "run_agent":
        raise NativeRuntimeError(
            "imported AIAgent does not have native run_agent identity"
        )
    if getattr(module, "AIAgent", None) is not agent_class:
        raise NativeRuntimeError("run_agent.AIAgent class identity is inconsistent")
    module_file_raw = getattr(module, "__file__", None)
    if not isinstance(module_file_raw, str):
        raise NativeRuntimeError("run_agent module has no source-file provenance")
    module_file = Path(module_file_raw).resolve()
    if not module_file.is_file() or not module_file.is_relative_to(repo_path):
        raise NativeRuntimeError(
            "run_agent was not imported from the pinned Hermes checkout"
        )
    return agent_class, str(module_file)


def _agent_kwargs(
    payload: Mapping[str, object],
    spec: BridgeSpec,
    *,
    tool_complete_callback: Callable[..., None],
) -> dict[str, object]:
    base_url = payload.get("base_url")
    model = payload.get("model")
    if not is_loopback_base_url(base_url):
        raise NativeRuntimeError(
            "native Hermes benchmarks require a loopback OpenAI-compatible gateway"
        )
    if not isinstance(model, str) or not model.strip():
        raise NativeRuntimeError("native Hermes benchmark model is missing")
    request_overrides: dict[str, object] = {}
    temperature = payload.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        request_overrides["temperature"] = float(temperature)
    reasoning_effort = payload.get("reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort.strip():
        request_overrides["reasoning_effort"] = reasoning_effort.strip()
    tool_choice = payload.get("tool_choice")
    if (
        spec.tool_names
        and isinstance(tool_choice, str)
        and tool_choice in _ALLOWED_TOOL_CHOICES
    ):
        request_overrides["tool_choice"] = tool_choice

    max_tokens = payload.get("max_tokens")
    if (
        not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or max_tokens <= 0
    ):
        max_tokens = None
    task_seed = str(payload.get("task_id") or payload.get("benchmark") or "turn")
    session_suffix = hashlib.sha256(task_seed.encode("utf-8")).hexdigest()[:16]
    return {
        "base_url": str(base_url),
        "api_key": str(payload.get("api_key") or "benchmark-loopback"),
        "provider": "custom",
        "api_mode": "chat_completions",
        "model": model,
        # Lifecycle turns may need one task mutation followed by a status read
        # before the final response; two iterations only permit one sequential
        # tool round plus the terminal model response. No-tool turns instead
        # need room for the empty-response retry ladder (see
        # ``_NO_TOOL_MAX_ITERATIONS``).
        "max_iterations": (
            4
            if payload.get("benchmark") == "orchestrator_lifecycle"
            else _NO_TOOL_MAX_ITERATIONS
            if not spec.tool_names
            else 2
        ),
        "tool_delay": 0,
        "enabled_toolsets": [PLUGIN_TOOLSET] if spec.tool_names else [],
        "disabled_toolsets": [],
        "save_trajectories": False,
        "verbose_logging": False,
        "quiet_mode": True,
        "tool_progress_mode": "off",
        "session_id": f"eliza-benchmark-{session_suffix}",
        "tool_complete_callback": tool_complete_callback,
        "max_tokens": max_tokens,
        "request_overrides": request_overrides,
        "platform": "benchmark",
        "skip_context_files": True,
        "load_soul_identity": False,
        "skip_memory": True,
        "checkpoints_enabled": False,
    }


def _capture_stop_enabled(payload: Mapping[str, object]) -> bool:
    """The turn must end at the first captured tool batch.

    True for action-calling (single scored action by definition) and whenever
    the caller declares the env-owned tool contract (``capture_stop``): the
    benchmark env executes captured calls itself and replays real results on
    the next turn, so letting the native loop iterate on the bridge's
    placeholder acknowledgements burns iterations until
    ``max_iterations_reached`` and fails an otherwise-healthy turn.
    """
    return (
        payload.get("benchmark") == "action-calling"
        or payload.get("capture_stop") is True
    )


def _instantiate_agent(
    agent_class: type[Any],
    payload: Mapping[str, object],
    spec: BridgeSpec,
) -> Any:
    holder: dict[str, Any] = {}
    capture_stop_enabled = _capture_stop_enabled(payload)

    def _tool_complete(*_args: object, **_kwargs: object) -> None:
        # ``required`` means at least one action for the outer benchmark turn.
        # Leaving it on every internal Hermes iteration forces an endless tool
        # loop, so the native callback relaxes only the follow-up request.
        agent = holder.get("agent")
        overrides = getattr(agent, "request_overrides", None)
        if isinstance(overrides, dict) and overrides.get("tool_choice") == "required":
            overrides["tool_choice"] = "auto"
        if capture_stop_enabled:
            interrupt = getattr(agent, "interrupt", None)
            if callable(interrupt):
                interrupt("benchmark_scored_action_captured")

    try:
        agent = agent_class(
            **_agent_kwargs(
                payload,
                spec,
                tool_complete_callback=_tool_complete,
            )
        )
    except Exception as exc:
        raise NativeRuntimeError(
            f"run_agent.AIAgent instantiation failed: {exc}"
        ) from exc
    holder["agent"] = agent
    if capture_stop_enabled and not callable(getattr(agent, "interrupt", None)):
        _close_agent(agent)
        raise NativeRuntimeError(
            "run_agent.AIAgent has no interrupt() capture-stop API"
        )
    actual_names = set(getattr(agent, "valid_tool_names", set()) or set())
    expected_names = set(spec.tool_names)
    if actual_names != expected_names:
        _close_agent(agent)
        raise NativeRuntimeError(
            "native Hermes tool surface mismatch: "
            f"expected={sorted(expected_names)!r} actual={sorted(actual_names)!r}"
        )
    return agent


def _close_agent(agent: Any) -> None:
    close = getattr(agent, "close", None)
    if not callable(close):
        raise NativeRuntimeError("run_agent.AIAgent has no close() lifecycle API")
    try:
        close()
    except Exception as exc:
        raise NativeRuntimeError(f"run_agent.AIAgent close failed: {exc}") from exc


def _provenance(
    spec: BridgeSpec,
    *,
    module_file: str,
    captured_calls: int,
    workspace_path: Path,
    capture_stop_enabled: bool = False,
) -> dict[str, object]:
    return {
        "agent_runtime": "hermes",
        "native_runtime_class": NATIVE_RUNTIME_CLASS,
        "native_runtime_api": NATIVE_RUNTIME_API,
        "native_runtime_module_file": module_file,
        "native_agent_instantiated": True,
        "tool_bridge_plugin": PLUGIN_ID,
        "tool_bridge_api": PLUGIN_API,
        "tool_bridge_toolset": PLUGIN_TOOLSET,
        "tool_bridge_digest": spec.digest,
        "tool_bridge_loaded_tools": list(spec.tool_names),
        "tool_bridge_captured_calls": captured_calls,
        "capture_stop_after_scored_action": capture_stop_enabled,
        "benchmark_workspace_path": str(workspace_path),
        "native_process_cwd": str(Path.cwd().resolve()),
        "transport": NATIVE_TRANSPORT,
        "hermes_home_isolated": True,
        "legacy_raw_openai_bypass": False,
        "publishable_native": True,
    }


def run_health_probe(
    payload: Mapping[str, object],
    *,
    module_loader: Callable[[str], ModuleType] = importlib.import_module,
) -> dict[str, object]:
    """Instantiate and close native Hermes while proving its exact tool surface."""

    workspace_path = _verified_workspace_path(payload)
    spec = _bridge_from_payload(payload)
    agent_class, module_file = _load_agent_class(payload, module_loader)
    agent = _instantiate_agent(agent_class, payload, spec)
    _close_agent(agent)
    return {
        "status": "ready",
        **_provenance(
            spec,
            module_file=module_file,
            captured_calls=0,
            workspace_path=workspace_path,
        ),
    }


def _conversation_inputs(
    payload: Mapping[str, object],
) -> tuple[object, str | None, list[dict[str, object]]]:
    text: object = payload.get("text") or ""
    system_message = payload.get("system_prompt")
    if not isinstance(system_message, str) or not system_message.strip():
        system_message = None
    context = payload.get("context")
    raw_messages = (
        context.get("benchmark_messages") if isinstance(context, Mapping) else None
    )
    if not isinstance(raw_messages, Sequence) or isinstance(
        raw_messages, (str, bytes, bytearray)
    ):
        raw_messages = context.get("messages") if isinstance(context, Mapping) else None
    history: list[dict[str, object]] = []
    system_parts: list[str] = []
    if isinstance(raw_messages, Sequence) and not isinstance(
        raw_messages, (str, bytes, bytearray)
    ):
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            role = item.get("role")
            if role not in {"system", "user", "assistant", "tool"}:
                continue
            content = item.get("content")
            if role == "system":
                if isinstance(content, str) and content.strip():
                    system_parts.append(content.strip())
                continue
            history.append(dict(item))
    if history and history[-1].get("role") == "user":
        text = history[-1].get("content")
        history.pop()
    for part in system_parts:
        if not system_message:
            system_message = part
        elif part not in system_message:
            system_message = f"{part}\n\n{system_message}"
    return text, system_message, history


def _read_capture(spec: BridgeSpec) -> list[dict[str, object]]:
    try:
        lines = spec.capture_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise NativeRuntimeError(
            f"benchmark tool capture is unreadable: {exc}"
        ) from exc
    records: list[dict[str, object]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise NativeRuntimeError(
                f"benchmark tool capture is invalid JSON: {exc}"
            ) from exc
        if not isinstance(record, Mapping):
            raise NativeRuntimeError("benchmark tool capture record is not an object")
        name = record.get("name")
        arguments = record.get("arguments")
        result = record.get("result")
        sequence = record.get("sequence")
        if (
            name not in spec.tool_names
            or not isinstance(arguments, Mapping)
            or not isinstance(result, Mapping)
            or not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or result.get("captured") is not True
            or result.get("tool") != name
            or result.get("sequence") != sequence
        ):
            raise NativeRuntimeError(
                "benchmark tool capture contains an out-of-scope call"
            )
        records.append(dict(record))
    records.sort(key=lambda record: int(record.get("sequence", 0)))
    return records


def _canonical_arguments(value: object) -> str:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return value
        value = parsed
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _captured_tool_calls(
    result: Mapping[str, object],
    captures: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    needed = Counter(
        (str(record["name"]), _canonical_arguments(record["arguments"]))
        for record in captures
    )
    candidates: list[dict[str, object]] = []
    messages = result.get("messages")
    if isinstance(messages, Sequence) and not isinstance(messages, (str, bytes)):
        for message in messages:
            if not isinstance(message, Mapping) or message.get("role") != "assistant":
                continue
            raw_calls = message.get("tool_calls")
            if not isinstance(raw_calls, Sequence) or isinstance(
                raw_calls, (str, bytes)
            ):
                continue
            for raw_call in raw_calls:
                if not isinstance(raw_call, Mapping):
                    continue
                function = raw_call.get("function")
                if not isinstance(function, Mapping):
                    continue
                name = function.get("name")
                arguments = function.get("arguments", "{}")
                if not isinstance(name, str):
                    continue
                candidates.append(
                    {
                        "id": str(raw_call.get("id") or ""),
                        "name": name,
                        "arguments": (
                            arguments
                            if isinstance(arguments, str)
                            else json.dumps(
                                arguments, ensure_ascii=True, sort_keys=True
                            )
                        ),
                    }
                )
    selected_reversed: list[dict[str, object]] = []
    for call in reversed(candidates):
        key = (str(call["name"]), _canonical_arguments(call["arguments"]))
        if needed[key] <= 0:
            continue
        needed[key] -= 1
        selected_reversed.append(call)
    if any(needed.values()):
        raise NativeRuntimeError(
            "executed benchmark tool calls could not be tied to native AIAgent messages"
        )
    return list(reversed(selected_reversed))


def _usage(result: Mapping[str, object]) -> dict[str, object]:
    usage: dict[str, object] = {}
    for source, target in (
        ("prompt_tokens", "prompt_tokens"),
        ("completion_tokens", "completion_tokens"),
        ("total_tokens", "total_tokens"),
        ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("cache_read_tokens", "cache_read_input_tokens"),
        ("cache_write_tokens", "cache_creation_input_tokens"),
        ("reasoning_tokens", "reasoning_tokens"),
    ):
        value = result.get(source)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            usage[target] = int(value)
    return usage


def run_native_turn(
    payload: Mapping[str, object],
    *,
    module_loader: Callable[[str], ModuleType] = importlib.import_module,
) -> dict[str, object]:
    """Run one benchmark turn through ``AIAgent.run_conversation``."""

    workspace_path = _verified_workspace_path(payload)
    spec = _bridge_from_payload(payload)
    agent_class, module_file = _load_agent_class(payload, module_loader)
    agent = _instantiate_agent(agent_class, payload, spec)
    user_message, system_message, history = _conversation_inputs(payload)
    run_conversation = getattr(agent, NATIVE_RUNTIME_API, None)
    if not callable(run_conversation):
        _close_agent(agent)
        raise NativeRuntimeError("run_agent.AIAgent.run_conversation is missing")
    try:
        result = run_conversation(
            user_message,
            system_message=system_message,
            conversation_history=history,
            task_id=str(payload.get("task_id") or "benchmark-turn"),
        )
    finally:
        _close_agent(agent)
    if not isinstance(result, Mapping):
        raise NativeRuntimeError("AIAgent.run_conversation returned a non-object")
    captures = _read_capture(spec)
    completed = result.get("completed")
    failed = result.get("failed")
    interrupted = result.get("interrupted")
    exit_reason = result.get("turn_exit_reason")
    capture_stopped = (
        _capture_stop_enabled(payload)
        and bool(captures)
        and completed is False
        and failed is False
        and interrupted is True
        and exit_reason == "interrupted_by_user"
    )
    # A no-tool text turn has no tool orchestration to fail: its only
    # non-completion modes are the model producing empty or non-terminal
    # content (``empty_response_exhausted``, ``max_iterations_reached``).
    # Those are scoreable per-scenario outcomes — a wrong/abstain answer — not
    # a transport failure, so return the (possibly empty) turn response with an
    # explicit marker instead of raising and aborting the whole benchmark on
    # one bad generation. ``failed is True`` still marks a genuine runtime
    # failure (invalid API response, local exception) and is raised, as is any
    # non-completion on a tool turn.
    benign_incomplete = (
        not capture_stopped
        and not spec.tool_names
        and completed is not True
        and failed is False
        and interrupted is not True
    )
    if (
        not capture_stopped
        and not benign_incomplete
        and (completed is not True or failed is not False or interrupted is True)
    ):
        raise NativeRuntimeError(
            "AIAgent.run_conversation did not complete successfully "
            f"(completed={completed!r}, failed={failed!r}, "
            f"interrupted={interrupted!r}, "
            f"exit_reason={exit_reason!r})"
        )
    tool_calls = _captured_tool_calls(result, captures)
    provenance = _provenance(
        spec,
        module_file=module_file,
        captured_calls=len(captures),
        workspace_path=workspace_path,
        capture_stop_enabled=_capture_stop_enabled(payload),
    )
    thought = result.get("last_reasoning")
    if not isinstance(thought, str) or not thought.strip():
        thought = None
    final_response = result.get("final_response")
    text = final_response if isinstance(final_response, str) else ""
    # ``(empty)`` is the loop's internal terminal sentinel for "model produced
    # nothing usable", not model content. Normalize it to an empty string on a
    # benign-incomplete turn so the caller scores a true empty answer.
    if benign_incomplete and text.strip() == "(empty)":
        text = ""
    return {
        "text": text,
        "thought": thought,
        "actions": [str(call["name"]) for call in tool_calls],
        "params": {
            "tool_calls": tool_calls,
            "lifecycle_results": [
                {
                    "name": str(record["name"]),
                    "arguments": dict(record["arguments"]),
                    "result": dict(record["result"]),
                }
                for record in captures
                if record["result"].get("effect") == "not_executed"
            ],
            "usage": _usage(result),
            "_meta": {
                **provenance,
                "native_api_calls": result.get("api_calls"),
                "native_completed": result.get("completed"),
                "native_failed": result.get("failed"),
                "native_interrupted": result.get("interrupted"),
                "native_turn_exit_reason": result.get("turn_exit_reason"),
                # True when the model produced no usable terminal answer on a
                # no-tool turn; the caller scores this turn as wrong/abstain
                # rather than treating it as a harness failure.
                "native_incomplete_turn": benign_incomplete,
            },
        },
    }


def _error_payload(exc: BaseException) -> dict[str, object]:
    return {
        "status": "error",
        "error": f"{type(exc).__name__}: {exc}",
        "agent_runtime": "hermes",
        "native_runtime_class": NATIVE_RUNTIME_CLASS,
        "native_runtime_api": NATIVE_RUNTIME_API,
        "transport": NATIVE_TRANSPORT,
        "legacy_raw_openai_bypass": False,
        "publishable_native": False,
    }


def main(argv: Sequence[str] | None = None) -> int:
    """Read one JSON payload from stdin and emit one terminal JSON object."""

    arguments = list(argv if argv is not None else sys.argv[1:])
    health = arguments == ["--health"]
    if arguments not in ([], ["--health"]):
        print(
            json.dumps(
                _error_payload(NativeRuntimeError("unsupported runner arguments"))
            )
        )
        return 2
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        if not isinstance(payload, Mapping):
            raise NativeRuntimeError("native runner stdin must be a JSON object")
        response = run_health_probe(payload) if health else run_native_turn(payload)
    except BaseException as exc:
        print(json.dumps(_error_payload(exc), ensure_ascii=True, sort_keys=True))
        return 1
    print(json.dumps(response, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
