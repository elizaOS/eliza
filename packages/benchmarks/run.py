"""Top-level dispatch CLI for standard benchmark adapters.

Usage:

    python -m benchmarks.run <benchmark-id> [adapter-args...]

Where ``<benchmark-id>`` is one of the adapters registered under
``benchmarks.standard.*``: ``mmlu``, ``humaneval``, ``gsm8k``,
``mt_bench``.

Examples:

    python -m benchmarks.run mmlu --help
    python -m benchmarks.run mmlu --mock --provider openai --output /tmp/mmlu
    python -m benchmarks.run mt_bench --model-endpoint http://localhost:8000/v1 \\
        --judge-model gpt-4o --output /tmp/mt-bench

The dispatcher is a thin shim: it picks the adapter module by id and
delegates argv to that adapter's ``main()`` entry point. Adding a new
standard adapter is a one-line entry in ``_DISPATCH``.
"""

from __future__ import annotations

import sys
from typing import Callable, Mapping, Sequence


def _mmlu_main() -> int:
    from .standard.mmlu import main

    return main()


def _humaneval_main() -> int:
    from .standard.humaneval import main

    return main()


def _gsm8k_main() -> int:
    from .standard.gsm8k import main

    return main()


def _mt_bench_main() -> int:
    from .standard.mt_bench import main

    return main()


_DISPATCH: Mapping[str, Callable[[], int]] = {
    "mmlu": _mmlu_main,
    "humaneval": _humaneval_main,
    "gsm8k": _gsm8k_main,
    "mt_bench": _mt_bench_main,
    "mt-bench": _mt_bench_main,
}


_USAGE = (
    "usage: python -m benchmarks.run <benchmark-id> [args...]\n\n"
    "Available benchmarks:\n"
    "  mmlu      — MMLU 4-way multiple-choice (cais/mmlu)\n"
    "  humaneval — HumanEval pass@1 (openai_humaneval)\n"
    "  gsm8k     — GSM8K grade-school math (openai/gsm8k)\n"
    "  mt_bench  — MT-Bench multi-turn with judge model (LMSYS)\n\n"
    "Run `python -m benchmarks.run <id> --help` for adapter-specific args.\n"
)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(argv) if argv is not None else sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(_USAGE)
        return 0
    benchmark_id = args[0].strip().lower()
    adapter = _DISPATCH.get(benchmark_id)
    if adapter is None:
        sys.stderr.write(
            f"unknown benchmark: {benchmark_id!r}\n\n{_USAGE}"
        )
        return 2
    # Hand the remaining argv to the adapter via sys.argv.
    sys.argv = [f"benchmarks.run {benchmark_id}", *args[1:]]
    return adapter()


if __name__ == "__main__":
    sys.exit(main())
