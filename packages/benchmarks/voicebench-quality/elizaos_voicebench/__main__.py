"""CLI entry point for VoiceBench-quality.

Examples::

    python -m elizaos_voicebench --suite openbookqa --limit 2
    python -m elizaos_voicebench --agent eliza --suite all --limit 20 \\
        --output ./results
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path

from .adapters import build_adapter
from .clients.judge import build_judge
from .dataset import count_samples, load_samples, validate_samples
from .runner import resolve_suites, run
from .types import SUITES


_AGENT_CHOICES = ("eliza", "hermes", "openclaw", "echo")
_SUITE_CHOICES = ("all",) + SUITES
_STT_CHOICES = ("groq", "eliza-runtime", "eliza1", "faster-whisper", "local-whisper")


def _default_stt_provider() -> str:
    explicit = (
        os.environ.get("VOICEBENCH_QUALITY_STT_PROVIDER")
        or os.environ.get("VOICEBENCH_STT_PROVIDER")
        or ""
    ).strip()
    if explicit:
        return explicit
    from .clients.eliza1_asr import resolve_binary, resolve_model

    if resolve_binary().is_file() and resolve_model().is_file():
        return "eliza1"
    if os.environ.get("GROQ_API_KEY"):
        return "groq"
    if importlib.util.find_spec("faster_whisper") is not None:
        return "faster-whisper"
    return "groq"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="elizaos-voicebench",
        description="VoiceBench (Chen et al. 2024) quality benchmark.",
    )
    parser.add_argument(
        "--agent",
        choices=_AGENT_CHOICES,
        default="eliza",
        help="Backend agent under test (default: eliza).",
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
        default=_default_stt_provider(),
        help="STT provider for cascaded voice→text input.",
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
        help="Use bundled fixtures with a deterministic no-cost adapter and judge.",
    )
    parser.add_argument(
        "--fixtures",
        action="store_true",
        help="Alias for --mock.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR).",
    )
    parser.add_argument(
        "--expand-scenarios",
        action="store_true",
        help="Run each selected sample plus ten realistic voice edge variants.",
    )
    parser.add_argument(
        "--count-scenarios",
        action="store_true",
        help="Print base/edge/total sample counts before running.",
    )
    parser.add_argument(
        "--validate-scenarios",
        action="store_true",
        help="Validate sample ids and expanded scenario metadata before running.",
    )
    return parser


async def _run_async(args: argparse.Namespace) -> int:
    suites = resolve_suites(args.suite)
    if args.count_scenarios or args.validate_scenarios:
        aggregate = {"base": 0, "edge": 0, "edge_multiplier": 10, "total": 0}
        for suite in suites:
            samples = load_samples(
                suite,
                limit=args.limit,
                mock=args.mock or args.fixtures,
                include_edge_scenarios=False,
            )
            if args.validate_scenarios:
                validate_samples(samples, include_edge_scenarios=args.expand_scenarios)
            counts = count_samples(samples, args.expand_scenarios)
            aggregate["base"] += counts["base"]
            aggregate["edge"] += counts["edge"]
            aggregate["total"] += counts["total"]
        print(json.dumps(aggregate))

    adapter = build_adapter(
        agent=args.agent,
        stt_provider=args.stt_provider,
        mock=args.mock or args.fixtures,
    )
    judge = build_judge(model=args.judge_model, mock=args.mock or args.fixtures)

    output_dir = Path(args.output).resolve()
    result = await run(
        adapter=adapter,
        judge=judge,
        suites=suites,
        limit=args.limit,
        output_dir=output_dir,
        agent_name=args.agent,
        stt_provider=args.stt_provider,
        mock=args.mock or args.fixtures,
        include_edge_scenarios=args.expand_scenarios,
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
