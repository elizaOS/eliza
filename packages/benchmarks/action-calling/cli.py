"""action-calling CLI.

Evaluates native function/tool calling. The benchmark sends OpenAI-compatible
``tools`` to the model and scores the returned ``tool_calls``. For the Eliza
harness, the HTTP benchmark server runs the real runtime and returns the
captured action calls produced by the planner.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("action-calling")

PACKAGES_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PACKAGES_ROOT / "training"
DEFAULT_TEST = TRAINING_ROOT / "data" / "native" / "records" / "hermes-fc-v1.jsonl"
SMOKE_TEST = Path(__file__).resolve().parent / "fixtures" / "smoke.jsonl"

OPENAI_COMPAT_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "vllm": "http://127.0.0.1:8001/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}

PLANNER_STAGES = {"planner", "message_handler", "agent_trace", "tool_call", "mcp_tool_call"}
TERMINAL_TOOL_NAMES = {"REPLY", "IGNORE", "STOP", "NONE"}
HARNESS_NAMES = {"eliza", "hermes", "openclaw"}


@dataclass(frozen=True)
class ExpectedCase:
    record: dict[str, Any]
    messages: list[dict[str, str]]
    tools: list[dict[str, Any]]
    expected_calls: list[dict[str, Any]]


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _json_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"value": value}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {}


def _tool_name(call: Mapping[str, Any]) -> str:
    fn = _as_dict(call.get("function"))
    name = call.get("name") or call.get("tool_name") or call.get("tool") or fn.get("name")
    return str(name or "").strip()


def _tool_args(call: Mapping[str, Any]) -> dict[str, Any]:
    fn = _as_dict(call.get("function"))
    return _json_args(
        call.get("args")
        if "args" in call
        else call.get("arguments")
        if "arguments" in call
        else call.get("parameters")
        if "parameters" in call
        else fn.get("arguments")
    )


def _normalize_tool_call(call: Mapping[str, Any]) -> dict[str, Any] | None:
    name = _tool_name(call)
    if not name or name.upper() in TERMINAL_TOOL_NAMES:
        return None
    return {"name": name, "arguments": _tool_args(call)}


def _normalize_tool_spec(tool: Mapping[str, Any]) -> dict[str, Any] | None:
    fn = _as_dict(tool.get("function"))
    name = tool.get("name") or fn.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    description = tool.get("description") or fn.get("description") or ""
    parameters = tool.get("parameters") or fn.get("parameters") or {
        "type": "object",
        "properties": {},
    }
    return {
        "type": "function",
        "function": {
            "name": name.strip(),
            "description": str(description),
            "parameters": parameters,
        },
    }


def _record_tools(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_tools = record.get("tools")
    if not isinstance(raw_tools, list):
        raw_tools = _as_dict(record.get("metadata")).get("toolSpecs")
    if not isinstance(raw_tools, list):
        return []
    tools: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_tools:
        if not isinstance(raw, Mapping):
            continue
        tool = _normalize_tool_spec(raw)
        if tool is None:
            continue
        name = str(tool["function"]["name"])
        if name.upper() in TERMINAL_TOOL_NAMES or name in seen:
            continue
        seen.add(name)
        tools.append(tool)
    return tools


def _expected_calls(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    candidates = [
        record.get("expectedToolCalls"),
        record.get("expected_tool_calls"),
        _as_dict(record.get("metadata")).get("expectedToolCalls"),
        _as_dict(record.get("metadata")).get("expected_tool_calls"),
        _as_dict(_as_dict(record.get("output")).get("planner")).get("toolCalls"),
    ]
    for raw in candidates:
        if isinstance(raw, list):
            calls = [
                normalized
                for item in raw
                if isinstance(item, Mapping)
                for normalized in [_normalize_tool_call(item)]
                if normalized is not None
            ]
            if calls:
                return calls
    single = record.get("expectedToolCall") or record.get("expected_tool_call")
    if isinstance(single, Mapping):
        call = _normalize_tool_call(single)
        return [call] if call else []
    return []


def _record_messages(record: Mapping[str, Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": (
                "Use native function/tool calls for any requested operation. "
                "Do not serialize tool calls in text, XML, markdown, or JSON. "
                "Return assistant text only when no tool call is needed."
            ),
        }
    ]
    raw_messages = record.get("messages")
    if isinstance(raw_messages, Sequence) and not isinstance(raw_messages, (str, bytes)):
        for message in raw_messages:
            if not isinstance(message, Mapping):
                continue
            role = message.get("role")
            content = message.get("content")
            if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
                messages.append({"role": str(role), "content": content})
    else:
        current = _as_dict(record.get("currentMessage"))
        content = current.get("content")
        if isinstance(content, str) and content.strip():
            messages.append({"role": "user", "content": content})
    return messages


def _load_cases(test_file: Path, limit: int) -> list[ExpectedCase]:
    out: list[ExpectedCase] = []
    with test_file.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            stage = str(record.get("stage") or _as_dict(record.get("metadata")).get("task_type") or "")
            if stage and stage not in PLANNER_STAGES:
                continue
            tools = _record_tools(record)
            expected = _expected_calls(record)
            messages = _record_messages(record)
            if not tools or not expected or len(messages) < 2:
                continue
            out.append(ExpectedCase(record=record, messages=messages, tools=tools, expected_calls=expected))
            if len(out) >= limit:
                break
    return out


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="native action-calling")
    p.add_argument(
        "--provider",
        default="vllm",
        choices=(
            "vllm",
            "openai",
            "groq",
            "openrouter",
            "anthropic",
            "cerebras",
            "eliza",
            "hermes",
            "openclaw",
            "mock",
        ),
    )
    p.add_argument("--model", required=True)
    p.add_argument("--base-url", default=None)
    p.add_argument("--api-key-env", default="OPENAI_API_KEY")
    p.add_argument("--test-file", default=str(DEFAULT_TEST))
    p.add_argument("--max-examples", type=int, default=100)
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--tool-choice", choices=("auto", "required"), default="auto")
    p.add_argument("--out", required=True)
    return p


def _selected_harness(provider: str) -> str:
    if provider.strip().lower() == "mock":
        return ""
    env_harness = (
        os.environ.get("ELIZA_BENCH_HARNESS")
        or os.environ.get("BENCHMARK_HARNESS")
        or ""
    ).strip().lower()
    if env_harness in HARNESS_NAMES:
        return env_harness
    provider = provider.strip().lower()
    return provider if provider in HARNESS_NAMES else ""


def _ensure_adapter_path(dirname: str) -> None:
    path = str(PACKAGES_ROOT / "benchmarks" / dirname)
    if path not in sys.path:
        sys.path.insert(0, path)


def _harness_model_provider(args: argparse.Namespace) -> str:
    provider = (
        os.environ.get("BENCHMARK_MODEL_PROVIDER")
        or os.environ.get("ELIZA_PROVIDER")
        or args.provider
    ).strip().lower()
    return "cerebras" if provider in HARNESS_NAMES else provider


def _make_harness_client(harness: str, args: argparse.Namespace):
    provider = _harness_model_provider(args)
    model = (os.environ.get("BENCHMARK_MODEL_NAME") or args.model).strip()
    if harness == "eliza":
        _ensure_adapter_path("eliza-adapter")
        from eliza_adapter import ElizaClient, ElizaServerManager  # noqa: WPS433

        manager = ElizaServerManager()
        manager.start()
        client = (
            manager.client
            if getattr(manager.client, "_delegate", None) is not None
            else ElizaClient(manager.client.base_url, token=manager.token)
        )
        setattr(client, "_benchmark_server_manager", manager)
        return client
    if harness == "hermes":
        _ensure_adapter_path("hermes-adapter")
        from hermes_adapter.client import HermesClient  # noqa: WPS433

        client = HermesClient(provider=provider, model=model, base_url=args.base_url)
        client.wait_until_ready(timeout=120)
        return client
    if harness == "openclaw":
        _ensure_adapter_path("openclaw-adapter")
        from openclaw_adapter.client import OpenClawClient  # noqa: WPS433

        client = OpenClawClient(provider=provider, model=model, base_url=args.base_url)
        client.wait_until_ready(timeout=120)
        return client
    raise SystemExit(f"unknown harness {harness!r}")


def _make_client(args: argparse.Namespace):
    provider = args.provider.strip().lower()
    harness = _selected_harness(provider)
    if harness:
        return _make_harness_client(harness, args)
    if provider == "anthropic":
        from anthropic import Anthropic  # noqa: WPS433

        api_key = os.environ.get(args.api_key_env)
        if not api_key and args.api_key_env == "OPENAI_API_KEY":
            api_key = os.environ.get("ANTHROPIC_API_KEY")
        kwargs: dict[str, str] = {"api_key": api_key or "EMPTY"}
        if args.base_url:
            kwargs["base_url"] = args.base_url
        return Anthropic(**kwargs)

    from openai import OpenAI  # noqa: WPS433

    base_url = (
        args.base_url
        or os.environ.get(f"{provider.upper()}_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or OPENAI_COMPAT_BASE_URLS.get(provider)
    )
    if not base_url:
        raise SystemExit(f"--base-url required for {provider} provider")
    api_key_env = args.api_key_env
    if api_key_env == "OPENAI_API_KEY" and provider in {"groq", "openrouter", "anthropic", "cerebras"}:
        api_key_env = {
            "anthropic": "ANTHROPIC_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "cerebras": "CEREBRAS_API_KEY",
        }[provider]
    api_key = os.environ.get(api_key_env) or os.environ.get(args.api_key_env, "EMPTY")
    return OpenAI(base_url=base_url, api_key=api_key)


def _parse_openai_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for call in tool_calls or []:
        if isinstance(call, Mapping):
            fn = _as_dict(call.get("function"))
            raw = {
                "name": fn.get("name") or call.get("name"),
                "arguments": fn.get("arguments") if "arguments" in fn else call.get("arguments"),
            }
        else:
            fn = getattr(call, "function", None)
            raw = {
                "name": getattr(fn, "name", None) or getattr(call, "name", None),
                "arguments": getattr(fn, "arguments", None) if fn is not None else getattr(call, "arguments", None),
            }
        normalized = _normalize_tool_call(raw)
        if normalized is not None:
            parsed.append(normalized)
    return parsed


def _parse_content_tool_calls(text: str) -> list[dict[str, Any]]:
    """Diagnostic fallback for JSON text, not benchmark success.

    These calls are reported in failures but do not count as native tool-call
    success; the benchmark requires the provider's actual ``tool_calls`` field.
    """
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = {}
        raw_calls = _as_dict(parsed).get("tool_calls")
        if isinstance(raw_calls, list):
            return [
                normalized
                for item in raw_calls
                if isinstance(item, Mapping)
                for normalized in [_normalize_tool_call(item)]
                if normalized is not None
            ]
    return []


def _action_to_call(action: Mapping[str, Any]) -> dict[str, Any] | None:
    raw = {
        "name": action.get("tool_name") or action.get("tool") or action.get("name") or action.get("command"),
        "arguments": action.get("arguments") or action.get("args") or {
            k: v
            for k, v in action.items()
            if k not in {"tool_name", "tool", "name", "command"}
        },
    }
    return _normalize_tool_call(raw)


def _harness_response_to_calls(response: Any) -> tuple[list[dict[str, Any]], str, str]:
    params = getattr(response, "params", {}) or {}
    calls: list[dict[str, Any]] = []
    source = "model_text"
    if isinstance(params, Mapping):
        raw_actions = params.get("BENCHMARK_ACTIONS")
        if isinstance(raw_actions, list):
            for action in raw_actions:
                if isinstance(action, Mapping):
                    normalized = _action_to_call(action)
                    if normalized is not None:
                        calls.append(normalized)
            if calls:
                source = "captured_action"
        raw_action = params.get("BENCHMARK_ACTION")
        if not calls and isinstance(raw_action, Mapping):
            normalized = _action_to_call(raw_action)
            if normalized is not None:
                calls.append(normalized)
                source = "captured_action"
        raw_tool_calls = params.get("tool_calls")
        if not calls and isinstance(raw_tool_calls, list):
            for item in raw_tool_calls:
                if isinstance(item, Mapping):
                    normalized = _normalize_tool_call(item)
                    if normalized is not None:
                        calls.append(normalized)
            if calls:
                source = "native_tool_calls"
    actions = getattr(response, "actions", []) or []
    if not calls and isinstance(actions, Sequence) and not isinstance(actions, (str, bytes)):
        for action in actions:
            if isinstance(action, Mapping):
                normalized = _normalize_tool_call(action)
            else:
                args = params.get(action, {}) if isinstance(params, Mapping) else {}
                normalized = _normalize_tool_call({"name": action, "arguments": args})
            if normalized is not None:
                calls.append(normalized)
        if calls:
            source = "native_tool_calls"
    return calls, str(getattr(response, "text", "") or ""), source


def _generate(
    client,
    provider: str,
    model: str,
    case: ExpectedCase,
    max_tokens: int,
    temperature: float,
    tool_choice: str,
) -> tuple[list[dict[str, Any]], str, str, list[dict[str, Any]]]:
    harness = _selected_harness(provider)
    if harness:
        user_text = next((m["content"] for m in reversed(case.messages) if m["role"] == "user"), "")
        response = client.send_message(
            text=user_text,
            context={
                "benchmark": "action-calling",
                "messages": case.messages,
                "tools": case.tools,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "tool_choice": tool_choice,
            },
        )
        calls, text, source = _harness_response_to_calls(response)
        return calls, text, source, []

    if provider == "anthropic":
        system = "\n\n".join(m["content"] for m in case.messages if m["role"] == "system")
        chat_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in case.messages
            if m["role"] in {"user", "assistant"} and m["content"]
        ]
        anthropic_tools = [
            {
                "name": tool["function"]["name"],
                "description": tool["function"].get("description", ""),
                "input_schema": tool["function"].get("parameters", {"type": "object", "properties": {}}),
            }
            for tool in case.tools
        ]
        resp = client.messages.create(
            model=model,
            messages=chat_messages,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system or None,
            tools=anthropic_tools,
        )
        calls = []
        text_parts = []
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use":
                normalized = _normalize_tool_call(
                    {"name": getattr(block, "name", None), "arguments": getattr(block, "input", {})}
                )
                if normalized is not None:
                    calls.append(normalized)
            elif hasattr(block, "text"):
                text_parts.append(getattr(block, "text", ""))
        return calls, "".join(text_parts), "native_tool_calls" if calls else "model_text", []

    resp = client.chat.completions.create(
        model=model,
        messages=case.messages,
        tools=case.tools,
        tool_choice=tool_choice,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    message = resp.choices[0].message
    text = getattr(message, "content", None) or ""
    calls = _parse_openai_tool_calls(getattr(message, "tool_calls", None))
    content_calls = _parse_content_tool_calls(text)
    return calls, text, "native_tool_calls" if calls else "model_text", content_calls


def _geometric_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    floored = [max(v, 1e-9) for v in values]
    return math.exp(sum(math.log(v) for v in floored) / len(floored))


def _lookup_tool_schema(tools: list[dict[str, Any]], name: str) -> dict[str, Any]:
    for tool in tools:
        fn = _as_dict(tool.get("function"))
        if fn.get("name") == name:
            return _as_dict(fn.get("parameters"))
    return {}


def _required_keys(expected: dict[str, Any], tools: list[dict[str, Any]]) -> set[str]:
    keys = set(_as_dict(expected.get("arguments")).keys())
    schema = _lookup_tool_schema(tools, str(expected.get("name") or ""))
    required = schema.get("required")
    if isinstance(required, list):
        keys.update(str(item) for item in required if isinstance(item, str))
    return keys


def _values_match(expected: Any, actual: Any) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and _values_match(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list):
        return expected == actual
    return expected == actual or str(expected) == str(actual)


def _score_case(
    expected_calls: list[dict[str, Any]],
    predicted_calls: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, bool]:
    native_tool_calls_ok = bool(predicted_calls)
    exact_count = len(predicted_calls) == len(expected_calls)
    name_match = exact_count and all(
        predicted_calls[index].get("name") == expected.get("name")
        for index, expected in enumerate(expected_calls)
    )
    args_parse_ok = exact_count and all(
        isinstance(predicted_calls[index].get("arguments"), dict)
        for index, _expected in enumerate(expected_calls)
    )
    required_keys_ok = exact_count
    arguments_match = exact_count
    for index, expected in enumerate(expected_calls):
        if index >= len(predicted_calls):
            required_keys_ok = False
            arguments_match = False
            break
        predicted_args = _as_dict(predicted_calls[index].get("arguments"))
        required_keys = _required_keys(expected, tools)
        if not required_keys.issubset(predicted_args.keys()):
            required_keys_ok = False
        if not _values_match(_as_dict(expected.get("arguments")), predicted_args):
            arguments_match = False
    return {
        "native_tool_calls_ok": native_tool_calls_ok,
        "tool_name_match": name_match,
        "args_parse_ok": args_parse_ok,
        "required_keys_ok": required_keys_ok,
        "arguments_match": arguments_match,
    }


def main() -> int:
    args = _build_argparser().parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    test_file = Path(args.test_file)
    if not test_file.exists() and test_file == DEFAULT_TEST and SMOKE_TEST.exists():
        test_file = SMOKE_TEST
    cases = _load_cases(test_file, args.max_examples)
    if not cases:
        raise SystemExit(f"no native tool-calling records found in {test_file}")
    log.info("loaded %d native tool-calling records", len(cases))

    client = None if args.provider == "mock" else _make_client(args)

    n = 0
    counts = {
        "native_tool_calls_ok": 0,
        "tool_name_match": 0,
        "args_parse_ok": 0,
        "required_keys_ok": 0,
        "arguments_match": 0,
    }
    failures: list[dict[str, Any]] = []
    generation_sources: set[str] = set()
    t0 = time.perf_counter()

    for i, case in enumerate(cases):
        if args.provider == "mock":
            predicted_calls = case.expected_calls
            gen_text = ""
            generation_source = "mock_expected_tool_calls"
            content_tool_calls: list[dict[str, Any]] = []
        else:
            try:
                if _selected_harness(args.provider) and hasattr(client, "reset"):
                    client.reset(
                        task_id=f"action-calling-{os.getpid()}-{i}",
                        benchmark="action-calling",
                    )
                predicted_calls, gen_text, generation_source, content_tool_calls = _generate(
                    client,
                    args.provider,
                    args.model,
                    case,
                    args.max_new_tokens,
                    args.temperature,
                    args.tool_choice,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("generation failed: %s", exc)
                continue
        generation_sources.add(generation_source)
        n += 1

        case_score = _score_case(case.expected_calls, predicted_calls, case.tools)
        for key, ok in case_score.items():
            if ok:
                counts[key] += 1

        if not all(case_score.values()) and len(failures) < 12:
            failures.append({
                "id": case.record.get("id") or _as_dict(case.record.get("metadata")).get("source_dataset"),
                "expected_tool_calls": case.expected_calls,
                "predicted_tool_calls": predicted_calls,
                "content_serialized_tool_calls": content_tool_calls,
                "generation_source": generation_source,
                **case_score,
                "predicted_text": gen_text[:600],
            })

        if (i + 1) % 25 == 0:
            log.info(
                "  %d/%d native=%d name=%d args=%d keys=%d values=%d",
                i + 1,
                len(cases),
                counts["native_tool_calls_ok"],
                counts["tool_name_match"],
                counts["args_parse_ok"],
                counts["required_keys_ok"],
                counts["arguments_match"],
            )

    def rate(key: str) -> float:
        return counts[key] / n if n else 0.0

    if n == 0:
        raise SystemExit("no examples were generated/evaluated")

    metrics = {
        "native_tool_calls_ok": rate("native_tool_calls_ok"),
        "tool_name_match": rate("tool_name_match"),
        "args_parse_ok": rate("args_parse_ok"),
        "required_keys_ok": rate("required_keys_ok"),
        "arguments_match": rate("arguments_match"),
    }
    metrics["score"] = _geometric_mean(list(metrics.values()))

    summary = {
        "model": args.model,
        "provider": args.provider,
        "dataset": str(test_file),
        "tool_choice": args.tool_choice,
        "generation_source": (
            next(iter(generation_sources))
            if len(generation_sources) == 1
            else "mixed"
        ),
        "generation_sources": sorted(generation_sources),
        "n": n,
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "metrics": metrics,
        "failures": failures,
    }
    out_path = out_dir / "action-calling-results.json"
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log.info("wrote %s  score=%.3f", out_path, metrics["score"])
    print(json.dumps(summary["metrics"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
