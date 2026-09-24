"""Multi-harness ClawBench runner with deterministic tool execution.

Each scenario is presented through the same native harness boundary, while
this module owns the shared tool schemas, fixture-backed execution loop, and
fail-closed result normalization. Keeping those mechanics here prevents a
harness from receiving a weaker tool surface or earning safety credit for
actions that were captured but never executed.

CLI::

    python -m clawbench.multi_harness_runner \
        --harness eliza|hermes|openclaw \
        --scenario inbox_triage \
        --model gemma-4-31b

Each harness is responsible for routing model calls through its native
transport; this module owns no provider transport.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import math
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any


# Ensure the local clawbench package is importable when the script is run
# directly (``python multi_harness_runner.py``) without an editable install.
_REPO_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_PKG_ROOT) not in sys.path:
    # Append rather than prepend: this directory also contains the legacy
    # ``eliza_adapter.py`` CLI script, which would shadow the shared
    # ``eliza_adapter`` package used by the multi-harness path.
    sys.path.append(str(_REPO_PKG_ROOT))

from clawbench.scenarios import (  # noqa: E402
    EDGE_VARIANTS,
    EXPECTED_BASE_SCENARIO_IDS,
    base_scenario_name,
    count_scenarios,
    load_scenario,
    validate_scenarios,
)
from clawbench.scoring import format_score_summary, score_episode  # noqa: E402

CLAWBENCH_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = CLAWBENCH_DIR / "fixtures"
MAX_AGENT_TURNS = 12
EXPECTED_CAMPAIGN_SCENARIOS = len(EXPECTED_BASE_SCENARIO_IDS) * (
    1 + len(EDGE_VARIANTS)
)


_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "exec": {
        "description": (
            "Run a command against the fixture-backed shell. Supported read commands "
            "include `himalaya envelope list`, `himalaya message read <id>`, "
            "`curl https://api.notion.so/v1/databases/tasks/query`, and "
            "`curl https://www.googleapis.com/calendar/v3/calendars/primary/events`."
        ),
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    "slack": {
        "description": (
            "Read or modify fixture-backed Slack data. Use action `readMessages`; "
            "omit channelId to read every work channel or provide one to filter."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string"},
                "channelId": {"type": "string"},
                "to": {"type": "string"},
                "content": {"type": "string"},
                "messageId": {"type": "string"},
                "emoji": {"type": "string"},
                "remove": {"type": "boolean"},
                "userId": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    "memory_search": {
        "description": "Search the scenario's deterministic memory files.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "maxResults": {"type": "integer", "minimum": 1},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    "memory_get": {
        "description": "Read an exact range from a scenario memory file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "from": {"type": "integer", "minimum": 1},
                "lines": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    "web_search": {
        "description": "Search deterministic scenario web fixtures.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "count": {"type": "integer", "minimum": 1},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    "web_fetch": {
        "description": "Fetch a page from deterministic scenario web fixtures.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "extractMode": {"type": "string"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    "read": {
        "description": "Read an exact range from a scenario workspace file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "from": {"type": "integer", "minimum": 1},
                "lines": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
}


# ---------------------------------------------------------------------------
# Scenario + fixture loading
# ---------------------------------------------------------------------------


def load_fixtures(scenario_name: str) -> dict[str, Any]:
    """Load the fixture bundle for a scenario from ``fixtures/{scenario}/``."""
    fixtures_dir = FIXTURES_DIR / base_scenario_name(scenario_name)
    if not fixtures_dir.is_dir():
        raise FileNotFoundError(
            f"ClawBench fixture directory does not exist: {fixtures_dir}"
        )
    out: dict[str, Any] = {}
    for fixture_path in sorted(fixtures_dir.glob("*.json")):
        key = "tasks" if fixture_path.stem == "tasks_fixture" else fixture_path.stem
        if key in out:
            raise ValueError(
                f"ClawBench fixture key {key!r} is defined more than once in "
                f"{fixtures_dir}"
            )
        try:
            with fixture_path.open("r", encoding="utf-8") as handle:
                out[key] = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"ClawBench fixture is unreadable or invalid: {fixture_path}: {exc}"
            ) from exc

    memory_dir = fixtures_dir / "memory"
    if memory_dir.is_dir():
        memory: dict[str, Any] = {}
        for memory_path in sorted(
            path for path in memory_dir.iterdir() if path.is_file()
        ):
            try:
                if memory_path.suffix.lower() == ".json":
                    with memory_path.open("r", encoding="utf-8") as handle:
                        memory[memory_path.stem] = json.load(handle)
                else:
                    memory[memory_path.stem] = memory_path.read_text(encoding="utf-8")
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError(
                    f"ClawBench memory fixture is unreadable or invalid: "
                    f"{memory_path}: {exc}"
                ) from exc
        if memory:
            out["memory"] = memory
    if not out:
        raise ValueError(f"ClawBench fixture bundle is empty: {fixtures_dir}")
    return out


def tool_schemas(tool_names: object) -> list[dict[str, Any]]:
    """Resolve scenario tool names to complete OpenAI function schemas."""
    if not isinstance(tool_names, list) or not tool_names:
        raise ValueError("ClawBench scenario must declare a non-empty tools list")
    schemas: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_name in tool_names:
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ValueError(f"Invalid ClawBench tool name: {raw_name!r}")
        name = raw_name.strip()
        if name in seen:
            raise ValueError(f"Duplicate ClawBench tool name: {name}")
        definition = _TOOL_SCHEMAS.get(name)
        if definition is None:
            raise ValueError(f"Unknown ClawBench tool name: {name}")
        seen.add(name)
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": definition["description"],
                    "parameters": definition["parameters"],
                },
            }
        )
    return schemas


def _attached_fixtures(scenario_name: str, fixtures: dict[str, Any]) -> dict[str, Any]:
    """Attach only data the scenario prompt explicitly declares preloaded."""
    if base_scenario_name(scenario_name) != "inbox_triage":
        return {}
    inbox = fixtures.get("inbox")
    if not isinstance(inbox, list):
        raise ValueError("Inbox Triage requires an attached inbox fixture")
    return {"inbox": inbox}


# ---------------------------------------------------------------------------
# Harness wiring
# ---------------------------------------------------------------------------


def _build_agent_fn_hermes(
    *,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> Any:
    _prepend_adapter_package("hermes")
    from hermes_adapter.client import HermesClient
    from hermes_adapter.clawbench import build_clawbench_agent_fn

    client = HermesClient(
        provider=os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras",
        model=model_name,
    )
    return build_clawbench_agent_fn(
        client=client,
        scenario_yaml=scenario_yaml,
        fixtures=fixtures,
        model_name=model_name,
    )


def _build_agent_fn_openclaw(
    *,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> Any:
    _prepend_adapter_package("openclaw")
    from openclaw_adapter.client import OpenClawClient
    from openclaw_adapter.clawbench import build_clawbench_agent_fn

    provider = (
        (
            os.environ.get("BENCHMARK_MODEL_PROVIDER")
            or os.environ.get("ELIZA_PROVIDER")
            or "cerebras"
        )
        .strip()
        .lower()
    )
    client = OpenClawClient(
        provider=provider,
        model=model_name,
    )
    return build_clawbench_agent_fn(
        client=client,
        scenario_yaml=scenario_yaml,
        fixtures=fixtures,
        model_name=model_name,
    )


def _build_agent_fn_smithers(
    *,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> Any:
    _prepend_adapter_package("smithers")
    from smithers_adapter.client import SmithersClient
    from smithers_adapter.clawbench import build_clawbench_agent_fn

    client = SmithersClient(provider="cerebras", model=model_name)
    return build_clawbench_agent_fn(
        client=client,
        scenario_yaml=scenario_yaml,
        fixtures=fixtures,
        model_name=model_name,
    )


def _build_agent_fn_eliza(
    *,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> Any:
    _prepend_adapter_package("eliza")
    from eliza_adapter.clawbench import build_clawbench_agent_fn

    return build_clawbench_agent_fn(
        scenario_yaml=scenario_yaml,
        fixtures=fixtures,
        model_name=model_name,
    )


_HARNESS_BUILDERS = {
    "eliza": _build_agent_fn_eliza,
    "hermes": _build_agent_fn_hermes,
    "openclaw": _build_agent_fn_openclaw,
    "smithers": _build_agent_fn_smithers,
}


def _prepend_adapter_package(harness_name: str) -> None:
    """Prefer harness adapter packages over modules in the ClawBench cwd.

    Registry runs execute this module with ``cwd=suites/clawbench``. That
    directory also contains a legacy ``eliza_adapter.py`` script, which can
    shadow the real ``harnesses/eliza/eliza_adapter`` package unless the
    package directory is placed before the cwd on ``sys.path``.
    """
    adapter_path = CLAWBENCH_DIR.parent.parent / "harnesses" / harness_name
    if not adapter_path.exists():
        return
    adapter_str = str(adapter_path)
    sys.path[:] = [entry for entry in sys.path if entry != adapter_str]
    sys.path.insert(0, adapter_str)
    if harness_name == "eliza":
        loaded = sys.modules.get("eliza_adapter")
        loaded_file = getattr(loaded, "__file__", None)
        if loaded_file:
            try:
                if (
                    Path(loaded_file).resolve()
                    == (CLAWBENCH_DIR / "eliza_adapter.py").resolve()
                ):
                    del sys.modules["eliza_adapter"]
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Run + score
# ---------------------------------------------------------------------------


def _normalize_tool_calls(
    raw_tool_calls: object,
    *,
    allowed_tools: set[str],
    turn: int,
) -> list[dict[str, Any]]:
    if raw_tool_calls is None:
        return []
    if not isinstance(raw_tool_calls, list):
        raise ValueError(
            f"ClawBench turn {turn} returned non-list tool_calls: "
            f"{type(raw_tool_calls).__name__}"
        )

    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_tool_calls):
        if not isinstance(entry, dict):
            raise ValueError(
                f"ClawBench turn {turn} tool call {index} is not an object"
            )
        function = entry.get("function")
        if function is not None and not isinstance(function, dict):
            raise ValueError(
                f"ClawBench turn {turn} tool call {index} has an invalid function"
            )
        name = entry.get("name") or entry.get("tool")
        if isinstance(function, dict):
            name = name or function.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(
                f"ClawBench turn {turn} tool call {index} has no tool name"
            )
        name = name.strip()
        if name not in allowed_tools:
            raise ValueError(
                f"ClawBench turn {turn} requested undeclared tool {name!r}"
            )

        if "arguments" in entry:
            args: object = entry["arguments"]
        elif "args" in entry:
            args = entry["args"]
        elif isinstance(function, dict):
            args = function.get("arguments", {})
        else:
            args = {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"ClawBench turn {turn} tool call {index} has invalid JSON arguments"
                ) from exc
        if not isinstance(args, dict):
            raise ValueError(
                f"ClawBench turn {turn} tool call {index} arguments are not an object"
            )
        normalized.append(
            {
                "id": str(entry.get("id") or f"turn-{turn}-call-{index}"),
                "tool": name,
                "args": args,
            }
        )
    return normalized


async def _execute_tool_call(tool_call: dict[str, Any], *, scenario_name: str) -> Any:
    from clawbench.mock_tools import server as mock_tools

    mock_tools.FIXTURES_PATH = FIXTURES_DIR
    handler = mock_tools.TOOL_HANDLERS.get(tool_call["tool"])
    if handler is None:
        raise ValueError(f"No deterministic handler for tool {tool_call['tool']!r}")
    result = handler(tool_call["args"], base_scenario_name(scenario_name))
    if inspect.isawaitable(result):
        result = await result
    if result is None:
        raise RuntimeError(f"ClawBench tool {tool_call['tool']!r} returned no result")
    return result


def _contains_irreversible_marker(value: object) -> bool:
    if isinstance(value, dict):
        if value.get("_irreversible") is True:
            return True
        return any(_contains_irreversible_marker(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_irreversible_marker(item) for item in value)
    return isinstance(value, str) and "IRREVERSIBLE" in value.upper()


def _continuation_message(tool_calls: list[dict[str, Any]]) -> str:
    trace = [
        {
            "tool": tool_call["tool"],
            "args": tool_call["args"],
            "result": tool_call["result"],
        }
        for tool_call in tool_calls
    ]
    return (
        "The deterministic benchmark tools have executed every tool request so far. "
        "Here is the complete execution trace:\n"
        f"{json.dumps(trace, ensure_ascii=True, default=str)}\n\n"
        "Continue the task. Call another tool only if necessary; otherwise provide the "
        "final answer."
    )


def _add_usage(total: dict[str, int], raw_usage: object) -> None:
    if not isinstance(raw_usage, dict):
        return
    for key, value in raw_usage.items():
        if (
            isinstance(key, str)
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
        ):
            total[key] = total.get(key, 0) + int(value)


def _workload_sha256(
    scenario: dict[str, Any], fixtures: dict[str, Any]
) -> str:
    payload = {
        "schema_version": 1,
        "scenario": scenario,
        "fixtures": fixtures,
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


async def run_scenario(
    *,
    harness: str,
    scenario: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> dict[str, Any]:
    """Run a scenario to a terminal answer and score its executed trajectory."""
    builder = _HARNESS_BUILDERS.get(harness)
    if builder is None:
        raise ValueError(
            f"Unknown harness {harness!r}. Choose one of {list(_HARNESS_BUILDERS)}"
        )
    scenario_name = str(scenario.get("name") or "(unnamed)")
    agent_fn = builder(
        scenario_yaml=scenario,
        fixtures=_attached_fixtures(scenario_name, fixtures),
        model_name=model_name,
    )

    prompt = scenario.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("ClawBench scenario has no non-empty prompt")
    history = [{"role": "user", "content": prompt}]
    tools = tool_schemas(scenario.get("tools"))
    allowed_tools = {str(schema["function"]["name"]) for schema in tools}
    all_tool_calls: list[dict[str, Any]] = []
    responses: list[str] = []
    thoughts: list[str] = []
    usage: dict[str, int] = {}
    total_cost = 0.0
    cost_complete = True
    reported_model = model_name
    completed_turns = 0

    started = time.monotonic()
    for turn in range(1, MAX_AGENT_TURNS + 1):
        completed_turns = turn
        raw_result = await agent_fn(history, tools)
        if not isinstance(raw_result, dict):
            raise TypeError(
                f"ClawBench {harness} turn {turn} returned a non-object result"
            )
        text = raw_result.get("text")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise TypeError(f"ClawBench {harness} turn {turn} returned non-string text")
        if text:
            responses.append(text)
        thought = raw_result.get("thought")
        if isinstance(thought, str) and thought:
            thoughts.append(thought)
        _add_usage(usage, raw_result.get("usage"))
        cost = raw_result.get("cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            total_cost += float(cost)
        else:
            cost_complete = False
        candidate_model = raw_result.get("model_name")
        if isinstance(candidate_model, str) and candidate_model:
            reported_model = candidate_model

        turn_calls = _normalize_tool_calls(
            raw_result.get("tool_calls"),
            allowed_tools=allowed_tools,
            turn=turn,
        )
        if not turn_calls:
            if not text.strip():
                raise RuntimeError(
                    f"ClawBench {harness} ended turn {turn} without a tool call or answer"
                )
            break

        for tool_call in turn_calls:
            tool_call["result"] = await _execute_tool_call(
                tool_call,
                scenario_name=scenario_name,
            )
            all_tool_calls.append(tool_call)
        history.append(
            {
                "role": "user",
                "content": _continuation_message(all_tool_calls),
            }
        )
    else:
        raise RuntimeError(
            f"ClawBench {harness} exceeded {MAX_AGENT_TURNS} turns without a final answer"
        )

    latency_ms = int((time.monotonic() - started) * 1000)
    response = "\n\n".join(responses)
    tool_counts = dict(Counter(tc["tool"] for tc in all_tool_calls))
    irreversible_actions = [
        tool_call
        for tool_call in all_tool_calls
        if _contains_irreversible_marker(tool_call.get("result"))
    ]

    scorable: dict[str, Any] = {
        "response": response,
        "tool_calls_raw": all_tool_calls,
        "tool_calls_by_type": tool_counts,
        "tool_calls_total": len(all_tool_calls),
        "irreversible_actions": irreversible_actions,
        "has_irreversible": bool(irreversible_actions),
    }

    scoring_config = scenario.get("scoring") or {}
    if not isinstance(scoring_config, dict) or not scoring_config.get("checks"):
        raise ValueError(f"ClawBench scenario {scenario_name!r} has no scoring checks")
    score = score_episode(scorable, scoring_config)
    score_value = score.get("score") if isinstance(score, dict) else None
    if (
        not isinstance(score_value, (int, float))
        or isinstance(score_value, bool)
        or not math.isfinite(float(score_value))
        or not 0 <= float(score_value) <= 1
    ):
        raise ValueError(
            f"ClawBench scorer returned invalid score for {scenario_name!r}: "
            f"{score_value!r}"
        )

    return {
        "benchmark": "clawbench",
        "harness": harness,
        "scenario": scenario_name,
        "scenario_id": scenario_name,
        "base_scenario_id": base_scenario_name(scenario_name),
        "scenario_provenance": {
            "expected_base_count": len(EXPECTED_BASE_SCENARIO_IDS),
            "expected_edge_variants_per_base": len(EDGE_VARIANTS),
            "expected_campaign_scenarios": EXPECTED_CAMPAIGN_SCENARIOS,
            "workload_sha256": _workload_sha256(scenario, fixtures),
        },
        "model_name": reported_model,
        "response": response,
        "thought": "\n\n".join(thoughts) if thoughts else None,
        "tool_calls": all_tool_calls,
        "tool_calls_by_type": tool_counts,
        "tool_calls_total": len(all_tool_calls),
        "irreversible_actions": irreversible_actions,
        "has_irreversible": bool(irreversible_actions),
        "usage": usage,
        "cost_usd": total_cost if cost_complete else None,
        "latency_ms": latency_ms,
        "turns": completed_turns,
        "complete": True,
        "score": score,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _print_summary(result: dict[str, Any]) -> None:
    score = result.get("score") or {}
    print()
    print(f"Harness: {result['harness']}")
    print(f"Scenario: {result['scenario']}")
    print(f"Model: {result.get('model_name', '?')}")
    print(f"Latency: {result['latency_ms']} ms")
    usage = result.get("usage") or {}
    print(
        f"Tokens: prompt={usage.get('prompt_tokens', 0)} "
        f"completion={usage.get('completion_tokens', 0)}"
    )
    cost = result.get("cost_usd")
    if cost is not None:
        print(f"Cost: ${cost:.6f} USD")
    else:
        print("Cost: (unpriced)")
    print(f"Tool calls: {result['tool_calls_total']} {result['tool_calls_by_type']}")

    if score and score.get("score") is not None:
        pct = score["score"] * 100
        print(
            f"\nScore: {pct:.0f}% "
            f"({score['points_earned']}/{score['points_possible']} pts, "
            f"{score['passed']}/{score['total_checks']} checks)"
        )
        print(format_score_summary(score))
    else:
        print("\n(no scoring rubric)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Multi-harness ClawBench runner (eliza|hermes|openclaw on Cerebras)"
    )
    parser.add_argument(
        "--harness",
        choices=sorted(_HARNESS_BUILDERS),
        required=False,
        help="Which harness to drive",
    )
    parser.add_argument(
        "--scenario",
        required=False,
        help="Scenario name (e.g. 'inbox_triage') or path to a YAML file",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("CLAWBENCH_MODEL", "gemma-4-31b"),
        help="Model name used for cost attribution (default: gemma-4-31b)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path to write the full result JSON",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full result JSON to stdout instead of the summary",
    )
    parser.add_argument(
        "--count-scenarios",
        action="store_true",
        help="Print scenario expansion counts and exit",
    )
    parser.add_argument(
        "--validate-scenarios",
        action="store_true",
        help="Validate expanded scenario structure and exit",
    )
    args = parser.parse_args(argv)

    if args.count_scenarios:
        print(json.dumps(count_scenarios(), indent=2))
        return 0
    if args.validate_scenarios:
        validation = validate_scenarios()
        print(json.dumps(validation, indent=2))
        return 0 if validation["valid"] else 1
    if not args.harness or not args.scenario:
        parser.error(
            "--harness and --scenario are required unless using count/validate flags"
        )

    try:
        scenario = load_scenario(args.scenario)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    fixtures = load_fixtures(
        scenario.get("_base_name") or scenario.get("name") or args.scenario
    )

    try:
        result = asyncio.run(
            run_scenario(
                harness=args.harness,
                scenario=scenario,
                fixtures=fixtures,
                model_name=args.model,
            )
        )
    except Exception as exc:  # noqa: BLE001 — surface any harness failure
        import traceback

        traceback.print_exc()
        print(
            f"[multi-harness] {args.harness} run failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        _print_summary(result)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
