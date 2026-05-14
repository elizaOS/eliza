"""CLI for the MMAU benchmark.

Invocation::

    python -m elizaos_mmau --agent {mock,eliza,hermes,openclaw} \
        --split test --limit 100 --output ./results
    python -m elizaos_mmau --mock --limit 2     # smoke run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from benchmarks.mmau.runner import MMAURunner
from benchmarks.mmau.types import (
    MMAU_CATEGORIES,
    MMAUCategory,
    MMAUConfig,
    MMAUSplit,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="elizaos_mmau",
        description="MMAU (Massive Multi-task Audio Understanding) benchmark for elizaOS",
    )
    parser.add_argument(
        "--agent",
        type=str,
        default=None,
        choices=["mock", "eliza", "hermes", "openclaw"],
        help="Which adapter to dispatch to. Default: mock when --mock is set, else eliza.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Run against the offline oracle agent and the bundled fixture.",
    )
    parser.add_argument(
        "--split",
        type=str,
        choices=[s.value for s in MMAUSplit],
        default=MMAUSplit.TEST_MINI.value,
        help="MMAU split. test-mini=1k, test=9k. Default: test-mini.",
    )
    parser.add_argument(
        "--category",
        type=str,
        default="all",
        help="Comma-separated subset of {speech,sound,music,all}.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Max samples to run.")
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory. Defaults to ./benchmark_results/mmau/<timestamp>.",
    )
    parser.add_argument(
        "--hf",
        action="store_true",
        help="Stream from Hugging Face instead of the bundled fixture.",
    )
    parser.add_argument(
        "--hf-repo",
        type=str,
        default=None,
        help="HF repo override. Default: gamma-lab-umd/MMAU-test-mini or -test.",
    )
    parser.add_argument(
        "--fixture-path",
        type=str,
        default=None,
        help="Override the bundled fixture path.",
    )
    parser.add_argument("--provider", type=str, default=None)
    parser.add_argument("--model", type=str, default=None)
    parser.add_argument(
        "--stt-model",
        type=str,
        default="whisper-large-v3-turbo",
        help="STT model id used by the cascaded baseline.",
    )
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--timeout", type=int, default=60000, help="Per-sample timeout (ms).")
    parser.add_argument("--no-traces", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print aggregate JSON to stdout.")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def parse_categories(raw: str) -> tuple[MMAUCategory, ...]:
    raw = (raw or "").strip().lower()
    if not raw or raw == "all":
        return MMAU_CATEGORIES
    values: list[MMAUCategory] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            values.append(MMAUCategory(part))
        except ValueError as exc:
            allowed = ", ".join(c.value for c in MMAU_CATEGORIES)
            raise argparse.ArgumentTypeError(
                f"Unknown MMAU category {part!r}; expected one of {allowed} or 'all'"
            ) from exc
    return tuple(values) or MMAU_CATEGORIES


def create_config(args: argparse.Namespace) -> MMAUConfig:
    if args.output:
        output_dir = args.output
    else:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_dir = f"./benchmark_results/mmau/{ts}"

    split = MMAUSplit(args.split)
    hf_repo = args.hf_repo
    if hf_repo is None:
        hf_repo = (
            "gamma-lab-umd/MMAU-test-mini"
            if split is MMAUSplit.TEST_MINI
            else "gamma-lab-umd/MMAU-test"
        )

    if args.mock:
        agent = "mock"
        use_hf = False
        use_fixture = True
    else:
        agent = args.agent or "eliza"
        use_hf = bool(args.hf)
        use_fixture = not use_hf

    return MMAUConfig(
        output_dir=output_dir,
        fixture_path=Path(args.fixture_path).resolve() if args.fixture_path else None,
        hf_repo=hf_repo,
        split=split,
        categories=parse_categories(args.category),
        max_samples=args.limit,
        use_huggingface=use_hf,
        use_fixture=use_fixture,
        agent=agent,
        provider=args.provider,
        model=args.model,
        stt_model=args.stt_model,
        temperature=args.temperature,
        timeout_ms=max(1000, args.timeout),
        save_traces=not args.no_traces,
        verbose=args.verbose,
    )


async def _run(config: MMAUConfig) -> dict[str, object]:
    runner = MMAURunner(config)
    report = await runner.run()
    return {
        "total_samples": report.total_samples,
        "overall_accuracy": report.overall_accuracy,
        "accuracy_by_category": report.accuracy_by_category,
        "accuracy_by_information_category": report.accuracy_by_information_category,
        "average_latency_ms": report.average_latency_ms,
        "error_count": report.error_count,
        "output_dir": config.output_dir,
        "summary": report.summary,
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    config = create_config(args)

    try:
        results = asyncio.run(_run(config))
    except KeyboardInterrupt:
        logger.info("MMAU interrupted")
        return 130
    except Exception as exc:
        logger.error("MMAU failed: %s", exc)
        if args.json:
            print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    if args.json:
        print(json.dumps(results, indent=2, default=str))
    else:
        print("\n" + "=" * 60)
        print("MMAU Results")
        print("=" * 60)
        print(f"Samples: {results['total_samples']}")
        overall = float(results["overall_accuracy"])  # type: ignore[arg-type]
        print(f"Overall Accuracy: {overall * 100:.1f}%")
        by_cat = results["accuracy_by_category"]
        if isinstance(by_cat, dict):
            for cat in sorted(by_cat):
                acc = float(by_cat[cat])
                print(f"  {cat:<8} {acc * 100:.1f}%")
        print(f"Errors: {results['error_count']}")
        print(f"Results saved to: {config.output_dir}")
        print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
