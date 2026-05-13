"""CLI entry point for VoiceBench-quality.

Examples::

    python -m elizaos_voicebench --suite openbookqa --limit 2 --mock
    python -m elizaos_voicebench --agent eliza --suite all --limit 20 \\
        --output ./results
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import asdict
from pathlib import Path

from .adapters import build_adapter
from .clients.judge import build_judge
from .runner import resolve_suites, run
from .types import SUITES


_AGENT_CHOICES = ("eliza", "hermes", "openclaw", "echo")
_SUITE_CHOICES = ("all",) + SUITES
_STT_CHOICES = ("groq",)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="elizaos-voicebench",
        description="VoiceBench (Chen et al. 2024) quality benchmark.",
    )
    parser.add_argument(
        "--agent",
        choices=_AGENT_CHOICES,
        default="echo",
        help="Backend agent under test (default: echo, used by smoke tests).",
    )
    parser.add_argument(
        "--suite",
        choices=_SUITE_CHOICES,
        default="all",
        help="Suite to run; 'all' runs the canonical 8.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap on samples per suite. Default: full suite from HF.",
    )
    parser.add_argument(
        "--stt-provider",
        choices=_STT_CHOICES,
        default="groq",
        help="STT provider for cascaded voice→text input (default: groq).",
    )
    parser.add_argument(
        "--judge-model",
        default=None,
        help=(
            "Cerebras model used as the open-ended judge "
            "(default: $CEREBRAS_MODEL or gpt-oss-120b)."
        ),
    )
    parser.add_argument(
        "--output",
        default="./voicebench-quality-out",
        help="Output directory for the results JSON.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help=(
            "Run with bundled fixtures + stub judge (no HF download, "
            "no Cerebras call). Implies --agent=echo if no agent is set."
        ),
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR).",
    )
    return parser


async def _run_async(args: argparse.Namespace) -> int:
    suites = resolve_suites(args.suite)
    adapter = build_adapter(
        agent=args.agent,
        stt_provider=args.stt_provider if not args.mock else None,
        mock=args.mock,
    )
    judge = build_judge(mock=args.mock, model=args.judge_model)

    output_dir = Path(args.output).resolve()
    result = await run(
        adapter=adapter,
        judge=judge,
        suites=suites,
        limit=args.limit,
        mock=args.mock,
        output_dir=output_dir,
        agent_name=args.agent,
        stt_provider=args.stt_provider,
    )
    summary = {
        "score": result.score,
        "per_suite": result.per_suite,
        "n": result.n,
        "elapsed_s": result.elapsed_s,
        "output": str(output_dir / "voicebench-quality-results.json"),
    }
    print(json.dumps(summary, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    return asyncio.run(_run_async(args))


if __name__ == "__main__":
    sys.exit(main())
