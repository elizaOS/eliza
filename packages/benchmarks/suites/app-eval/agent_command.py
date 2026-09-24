"""Command helper for running App Eval coding workspaces through agents."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence


DEFAULT_MAX_TURNS = 20
DEFAULT_COMMAND_TIMEOUT_SECONDS = 120
MAX_TOOL_OUTPUT_CHARS = 12_000
TASK_COMPLETE_MARKER = "TASK_COMPLETE"
SANDBOX_IMAGE = "oven/bun:1.3.14-debian"
SANDBOX_NETWORK = "bridge"
SANDBOX_MEMORY = "2g"
SANDBOX_PIDS_LIMIT = 256
BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": (
            "Execute one Bash command in the root of the isolated App Eval task "
            "workspace. The result includes exit code, stdout, and stderr."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The Bash command to execute in the task workspace.",
                }
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
}
SYSTEM_PROMPT = (
    "You are an autonomous coding benchmark agent working in an isolated task "
    "workspace. Inspect and modify the workspace only through the provided bash "
    "tool. Run useful checks before finishing. Never serialize a command in prose, "
    "XML, markdown, or JSON: invoke the native bash tool. When the implementation "
    "is complete, return TASK_COMPLETE as assistant text without a tool call. Hidden "
    "evaluation assertions are intentionally unavailable."
)


class AgentProtocolError(RuntimeError):
    """The native harness returned a malformed or out-of-scope tool call."""


def _repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "harnesses" / "eliza").exists():
            return parent
    raise FileNotFoundError("Could not locate repository root from App Eval agent command")


def _add_adapter_paths() -> Path:
    root = _repo_root()
    for relative in (
        "harnesses/eliza",
        "harnesses/hermes",
        "harnesses/openclaw",
        ".",
    ):
        path = str(root / relative)
        if path not in sys.path:
            sys.path.insert(0, path)
    return root


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def build_prompt(*, prompt_path: str, workspace: str) -> str:
    prompt = _read_text(prompt_path)
    return "\n\n".join(
        [
            "You are running an App Eval coding benchmark task.",
            f"Repository workspace: {workspace}",
            "Modify files in that workspace until the requested implementation is complete.",
            "Do not edit files outside the workspace. Leave tests and source files on disk.",
            prompt,
        ]
    )


def _mapping(value: object) -> Mapping[str, object] | None:
    return value if isinstance(value, Mapping) else None


def _tool_call_name_and_arguments(call: Mapping[str, object]) -> tuple[str, object]:
    function = _mapping(call.get("function"))
    name = call.get("name")
    arguments = call.get("arguments")
    if function is not None:
        name = function.get("name", name)
        arguments = function.get("arguments", arguments)
    return str(name or "").strip(), arguments


def bash_commands_from_params(params: Mapping[str, object]) -> list[str]:
    """Decode only native captured ``bash`` calls; assistant text is never executable."""

    raw_calls = params.get("tool_calls")
    if raw_calls in (None, []):
        return []
    if not isinstance(raw_calls, Sequence) or isinstance(
        raw_calls, (str, bytes, bytearray)
    ):
        raise AgentProtocolError("native tool_calls must be a list")

    commands: list[str] = []
    for index, raw_call in enumerate(raw_calls):
        call = _mapping(raw_call)
        if call is None:
            raise AgentProtocolError(f"native tool call {index} is not an object")
        name, arguments = _tool_call_name_and_arguments(call)
        if name.lower() != "bash":
            raise AgentProtocolError(
                f"native tool call {index} selected {name!r}; only 'bash' is scoped"
            )
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as exc:
                raise AgentProtocolError(
                    f"native bash call {index} arguments are not valid JSON"
                ) from exc
        argument_map = _mapping(arguments)
        command = argument_map.get("command") if argument_map is not None else None
        if not isinstance(command, str) or not command.strip():
            raise AgentProtocolError(
                f"native bash call {index} has no non-empty string command"
            )
        commands.append(command.strip())
    return commands


def _tool_calls_for_history(params: Mapping[str, object]) -> list[dict[str, object]]:
    raw_calls = params.get("tool_calls")
    if not isinstance(raw_calls, Sequence) or isinstance(
        raw_calls, (str, bytes, bytearray)
    ):
        return []
    normalized: list[dict[str, object]] = []
    for index, raw_call in enumerate(raw_calls):
        call = _mapping(raw_call)
        if call is None:
            continue
        name, arguments = _tool_call_name_and_arguments(call)
        if isinstance(arguments, Mapping):
            encoded_arguments = json.dumps(arguments, ensure_ascii=True, sort_keys=True)
        elif isinstance(arguments, str):
            encoded_arguments = arguments
        else:
            encoded_arguments = "{}"
        normalized.append(
            {
                "id": str(call.get("id") or f"call_{index}"),
                "type": "function",
                "function": {"name": name, "arguments": encoded_arguments},
            }
        )
    return normalized


def _signals_complete(text: str) -> bool:
    return TASK_COMPLETE_MARKER in text.upper()


@lru_cache(maxsize=1)
def sandbox_provenance() -> dict[str, object]:
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError(
            "App Eval coding commands require Docker; refusing unsandboxed execution"
        )
    completed = subprocess.run(
        [docker, "image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
        check=False,
    )
    image_id = (completed.stdout or "").strip()
    if completed.returncode != 0 or not image_id.startswith("sha256:"):
        raise RuntimeError(
            f"required App Eval sandbox image {SANDBOX_IMAGE!r} is unavailable: "
            f"{(completed.stderr or '').strip()}"
        )
    return {
        "runtime": "docker",
        "image": SANDBOX_IMAGE,
        "image_id": image_id,
        "network": SANDBOX_NETWORK,
        "mounts": ["task_workspace:/workspace:rw"],
        "host_environment_forwarded": False,
        "capabilities": "all-dropped",
        "no_new_privileges": True,
        "memory_limit": SANDBOX_MEMORY,
        "pids_limit": SANDBOX_PIDS_LIMIT,
    }


def run_sandboxed_command(
    command: str,
    *,
    workspace: Path,
    timeout_seconds: int,
) -> dict[str, object]:
    """Execute one command in a fresh, resource-limited workspace-only container."""

    provenance = sandbox_provenance()
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("Docker disappeared after App Eval sandbox preflight")
    resolved_workspace = workspace.resolve()
    if not resolved_workspace.is_dir():
        raise RuntimeError(f"App Eval workspace does not exist: {resolved_workspace}")
    for relative in (".cache/bun", ".cache/npm", ".cache/xdg", ".tmp"):
        (resolved_workspace / relative).mkdir(parents=True, exist_ok=True)
    container_name = f"app-eval-{uuid.uuid4().hex}"
    argv = [
        docker,
        "run",
        "--rm",
        "--name",
        container_name,
        "--network",
        SANDBOX_NETWORK,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        str(SANDBOX_PIDS_LIMIT),
        "--memory",
        SANDBOX_MEMORY,
        "--memory-swap",
        SANDBOX_MEMORY,
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--mount",
        f"type=bind,src={resolved_workspace},dst=/workspace",
        "--workdir",
        "/workspace",
        "--env",
        "TMPDIR=/workspace/.tmp",
        "--env",
        "XDG_CACHE_HOME=/workspace/.cache/xdg",
        "--env",
        "BUN_INSTALL_CACHE_DIR=/workspace/.cache/bun",
        "--env",
        "npm_config_cache=/workspace/.cache/npm",
        "--env",
        "NO_COLOR=1",
        SANDBOX_IMAGE,
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        command,
    ]
    try:
        completed = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        return {
            "command": command,
            "exit_code": completed.returncode,
            "stdout": (completed.stdout or "")[-MAX_TOOL_OUTPUT_CHARS:],
            "stderr": (completed.stderr or "")[-MAX_TOOL_OUTPUT_CHARS:],
            "timed_out": False,
            "sandbox": provenance,
        }
    except subprocess.TimeoutExpired as exc:
        subprocess.run(
            [docker, "rm", "-f", container_name],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {
            "command": command,
            "exit_code": None,
            "stdout": stdout[-MAX_TOOL_OUTPUT_CHARS:],
            "stderr": stderr[-MAX_TOOL_OUTPUT_CHARS:],
            "timed_out": True,
            "error": f"command timed out after {timeout_seconds} seconds",
            "sandbox": provenance,
        }


def _run_bash(
    command: str,
    *,
    workspace: Path,
    timeout_seconds: int,
) -> dict[str, object]:
    return run_sandboxed_command(
        command,
        workspace=workspace,
        timeout_seconds=timeout_seconds,
    )


def _tool_feedback(result: Mapping[str, object]) -> str:
    return "\n".join(
        [
            f"$ {result.get('command', '')}",
            f"exit_code={result.get('exit_code')}",
            f"timed_out={str(bool(result.get('timed_out'))).lower()}",
            "stdout:",
            str(result.get("stdout") or ""),
            "stderr:",
            str(result.get("stderr") or ""),
            *([f"error: {result['error']}"] if result.get("error") else []),
        ]
    )


def _usage_value(usage: Mapping[str, object], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
    return 0


def _aggregate_usage(turns: list[dict[str, object]]) -> dict[str, int]:
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    for turn in turns:
        usage = _mapping(turn.get("usage")) or {}
        prompt = _usage_value(usage, "prompt_tokens", "promptTokens", "input_tokens")
        completion = _usage_value(
            usage,
            "completion_tokens",
            "completionTokens",
            "output_tokens",
        )
        total = _usage_value(usage, "total_tokens", "totalTokens")
        totals["prompt_tokens"] += prompt
        totals["completion_tokens"] += completion
        totals["total_tokens"] += total or prompt + completion
        totals["cache_read_input_tokens"] += _usage_value(
            usage,
            "cache_read_input_tokens",
            "cachedTokens",
            "cached_tokens",
        )
        totals["cache_creation_input_tokens"] += _usage_value(
            usage,
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
        )
    return totals


def _runtime_provenance(response: object) -> dict[str, object]:
    params = _mapping(getattr(response, "params", None)) or {}
    metadata = _mapping(getattr(response, "metadata", None)) or {}
    meta = _mapping(params.get("_meta")) or {}
    return {
        "metadata": dict(metadata),
        "adapter_meta": dict(meta),
    }


def _require_publishable_provenance(adapter: str, response: object) -> None:
    provenance = _runtime_provenance(response)
    metadata = _mapping(provenance["metadata"]) or {}
    adapter_meta = _mapping(provenance["adapter_meta"]) or {}
    if adapter == "eliza":
        valid = (
            metadata.get("agent_label") == "eliza"
            and metadata.get("native_runtime_class") == "@elizaos/core.AgentRuntime"
            and metadata.get("native_runtime_api") == "messageService.handleMessage"
            and metadata.get("transport") == "eliza_benchmark_http"
            and metadata.get("tool_bridge") == "native_action_capture"
            and metadata.get("release_evidence") is True
            and metadata.get("direct_model_bypass") is False
            and metadata.get("stand_in") is False
            and metadata.get("tool_schema_count") == 1
            and metadata.get("tool_names") == ["bash"]
        )
    elif adapter == "hermes":
        valid = (
            adapter_meta.get("agent_runtime") == "hermes"
            and adapter_meta.get("native_runtime_class") == "run_agent.AIAgent"
            and adapter_meta.get("native_runtime_api") == "run_conversation"
            and adapter_meta.get("transport")
            == "subprocess_loopback_openai_compatible"
            and adapter_meta.get("native_agent_instantiated") is True
            and adapter_meta.get("publishable_native") is True
            and adapter_meta.get("legacy_raw_openai_bypass") is False
            and adapter_meta.get("tool_bridge_loaded_tools") == ["bash"]
        )
    elif adapter == "openclaw":
        openclaw_meta = _mapping(adapter_meta.get("openclaw_adapter")) or {}
        valid = (
            openclaw_meta.get("agent_runtime") == "openclaw"
            and openclaw_meta.get("native_runtime_class")
            == "openclaw.agent.embedded"
            and openclaw_meta.get("native_runtime_api")
            == "openclaw agent --local --json"
            and openclaw_meta.get("publishable_native") is True
            and openclaw_meta.get("transport") == "openclaw_embedded_runtime"
            and openclaw_meta.get("tool_bridge") == "native_plugin"
            and openclaw_meta.get("passes_benchmark_tools") is True
        )
    else:
        raise AgentProtocolError(f"unsupported App Eval adapter provenance: {adapter!r}")
    if not valid:
        raise AgentProtocolError(
            f"{adapter} returned missing or nonpublishable native runtime provenance"
        )


def run_workspace_agent(
    client: object,
    *,
    prompt: str,
    workspace: Path,
    task_id: str,
    adapter: str,
    max_turns: int = DEFAULT_MAX_TURNS,
    command_timeout_seconds: int = DEFAULT_COMMAND_TIMEOUT_SECONDS,
) -> dict[str, object]:
    """Drive every harness through the same captured-tool/host-execution loop."""

    history: list[dict[str, object]] = [{"role": "user", "content": prompt}]
    turns: list[dict[str, object]] = []
    command_results: list[dict[str, object]] = []
    completed = False

    reset = getattr(client, "reset")
    send_message = getattr(client, "send_message")
    reset(task_id=task_id, benchmark="app_eval_coding")

    for turn_index in range(max_turns):
        response = send_message(
            text=(
                prompt
                if turn_index == 0
                else "Continue from the full conversation history. Use the native "
                "bash tool for the next command, or reply TASK_COMPLETE if done."
            ),
            context={
                "benchmark": "app_eval_coding",
                "task_id": task_id,
                "session_id": f"app-eval-coding-{task_id}",
                "workspace": str(workspace),
                "system_prompt": SYSTEM_PROMPT,
                "messages": list(history),
                "tools": [BASH_TOOL],
                "tool_choice": "auto",
                "iteration": turn_index,
            },
        )
        _require_publishable_provenance(adapter, response)
        response_text = str(getattr(response, "text", "") or "")
        params = _mapping(getattr(response, "params", None)) or {}
        commands = bash_commands_from_params(params)
        history_calls = _tool_calls_for_history(params)
        assistant_entry: dict[str, object] = {
            "role": "assistant",
            "content": response_text or None,
        }
        if history_calls:
            assistant_entry["tool_calls"] = history_calls
        history.append(assistant_entry)

        turn_record: dict[str, object] = {
            "turn": turn_index,
            "text": response_text,
            "tool_calls": history_calls,
            "usage": dict(_mapping(params.get("usage")) or {}),
            "runtime_provenance": _runtime_provenance(response),
            "commands": [],
        }
        turns.append(turn_record)

        for call_index, command in enumerate(commands):
            result = _run_bash(
                command,
                workspace=workspace,
                timeout_seconds=command_timeout_seconds,
            )
            command_results.append(result)
            cast_commands = turn_record["commands"]
            if isinstance(cast_commands, list):
                cast_commands.append(result)
            call_id = (
                str(history_calls[call_index].get("id") or f"call_{turn_index}_{call_index}")
                if call_index < len(history_calls)
                else f"call_{turn_index}_{call_index}"
            )
            history.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": "bash",
                    "content": _tool_feedback(result),
                }
            )

        if _signals_complete(response_text) and commands:
            history.append(
                {
                    "role": "user",
                    "content": (
                        "The commands were executed, but completion must be confirmed "
                        "in a separate assistant turn with TASK_COMPLETE and no tool call."
                    ),
                }
            )
            continue
        if _signals_complete(response_text):
            completed = True
            break
        if not commands:
            history.append(
                {
                    "role": "user",
                    "content": (
                        "No native bash tool call was captured. Assistant prose is not "
                        "executed. Invoke bash, or reply TASK_COMPLETE when finished."
                    ),
                }
            )

    return {
        "status": "completed" if completed else "incomplete",
        "adapter": adapter,
        "turn_count": len(turns),
        "completed_marker": completed,
        "commands_executed": len(command_results),
        "commands": command_results,
        "turns": turns,
        "usage": _aggregate_usage(turns),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an App Eval coding task through a benchmark agent.")
    parser.add_argument(
        "--adapter",
        required=True,
        choices=["eliza", "elizaos", "hermes", "openclaw"],
    )
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--provider", default="cerebras")
    parser.add_argument("--model", default="gemma-4-31b")
    parser.add_argument("--timeout-seconds", type=int, default=7200)
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    parser.add_argument(
        "--command-timeout-seconds",
        type=int,
        default=DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--result-json", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.max_turns <= 0:
        raise SystemExit("--max-turns must be positive")
    if args.command_timeout_seconds <= 0:
        raise SystemExit("--command-timeout-seconds must be positive")
    workspace = Path(args.workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(prompt_path=args.prompt, workspace=str(workspace))
    result_json = Path(args.result_json)
    adapter = "eliza" if args.adapter == "elizaos" else args.adapter
    metadata: dict[str, Any] = {
        "adapter": adapter,
        "benchmark": "app_eval_coding",
        "task": args.task,
        "workspace": str(workspace),
        "prompt": args.prompt,
        "provider": args.provider,
        "model": args.model,
        "prompt_chars": len(prompt),
        "dry_run": bool(args.dry_run),
    }
    if args.dry_run:
        _write_json(result_json, {**metadata, "status": "dry_run"})
        return 0

    root = _add_adapter_paths()
    os.environ["BENCHMARK_MODEL_PROVIDER"] = args.provider
    os.environ["BENCHMARK_MODEL_NAME"] = args.model
    os.environ["BENCHMARK_HARNESS"] = adapter
    os.environ["ELIZA_BENCH_HARNESS"] = adapter
    os.environ["BENCHMARK_AGENT"] = adapter
    os.environ.pop("BENCHMARK_TASK_AGENT", None)
    for inherited_agent_selector in (
        "ELIZA_ACP_DEFAULT_AGENT",
        "ELIZA_DEFAULT_AGENT_TYPE",
        "ELIZA_AGENT_ORCHESTRATOR",
        "ELIZA_AGENT_SELECTION_STRATEGY",
    ):
        os.environ.pop(inherited_agent_selector, None)
    os.environ.setdefault("ELIZA_BENCH_HTTP_TIMEOUT", str(args.timeout_seconds))
    os.environ.setdefault("ELIZA_BENCH_START_TIMEOUT", "300")

    from eliza_adapter import ElizaServerManager  # type: ignore

    manager = ElizaServerManager(timeout=300.0, repo_root=root)
    try:
        manager.start()
        manager.client.wait_until_ready(timeout=min(float(args.timeout_seconds), 300.0))
        run_result = run_workspace_agent(
            manager.client,
            prompt=prompt,
            workspace=workspace,
            task_id=args.task,
            adapter=adapter,
            max_turns=args.max_turns,
            command_timeout_seconds=args.command_timeout_seconds,
        )
        _write_json(result_json, {**metadata, **run_result})
        return 0 if run_result["status"] == "completed" else 1
    except Exception as exc:
        _write_json(
            result_json,
            {
                **metadata,
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        return 1
    finally:
        manager.stop()


if __name__ == "__main__":
    raise SystemExit(main())
