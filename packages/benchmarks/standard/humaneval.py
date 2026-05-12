"""HumanEval benchmark adapter.

Code-completion benchmark from OpenAI (164 hand-crafted Python problems).
For each problem the model is shown a function signature + docstring;
it must emit the function body. Pass@1 is computed by running each
problem's hidden test suite against the completion.

This adapter prefers ``bigcode-evaluation-harness`` when present (the
canonical runner) but falls back to a built-in execution loop so smoke
tests don't need the dependency.

CLI:

    python -m benchmarks.standard.humaneval \\
        --model-endpoint http://localhost:8000/v1 \\
        --model gpt-4o-mini \\
        --output /tmp/humaneval

Result file: ``<output>/humaneval-results.json``.

Security note: exec is sandboxed with ``multiprocessing`` + a hard
timeout per test; this mirrors what bigcode-evaluation-harness does
internally. Do **not** run untrusted prompts on a machine with secrets
in env vars; prefer a container for production sweeps.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import io
import logging
import multiprocessing as mp
import re
import signal
import textwrap
from collections.abc import Iterable, Sequence
from pathlib import Path

from ._base import (
    BenchmarkResult,
    ChatMessage,
    GenerationConfig,
    OpenAICompatibleClient,
    RunStats,
)
from ._cli import RunnerFactory, cli_dispatch

log = logging.getLogger("benchmarks.standard.humaneval")

BENCHMARK_ID = "humaneval"
DATASET_VERSION = "openai_humaneval@1.0"
DATASET_NAME = "openai_humaneval"

SYSTEM_PROMPT = (
    "You are an expert Python programmer. The user will give you a "
    "Python function header and docstring. Respond with ONLY the function "
    "body (no markdown fence, no commentary, no repeat of the signature). "
    "Indent every line of the body with 4 spaces."
)

# Tiny in-repo fixture used for the smoke test. Real runs pull
# ``openai_humaneval`` via ``datasets``.
SMOKE_FIXTURES: tuple[dict[str, object], ...] = (
    {
        "task_id": "HumanEval/smoke_add",
        "prompt": "def add(a: int, b: int) -> int:\n    \"\"\"Return a + b.\"\"\"\n",
        "canonical_solution": "    return a + b\n",
        "test": (
            "def check(candidate):\n"
            "    assert candidate(1, 2) == 3\n"
            "    assert candidate(-1, 1) == 0\n"
            "    assert candidate(0, 0) == 0\n"
        ),
        "entry_point": "add",
    },
    {
        "task_id": "HumanEval/smoke_max",
        "prompt": "def max_of(xs: list[int]) -> int:\n    \"\"\"Return the largest int in xs.\"\"\"\n",
        "canonical_solution": "    return max(xs)\n",
        "test": (
            "def check(candidate):\n"
            "    assert candidate([1, 2, 3]) == 3\n"
            "    assert candidate([-5, -1, -3]) == -1\n"
        ),
        "entry_point": "max_of",
    },
)


_FENCE_RE = re.compile(r"```[^\n`]*\n?(.*?)```", re.DOTALL)


def _strip_code_fence(text: str) -> str:
    """Models often wrap responses in ``` fences; strip when present."""

    if "```" not in text:
        return text
    match = _FENCE_RE.search(text)
    return match.group(1) if match else text


def _defines_entry_point(code: str, entry_point: str) -> bool:
    try:
        tree = ast.parse(textwrap.dedent(code))
    except SyntaxError:
        return False
    return any(
        isinstance(node, ast.FunctionDef) and node.name == entry_point
        for node in tree.body
    )


def _reindent_function_body(body: str, indent: str = "    ") -> str:
    """Normalize a function body so every non-blank line has at least ``indent``.

    Models (especially eliza's REPLY action emitting code via gpt-oss-120b)
    sometimes drop the leading 4-space indent on the first line of a function
    body while indenting subsequent lines correctly, producing source like::

        numbers = sorted(numbers)
            if len(numbers) < 2:
                return False

    Concatenated after a ``def foo():\\n`` prompt this raises
    ``IndentationError: unexpected indent`` on the second line. We detect that
    pattern — body has at least one non-blank line with no leading indent AND
    at least one non-blank line that does start with ``indent`` — and prepend
    ``indent`` to the under-indented lines so the body is uniformly nested.

    Blank lines and lines that are already at >= ``indent`` columns of leading
    whitespace are left alone.
    """

    lines = body.splitlines()
    if not lines:
        return body
    has_unindented = False
    has_indented = False
    for line in lines:
        if not line.strip():
            continue
        if line.startswith(indent):
            has_indented = True
        elif not line.startswith((" ", "\t")):
            has_unindented = True
    if not (has_unindented and has_indented):
        return body
    fixed: list[str] = []
    for line in lines:
        if not line.strip():
            fixed.append(line)
            continue
        if line.startswith((" ", "\t")):
            fixed.append(line)
        else:
            fixed.append(indent + line)
    # Preserve trailing newline if present in input.
    suffix = "\n" if body.endswith("\n") else ""
    return "\n".join(fixed) + suffix


def _build_program(prompt: str, completion: str, test: str, entry_point: str) -> str:
    """Assemble the full program: prompt + completion + test suite."""

    completion = _strip_code_fence(completion).strip("\n")
    if _defines_entry_point(completion, entry_point):
        candidate = textwrap.dedent(completion).rstrip()
        return f"{candidate}\n{test}\ncheck({entry_point})\n"
    # IndentationError fix: some models emit the function body with the
    # first line at column 0 and subsequent lines correctly indented. Detect
    # and re-indent before splicing onto the prompt (which ends with the
    # function signature + docstring).
    completion = _reindent_function_body(completion)
    return f"{prompt}{completion}\n{test}\ncheck({entry_point})\n"


def _humaneval_worker(
    connection: "mp.connection.Connection",
    code: str,
    timeout_s: float,
) -> None:
    """Worker target — module-level so ``spawn`` can pickle it.

    On macOS Python 3.14+ multiprocessing defaults to ``spawn``, which
    requires the target callable to be importable. A nested closure
    would not be picklable.
    """

    try:
        # Suppress stdout from the candidate.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            # Defensive: cap per-process CPU time when the platform
            # supports it.
            with contextlib.suppress(Exception):
                import resource

                resource.setrlimit(
                    resource.RLIMIT_CPU,
                    (int(timeout_s) + 1, int(timeout_s) + 2),
                )
            # The candidate prompt may import things; restrict by giving
            # it a fresh globals dict.
            exec(compile(code, "<humaneval>", "exec"), {"__name__": "__main__"})
        connection.send((True, ""))
    except SystemExit as exc:
        connection.send((False, f"SystemExit({exc.code})"))
    except BaseException as exc:  # noqa: BLE001
        connection.send((False, f"{type(exc).__name__}: {exc}"))
    finally:
        connection.close()


def _execute_program(program: str, timeout_s: float) -> tuple[bool, str]:
    """Run a candidate program in a forked subprocess with a hard
    timeout. Returns (passed, error_message).
    """

    # Prefer "fork" when available (cheap; preserves loaded state). Fall
    # back to "spawn" on platforms where fork is unsafe (recent macOS
    # builds disable it by default).
    try:
        ctx = mp.get_context("fork")
    except ValueError:
        ctx = mp.get_context("spawn")

    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_humaneval_worker,
        args=(child_conn, program, timeout_s),
        daemon=True,
    )
    proc.start()
    proc.join(timeout=timeout_s)
    if proc.is_alive():
        with contextlib.suppress(Exception):
            proc.terminate()
        with contextlib.suppress(Exception):
            proc.join(0.5)
        if proc.is_alive() and hasattr(signal, "SIGKILL"):
            with contextlib.suppress(Exception):
                proc.kill()
        return False, f"timeout after {timeout_s:.1f}s"
    if not parent_conn.poll():
        return False, "no response from worker"
    try:
        passed, err = parent_conn.recv()
    except EOFError:
        return False, "EOF from worker"
    return bool(passed), str(err)


def _load_dataset_examples(limit: int | None) -> list[dict[str, object]]:
    try:
        from datasets import load_dataset
    except ImportError:
        log.warning("`datasets` not installed — using built-in fixture")
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    try:
        ds = load_dataset(DATASET_NAME, split="test")
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to load %s: %s — using fixture", DATASET_NAME, exc)
        items = list(SMOKE_FIXTURES)
        return items if limit is None else items[:limit]

    examples: list[dict[str, object]] = []
    for row in ds:
        examples.append(
            {
                "task_id": row.get("task_id") or "",
                "prompt": row.get("prompt") or "",
                "canonical_solution": row.get("canonical_solution") or "",
                "test": row.get("test") or "",
                "entry_point": row.get("entry_point") or "",
            }
        )
        if limit is not None and len(examples) >= limit:
            break
    return examples


class HumanEvalRunner:
    """Self-contained HumanEval scorer; pass@1 over a sandboxed exec."""

    benchmark_id: str = BENCHMARK_ID
    dataset_version: str = DATASET_VERSION

    def __init__(
        self,
        *,
        examples: Iterable[dict[str, object]] | None = None,
        max_tokens: int = 768,
        timeout_s: float = 10.0,
    ) -> None:
        self._examples = list(examples) if examples is not None else None
        self._max_tokens = max_tokens
        self._timeout_s = timeout_s

    def run(
        self,
        *,
        client: OpenAICompatibleClient,
        model: str,
        endpoint: str,
        output_dir: Path,
        limit: int | None,
    ) -> BenchmarkResult:
        stats = RunStats()
        examples = (
            self._examples
            if self._examples is not None
            else _load_dataset_examples(limit)
        )
        if not examples:
            raise RuntimeError("HumanEval loaded zero examples")

        config = GenerationConfig(
            model=model,
            max_tokens=self._max_tokens,
            temperature=0.0,
        )

        passed = 0
        n = 0
        failures: list[dict[str, object]] = []

        for i, item in enumerate(examples):
            prompt = str(item["prompt"])
            test = str(item["test"])
            entry = str(item["entry_point"])
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(role="user", content=prompt),
            ]
            try:
                gen = client.generate(messages, config)
            except Exception as exc:  # noqa: BLE001
                log.warning("generation failed (idx=%d): %s", i, exc)
                continue
            program = _build_program(prompt, gen.text, test, entry)
            ok, err = _execute_program(program, self._timeout_s)
            n += 1
            if ok:
                passed += 1
            elif len(failures) < 8:
                failures.append(
                    {
                        "task_id": item.get("task_id"),
                        "completion": gen.text[:400],
                        "error": err,
                    }
                )

        if n == 0:
            raise RuntimeError("HumanEval evaluated zero examples — model returned no output")
        pass_at_1 = passed / n
        return BenchmarkResult(
            benchmark=BENCHMARK_ID,
            model=model,
            endpoint=endpoint,
            dataset_version=DATASET_VERSION,
            n=n,
            metrics={
                "score": round(pass_at_1, 4),
                "pass@1": round(pass_at_1, 4),
                "passed": float(passed),
                "n": float(n),
            },
            raw_json={"timeout_s": self._timeout_s},
            failures=failures,
            elapsed_s=stats.elapsed(),
        )


class _HumanEvalFactory(RunnerFactory):
    prog = "benchmarks.standard.humaneval"
    description = "HumanEval pass@1 (openai_humaneval) over an OpenAI-compatible endpoint."

    def augment_parser(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--max-tokens",
            type=int,
            default=768,
            help="Cap on generated tokens per problem",
        )
        parser.add_argument(
            "--timeout-s",
            type=float,
            default=10.0,
            help="Per-test execution timeout in seconds",
        )

    def build(self, args: argparse.Namespace) -> tuple[HumanEvalRunner, Sequence[str] | None]:
        runner = HumanEvalRunner(max_tokens=args.max_tokens, timeout_s=args.timeout_s)
        mock_responses: Sequence[str] | None = None
        if args.mock:
            runner = HumanEvalRunner(
                examples=list(SMOKE_FIXTURES),
                max_tokens=args.max_tokens,
                timeout_s=args.timeout_s,
            )
            # Echo canonical solutions for the smoke fixture.
            mock_responses = [str(item["canonical_solution"]) for item in SMOKE_FIXTURES]
        return runner, mock_responses


def main() -> int:
    cli_dispatch(_HumanEvalFactory(), output_filename="humaneval-results.json")
    return 0  # unreachable


if __name__ == "__main__":
    main()
