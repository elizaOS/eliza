"""Shared CLI scaffolding for standard benchmark adapters.

Each adapter calls ``build_parser`` to add its specific args on top of
the shared base, then ``run_cli`` to execute the runner. This eliminates
~40 lines of duplicated argparse boilerplate per adapter.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Sequence

from ._base import (
    BenchmarkResult,
    BenchmarkRunner,
    TrajectoryRecordingClient,
    make_client,
    resolve_api_key,
    resolve_endpoint,
)


def build_parser(*, prog: str, description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=prog, description=description)
    parser.add_argument(
        "--model-endpoint",
        default=None,
        help="OpenAI-compatible chat-completion endpoint URL (e.g. http://localhost:8000/v1)",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="Shortcut for --model-endpoint (one of: openai, groq, openrouter, cerebras, vllm, ollama, elizacloud)",
    )
    parser.add_argument(
        "--model",
        required=False,
        default="gpt-4o-mini",
        help="Model id to send in the chat-completion request",
    )
    parser.add_argument(
        "--api-key-env",
        default="OPENAI_API_KEY",
        help="Environment variable name that holds the API key",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output directory for the results JSON",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional cap on number of evaluated examples",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Run with a deterministic mock client (no network).",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR)",
    )
    return parser


def run_cli(
    *,
    runner_factory: "RunnerFactory",
    output_filename: str,
    argv: Sequence[str] | None = None,
) -> int:
    """Drive the shared CLI flow:

    1. Parse args + setup logging.
    2. Resolve endpoint / api key / mock-vs-real client.
    3. Invoke the runner.
    4. Persist results to ``<output>/<output_filename>``.

    ``runner_factory`` is a callable taking the parsed args and returning
    a ``BenchmarkRunner`` plus an optional list of mock responses.
    """

    parser = build_parser(prog=runner_factory.prog, description=runner_factory.description)
    runner_factory.augment_parser(parser)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    endpoint = resolve_endpoint(
        model_endpoint=args.model_endpoint,
        provider=args.provider,
    )
    api_key = resolve_api_key(args.api_key_env)

    runner, mock_responses = runner_factory.build(args)
    client = make_client(
        endpoint=endpoint,
        api_key=api_key,
        mock_responses=mock_responses if args.mock else None,
    )
    client = TrajectoryRecordingClient(
        client,
        output_path=output_dir / "trajectories.jsonl",
        benchmark_id=runner.benchmark_id,
        model=args.model,
    )

    result: BenchmarkResult = runner.run(
        client=client,
        model=args.model,
        endpoint=endpoint,
        output_dir=output_dir,
        limit=args.limit,
    )
    out_path = result.write(output_dir / output_filename)
    print(json.dumps({"output": str(out_path), "metrics": result.metrics}, indent=2))
    return 0


class RunnerFactory:
    """Per-adapter factory that the shared CLI driver calls into.

    Adapters subclass this to provide their parser-augmentation and
    runner construction without depending on argparse internals.
    """

    prog: str = "benchmarks.standard"
    description: str = ""

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        """Override to add adapter-specific args."""

    def build(
        self,
        args: argparse.Namespace,
    ) -> tuple[BenchmarkRunner, Sequence[str] | None]:
        raise NotImplementedError


def main_entry(
    runner_factory: RunnerFactory,
    *,
    output_filename: str,
    argv: Sequence[str] | None = None,
) -> int:
    return run_cli(
        runner_factory=runner_factory,
        output_filename=output_filename,
        argv=argv,
    )


def cli_dispatch(
    runner_factory: RunnerFactory,
    *,
    output_filename: str,
) -> None:
    sys.exit(main_entry(runner_factory, output_filename=output_filename))
