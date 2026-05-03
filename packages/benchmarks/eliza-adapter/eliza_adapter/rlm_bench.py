"""RLM-Bench task runner backed by the eliza TS benchmark server.

Drop-in replacement for ``run_eliza_benchmark`` /
``RLMBenchRunner._run_task_with_eliza`` when ``--mode eliza`` is used.
Each task is sent through ``ElizaClient.send_message`` along with the
benchmark context + question, and the predicted answer is parsed out
of the response (``params.answer``, ``<answer>...</answer>`` tag, or
the full text as fallback).
"""

from __future__ import annotations

import logging
import re
import time
from typing import TYPE_CHECKING, Callable, Optional

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from elizaos_rlm_bench.types import (
        RLMBenchConfig,
        RLMBenchResult,
        RLMBenchResults,
        RLMBenchTask,
    )


def _rlm_types():
    from elizaos_rlm_bench.types import (
        RLMBenchConfig,
        RLMBenchResult,
        RLMBenchResults,
        RLMBenchTask,
    )

    return RLMBenchConfig, RLMBenchResult, RLMBenchResults, RLMBenchTask


logger = logging.getLogger(__name__)


_ANSWER_TAG_RE = re.compile(r"<answer>(.*?)</answer>", re.DOTALL | re.IGNORECASE)


def _extract_answer(text: str, params: dict) -> str:
    raw = params.get("answer")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    if not text:
        return ""
    m = _ANSWER_TAG_RE.search(text)
    if m:
        return m.group(1).strip()
    return text.strip()


async def run_eliza_bridge_benchmark(
    config: "RLMBenchConfig",
    progress_callback: Optional[Callable[[int, int], None]] = None,
    client: Optional[ElizaClient] = None,
) -> "RLMBenchResults":
    """Run the full RLM benchmark by routing every task through the TS bridge.

    Mirrors ``run_eliza_benchmark`` from ``elizaos_rlm_bench.runner`` but
    skips Python ``AgentRuntime`` setup entirely. Uses the same
    ``RLMBenchEvaluator`` for scoring so reports stay comparable.
    """
    from elizaos_rlm_bench.runner import RLMBenchRunner

    cli = client or ElizaClient()
    cli.wait_until_ready(timeout=120)

    runner = RLMBenchRunner(config=config)
    tasks = runner.generator.generate_all_tasks()
    total = len(tasks)
    logger.info("Running %d RLM-bench tasks via eliza TS bridge", total)

    _, _, RLMBenchResults, _ = _rlm_types()

    results: list = []
    for i, task in enumerate(tasks):
        if progress_callback:
            progress_callback(i, total)

        start_time = time.time()
        predicted_answer = ""
        error: Optional[str] = None
        try:
            try:
                cli.reset(task_id=task.id, benchmark="rlm-bench")
            except Exception as exc:
                logger.debug("Eliza reset failed (continuing): %s", exc)

            prompt = (
                f"You are an AI agent solving an RLM benchmark task.\n\n"
                f"Bench type: {task.bench_type.value}\n"
                f"Context length: ~{task.context_length_tokens} tokens\n\n"
                f"Context:\n{task.context}\n\n"
                f"Question: {task.question}\n\n"
                f"Respond with the answer wrapped in <answer>...</answer>."
            )
            response = cli.send_message(
                text=prompt,
                context={
                    "benchmark": "rlm-bench",
                    "task_id": task.id,
                    "bench_type": task.bench_type.value,
                    "context_length_tokens": task.context_length_tokens,
                    "question": task.question,
                },
            )
            predicted_answer = _extract_answer(response.text or "", response.params)
        except Exception as exc:
            error = str(exc)
            logger.error("[eliza-rlm] Task %s failed: %s", task.id, exc)

        latency_ms = (time.time() - start_time) * 1000
        results.append(
            runner.evaluator.evaluate_result(
                task=task,
                predicted_answer=predicted_answer,
                latency_ms=latency_ms,
                error=error,
            )
        )

    metrics = runner.evaluator.compute_metrics(results)
    paper_comparison = runner._build_paper_comparison(metrics)
    summary = runner._build_summary(metrics)

    return RLMBenchResults(
        config=config,
        metrics=metrics,
        results=results,
        paper_comparison=paper_comparison,
        strategy_breakdown=runner._build_strategy_breakdown(results),
        cost_analysis=runner._build_cost_analysis(metrics),
        summary=summary,
        metadata={
            "mode": "eliza",
            "backend": "eliza-ts-bridge",
            "total_tasks": total,
        },
    )
