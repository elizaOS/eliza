"""VoiceBench-quality run orchestration."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict
from pathlib import Path
from typing import Sequence

from .adapters import AdapterRequest, VoiceAdapter
from .clients.judge import Judge
from .dataset import load_samples
from .evaluator import score_sample
from .types import SUITES, Sample, SuiteId, SuiteResult, VoiceBenchResult

log = logging.getLogger("elizaos_voicebench.runner")


# Suite-specific prompt wrappers. MCQ suites need the choices spliced
# into the prompt because the upstream HF row stores them as a separate
# field. Open-ended suites pass the reference text through untouched.
def build_prompt(sample: Sample) -> str:
    if sample.suite in ("openbookqa", "mmsu"):
        choices = sample.metadata.get("choices")
        choices_block = ""
        if isinstance(choices, list):
            choices_block = "\n".join(str(c) for c in choices)
        return (
            f"{sample.reference_text}\n\n{choices_block}\n\n"
            "Answer with a single letter (A, B, C, or D)."
        )
    return sample.reference_text


async def run_suite(
    *,
    suite: SuiteId,
    adapter: VoiceAdapter,
    judge: Judge,
    limit: int | None,
    mock: bool,
) -> SuiteResult:
    samples = load_samples(suite, limit=limit, mock=mock)
    if not samples:
        raise RuntimeError(f"suite {suite!r} loaded zero samples")

    scores: list[float] = []
    sample_scores = []
    for sample in samples:
        prompt = build_prompt(sample)
        response = await adapter(AdapterRequest(prompt_text=prompt, sample=sample))
        result = await score_sample(suite, sample, response.text, judge=judge)
        sample_scores.append(result)
        scores.append(result.score)
        log.debug(
            "suite=%s sample=%s score=%.2f", suite, sample.sample_id, result.score
        )

    mean = sum(scores) / len(scores)
    return SuiteResult(
        suite=suite,
        n=len(samples),
        score=mean,
        samples=sample_scores,
    )


async def run(
    *,
    adapter: VoiceAdapter,
    judge: Judge,
    suites: Sequence[SuiteId],
    limit: int | None,
    mock: bool,
    output_dir: Path,
    agent_name: str,
    stt_provider: str,
) -> VoiceBenchResult:
    started = time.perf_counter()
    suite_details: list[SuiteResult] = []
    per_suite: dict[str, float] = {}
    total_n = 0

    for suite in suites:
        log.info("running suite %s", suite)
        result = await run_suite(
            suite=suite,
            adapter=adapter,
            judge=judge,
            limit=limit,
            mock=mock,
        )
        suite_details.append(result)
        per_suite[suite] = round(result.score, 4)
        total_n += result.n

    overall = (
        sum(per_suite.values()) / len(per_suite) if per_suite else 0.0
    )
    elapsed = round(time.perf_counter() - started, 3)

    result = VoiceBenchResult(
        agent=agent_name,
        suites_run=list(suites),
        score=round(overall, 4),
        per_suite=per_suite,
        n=total_n,
        elapsed_s=elapsed,
        suite_details=suite_details,
        judge_model=getattr(judge, "model", ""),
        stt_provider=stt_provider,
    )
    _persist(result, output_dir)
    return result


def _persist(result: VoiceBenchResult, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "voicebench-quality-results.json"
    payload = asdict(result)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    log.info("wrote %s", path)


def resolve_suites(selected: str | None) -> tuple[SuiteId, ...]:
    if selected is None or selected == "all":
        return SUITES
    if selected in SUITES:
        return (selected,)  # type: ignore[return-value]
    raise ValueError(
        f"unknown suite {selected!r}; expected one of {SUITES + ('all',)}"
    )


def run_sync(*args: object, **kwargs: object) -> VoiceBenchResult:
    """Synchronous façade for callers that don't already have a loop."""

    return asyncio.run(run(*args, **kwargs))  # type: ignore[arg-type]
