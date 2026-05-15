"""Multi-harness ClawBench runner.

Runs a single ClawBench scenario through one of three harnesses (eliza,
hermes, openclaw) against an OpenAI-compatible Cerebras endpoint, then
scores the result with the deterministic rubric in
:mod:`clawbench.scoring`.

ClawBench is one-shot per scenario (single user turn), so the runner does
not need to thread multi-turn conversation history — it builds a single
``[{"role": "user", "content": scenario.prompt}]`` history, calls the
harness's ``agent_fn``, then maps the returned ``text`` / ``tool_calls``
into the structure :func:`clawbench.scoring.score_episode` expects.

CLI::

    python -m clawbench.multi_harness_runner \
        --harness eliza|hermes|openclaw \
        --scenario inbox_triage \
        --model gpt-oss-120b

Each harness is responsible for routing the call to the Cerebras OpenAI-
compatible surface; this module owns no transport.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

# Ensure the local clawbench package is importable when the script is run
# directly (``python multi_harness_runner.py``) without an editable install.
_REPO_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_PKG_ROOT) not in sys.path:
    # Append rather than prepend: this directory also contains the legacy
    # ``eliza_adapter.py`` CLI script, which would shadow the shared
    # ``eliza_adapter`` package used by the multi-harness path.
    sys.path.append(str(_REPO_PKG_ROOT))

from clawbench.scoring import format_score_summary, score_episode  # noqa: E402

CLAWBENCH_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = CLAWBENCH_DIR / "scenarios"
FIXTURES_DIR = CLAWBENCH_DIR / "fixtures"


# ---------------------------------------------------------------------------
# Scenario + fixture loading
# ---------------------------------------------------------------------------

def load_scenario(name_or_path: str) -> dict[str, Any]:
    """Load a scenario YAML by name or filesystem path."""
    path = Path(name_or_path)
    if not path.exists():
        candidate = SCENARIOS_DIR / f"{name_or_path}.yaml"
        if candidate.exists():
            path = candidate
        else:
            candidate = SCENARIOS_DIR / f"{name_or_path}.yml"
            if candidate.exists():
                path = candidate
    if not path.exists():
        available = sorted(p.stem for p in SCENARIOS_DIR.glob("*.y*ml"))
        raise FileNotFoundError(
            f"Scenario '{name_or_path}' not found. "
            f"Available: {available}"
        )
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Scenario YAML at {path} did not parse to a dict")
    return data


def load_fixtures(scenario_name: str) -> dict[str, Any]:
    """Load the fixture bundle for a scenario from ``fixtures/{scenario}/``."""
    fixtures_dir = FIXTURES_DIR / scenario_name
    if not fixtures_dir.exists():
        return {}
    out: dict[str, Any] = {}
    for fname in ("inbox.json", "calendar.json", "contacts.json",
                  "tasks.json", "slack_messages.json"):
        fp = fixtures_dir / fname
        if not fp.exists() and fname == "tasks.json":
            fp = fixtures_dir / "tasks_fixture.json"
        if fp.exists():
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    out[fname.replace(".json", "")] = json.load(f)
            except (OSError, ValueError) as exc:
                # Don't fail the whole run on a malformed fixture — just
                # skip it; the scenario may not actually need it.
                print(
                    f"[multi-harness] skipping {fp}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
    memory_dir = fixtures_dir / "memory"
    if memory_dir.exists():
        memory: dict[str, str] = {}
        for f in memory_dir.glob("*.md"):
            try:
                memory[f.stem] = f.read_text(encoding="utf-8")
            except OSError:
                continue
        if memory:
            out["memory"] = memory
    return out


# ---------------------------------------------------------------------------
# Harness wiring
# ---------------------------------------------------------------------------

def _build_agent_fn_hermes(
    *,
    scenario_yaml: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> Any:
    _prepend_adapter_package("hermes-adapter")
    from hermes_adapter.client import HermesClient
    from hermes_adapter.clawbench import build_clawbench_agent_fn

    # HERMES_ADAPTER_MODE=in_process avoids the venv requirement; lets the
    # parent Python drive Cerebras directly via the openai SDK.
    mode = os.environ.get("HERMES_ADAPTER_MODE", "in_process").strip() or "in_process"
    client = HermesClient(
        provider="cerebras",
        model=model_name,
        mode=mode,
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
    _prepend_adapter_package("openclaw-adapter")
    from openclaw_adapter.client import OpenClawClient
    from openclaw_adapter.clawbench import build_clawbench_agent_fn

    # OPENCLAW_DIRECT_OPENAI_COMPAT=1 tells the client to bypass the OpenClaw
    # CLI subprocess path and call the OpenAI-compatible endpoint directly.
    direct = (
        os.environ.get("OPENCLAW_DIRECT_OPENAI_COMPAT", "").strip() == "1"
    )
    client = OpenClawClient(
        provider="cerebras",
        model=model_name,
        direct_openai_compatible=direct,
    )
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
    _prepend_adapter_package("eliza-adapter")
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
}


def _prepend_adapter_package(adapter_dir_name: str) -> None:
    """Prefer sibling adapter packages over modules in the ClawBench cwd.

    Registry runs execute this module with ``cwd=benchmarks/clawbench``. That
    directory also contains a legacy ``eliza_adapter.py`` script, which can
    shadow the real ``benchmarks/eliza-adapter/eliza_adapter`` package unless
    the package directory is placed before the cwd on ``sys.path``.
    """
    adapter_path = CLAWBENCH_DIR.parent / adapter_dir_name
    if not adapter_path.exists():
        return
    adapter_str = str(adapter_path)
    sys.path[:] = [entry for entry in sys.path if entry != adapter_str]
    sys.path.insert(0, adapter_str)
    if adapter_dir_name == "eliza-adapter":
        loaded = sys.modules.get("eliza_adapter")
        loaded_file = getattr(loaded, "__file__", None)
        if loaded_file:
            try:
                if Path(loaded_file).resolve() == (CLAWBENCH_DIR / "eliza_adapter.py").resolve():
                    del sys.modules["eliza_adapter"]
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Run + score
# ---------------------------------------------------------------------------

async def run_scenario(
    *,
    harness: str,
    scenario: dict[str, Any],
    fixtures: dict[str, Any],
    model_name: str,
) -> dict[str, Any]:
    """Build the agent_fn for *harness*, run one turn, return result + score."""
    builder = _HARNESS_BUILDERS.get(harness)
    if builder is None:
        raise ValueError(
            f"Unknown harness {harness!r}. Choose one of {list(_HARNESS_BUILDERS)}"
        )
    agent_fn = builder(
        scenario_yaml=scenario,
        fixtures=fixtures,
        model_name=model_name,
    )

    prompt = scenario.get("prompt") or "Help me with my tasks."
    history = [{"role": "user", "content": prompt}]
    tools = scenario.get("tools") or []
    # The harness factories already inline scenario_prompt + fixtures into
    # the composed message, so we only put the bare user prompt in history.
    # (See `_last_user_text` in each factory.)
    started = time.monotonic()
    raw_result = await agent_fn(history, tools)
    latency_ms = int((time.monotonic() - started) * 1000)

    text = str(raw_result.get("text") or "")
    tool_calls_raw = raw_result.get("tool_calls") or []
    # Normalize tool calls into the {tool, args} shape that scoring.py reads.
    normalized: list[dict[str, Any]] = []
    if isinstance(tool_calls_raw, list):
        for entry in tool_calls_raw:
            if not isinstance(entry, dict):
                continue
            name = (
                entry.get("name")
                or entry.get("tool")
                or (
                    entry.get("function", {}).get("name")
                    if isinstance(entry.get("function"), dict)
                    else None
                )
            )
            if not isinstance(name, str) or not name.strip():
                continue
            args = (
                entry.get("arguments")
                if "arguments" in entry
                else entry.get("args", {})
            )
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (TypeError, ValueError):
                    pass
            if not isinstance(args, dict):
                args = {"_raw": args}
            normalized.append({"tool": name.strip(), "args": args})

    tool_counts = dict(Counter(tc["tool"] for tc in normalized))

    scorable: dict[str, Any] = {
        "response": text,
        "tool_calls_raw": normalized,
        "tool_calls_by_type": tool_counts,
        "tool_calls_total": len(normalized),
    }

    scoring_config = scenario.get("scoring") or {}
    score: dict[str, Any] | None = None
    if scoring_config:
        score = score_episode(scorable, scoring_config)

    return {
        "harness": harness,
        "scenario": scenario.get("name") or "(unnamed)",
        "model_name": raw_result.get("model_name") or model_name,
        "response": text,
        "thought": raw_result.get("thought"),
        "tool_calls": normalized,
        "tool_calls_by_type": tool_counts,
        "tool_calls_total": len(normalized),
        "usage": raw_result.get("usage") or {},
        "cost_usd": raw_result.get("cost_usd"),
        "latency_ms": latency_ms,
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
        required=True,
        help="Which harness to drive",
    )
    parser.add_argument(
        "--scenario",
        required=True,
        help="Scenario name (e.g. 'inbox_triage') or path to a YAML file",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("CLAWBENCH_MODEL", "gpt-oss-120b"),
        help="Model name used for cost attribution (default: gpt-oss-120b)",
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
    args = parser.parse_args(argv)

    try:
        scenario = load_scenario(args.scenario)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    fixtures = load_fixtures(scenario.get("name") or args.scenario)

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
