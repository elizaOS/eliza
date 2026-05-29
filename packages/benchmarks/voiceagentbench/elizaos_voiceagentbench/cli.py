"""CLI entry point for VoiceAgentBench.

Usage:

  python -m elizaos_voiceagentbench \\
      --agent {eliza,hermes,openclaw} \\
      --suite {single,parallel,sequential,multi-turn,safety,multilingual,all} \\
      --limit 50 --seeds 1 --output ./results [--no-judge]
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import re
import importlib.util
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .adapters import (
    build_eliza_agent,
    build_hermes_agent,
    build_openclaw_agent,
)
from .dataset import filter_suites, load_tasks
from .evaluator import CoherenceJudge
from .runner import run_tasks
from .scorer import compile_report
from .stt import build_stt
from .types import AgentFn, Suite, VoiceBenchmarkReport

logger = logging.getLogger("elizaos_voiceagentbench")


SUITE_CHOICES = [s.value for s in Suite] + ["all"]
AGENT_CHOICES = ["eliza", "hermes", "openclaw", "mock"]
STT_CHOICES = ["groq", "eliza-runtime", "eliza1", "faster-whisper", "local-whisper"]
_TOOL_ANNOTATION_RE = re.compile(r"\[tool:\s*([A-Za-z0-9_.-]+)\s+(\{.*?\})\]")


def _default_stt_provider() -> str:
    explicit = os.environ.get("VOICEAGENTBENCH_STT_PROVIDER", "").strip()
    if explicit:
        return explicit
    from .eliza1_asr import resolve_binary, resolve_model

    if resolve_binary().is_file() and resolve_model().is_file():
        return "eliza1"
    if os.environ.get("GROQ_API_KEY"):
        return "groq"
    if importlib.util.find_spec("faster_whisper") is not None:
        return "faster-whisper"
    return "groq"


async def _mock_agent(history: list[Any], _tools: list[dict[str, Any]]) -> Any:
    user_text = ""
    for turn in reversed(history):
        if getattr(turn, "role", "") == "user":
            user_text = getattr(turn, "content", "") or ""
            break
    if "[refuse]" in user_text:
        from .types import MessageTurn

        return MessageTurn(role="assistant", content="I can't help with that.")

    tool_calls: list[dict[str, Any]] = []
    for idx, match in enumerate(_TOOL_ANNOTATION_RE.finditer(user_text)):
        try:
            arguments = json.loads(match.group(2))
        except json.JSONDecodeError:
            arguments = {}
        tool_calls.append(
            {
                "id": f"mock_call_{idx}",
                "name": match.group(1),
                "arguments": arguments,
            }
        )
    from .types import MessageTurn

    return MessageTurn(role="assistant", content="done", tool_calls=tool_calls or None)


def _build_agent(name: str) -> AgentFn:
    if name == "mock":
        return _mock_agent
    if name == "eliza":
        return build_eliza_agent()
    if name == "hermes":
        return build_hermes_agent()
    if name == "openclaw":
        return build_openclaw_agent()
    raise ValueError(f"unknown agent {name!r}")


def _resolve_suites(value: str) -> list[Suite] | None:
    if value == "all":
        return None
    return [Suite(value)]


def _report_to_json(report: VoiceBenchmarkReport) -> dict[str, object]:
    payload = dataclasses.asdict(report)
    for task in payload["tasks"]:
        task["suite"] = (
            task["suite"].value
            if hasattr(task["suite"], "value")
            else task["suite"]
        )
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="elizaos_voiceagentbench")
    parser.add_argument("--agent", choices=AGENT_CHOICES, default="eliza")
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use the bundled fixture dataset and deterministic mock agent.",
    )
    parser.add_argument(
        "--suite",
        choices=SUITE_CHOICES,
        default="single",
        help="Which task suite to run.",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--seeds", type=int, default=1)
    parser.add_argument(
        "--output", "--output-dir", dest="output_dir", default="./results"
    )
    parser.add_argument(
        "--no-judge",
        action="store_true",
        help="Skip the LLM coherence judge (uses None for that axis).",
    )
    parser.add_argument(
        "--data-path",
        type=Path,
        default=None,
        help="Optional local JSONL of task records.",
    )
    parser.add_argument(
        "--judge-model",
        default="gpt-oss-120b",
        help="Cerebras coherence-judge model id.",
    )
    parser.add_argument(
        "--stt-provider",
        choices=STT_CHOICES,
        default=_default_stt_provider(),
        help="Real STT backend for non-mock runs.",
    )
    parser.add_argument(
        "--verbose", "-v", action="count", default=0
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING - 10 * min(args.verbose, 2),
        format="%(levelname)s [%(name)s] %(message)s",
    )

    suites = _resolve_suites(args.suite)
    suite_filter = suites[0] if suites and len(suites) == 1 else None
    effective_agent = "mock" if args.mock else args.agent
    data_path = args.data_path
    if args.mock and data_path is None:
        data_path = Path(__file__).resolve().parents[1] / "fixtures" / "mock_tasks.jsonl"
    tasks = load_tasks(
        data_path=data_path,
        suite_filter=suite_filter,
        limit=args.limit if args.limit > 0 else None,
    )
    if suites is not None:
        tasks = filter_suites(tasks, suites)

    if not tasks:
        logger.error("no tasks matched the requested filter")
        return 2

    agent = _build_agent(effective_agent)
    stt_provider = "fixture" if args.mock else args.stt_provider
    stt = build_stt(mock=args.mock, provider=args.stt_provider)
    judge: CoherenceJudge | None
    if args.no_judge:
        judge = None
        judge_model_name = "none"
    else:
        if not os.environ.get("CEREBRAS_API_KEY"):
            logger.warning(
                "CEREBRAS_API_KEY not set; coherence judging disabled"
            )
            judge = None
            judge_model_name = "none"
        else:
            judge = CoherenceJudge(model=args.judge_model)
            judge_model_name = args.judge_model

    results = asyncio.run(
        run_tasks(
            tasks,
            agent=agent,
            stt=stt,
            judge=judge,
            seeds=max(1, args.seeds),
        )
    )

    timestamp = datetime.now(timezone.utc).isoformat()
    report = compile_report(
        tasks=results,
        model_name=effective_agent,
        judge_model_name=judge_model_name,
        timestamp=timestamp,
        seeds=max(1, args.seeds),
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = timestamp.replace(":", "-")
    out_path = output_dir / f"voiceagentbench_{effective_agent}_{args.suite}_{stamp}.json"
    payload = _report_to_json(report)
    payload["stt_provider"] = stt_provider
    out_path.write_text(json.dumps(payload, indent=2, default=str))

    summary = {
        "pass_at_1": report.pass_at_1,
        "pass_at_k": report.pass_at_k,
        "per_suite_pass_at_1": report.per_suite_pass_at_1,
        "mean_tool_selection": report.mean_tool_selection,
        "mean_parameter_match": report.mean_parameter_match,
        "mean_coherence": report.mean_coherence,
        "mean_safety": report.mean_safety,
        "tasks_run": len(report.tasks),
        "stt_provider": stt_provider,
        "output_file": str(out_path),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
