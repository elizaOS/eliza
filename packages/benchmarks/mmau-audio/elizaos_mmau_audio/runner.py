"""MMAU benchmark runner."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from benchmarks.mmau.agent import MMAUAgentProtocol, OracleMMAUAgent
from benchmarks.mmau.dataset import MMAUDataset
from benchmarks.mmau.evaluator import MMAUEvaluator
from benchmarks.mmau.types import (
    MMAUConfig,
    MMAUPrediction,
    MMAUReport,
    MMAUResult,
    MMAUSample,
)

logger = logging.getLogger(__name__)


class MMAURunner:
    """Orchestrates load -> dispatch -> score -> report -> persist."""

    def __init__(
        self,
        config: MMAUConfig,
        *,
        agent: MMAUAgentProtocol | None = None,
    ) -> None:
        self.config = config
        self._injected_agent = agent
        self.dataset = MMAUDataset(
            fixture_path=config.fixture_path,
            hf_repo=config.hf_repo,
            split=config.split,
            categories=config.categories,
        )
        self.evaluator = MMAUEvaluator()

    async def run(self) -> MMAUReport:
        await self.dataset.load(
            use_huggingface=self.config.use_huggingface,
            use_fixture=self.config.use_fixture,
            max_samples=self.config.max_samples,
        )
        samples = self.dataset.get_samples(self.config.max_samples)
        if not samples:
            raise RuntimeError("MMAU: no samples loaded")

        agent = self._create_agent()
        await agent.initialize()
        results: list[MMAUResult] = []
        try:
            for sample in samples:
                result = await self._run_sample(agent, sample)
                results.append(result)
                logger.info(
                    "MMAU %s/%s expected=%s predicted=%s correct=%s",
                    sample.category.value,
                    sample.id,
                    result.expected_letter,
                    result.predicted_letter,
                    result.is_correct,
                )
        finally:
            await agent.close()

        report = self._build_report(results)
        self._save(report)
        return report

    def _create_agent(self) -> MMAUAgentProtocol:
        if self._injected_agent is not None:
            return self._injected_agent
        agent_name = (self.config.agent or "").strip().lower()
        if agent_name in {"", "mock", "oracle"}:
            return OracleMMAUAgent()
        if agent_name == "eliza":
            from eliza_adapter.mmau import ElizaMMAUAgent  # type: ignore[import-not-found]

            return ElizaMMAUAgent(self.config)
        if agent_name == "hermes":
            from eliza_adapter.mmau import HermesMMAUAgent  # type: ignore[import-not-found]

            return HermesMMAUAgent(self.config)
        if agent_name == "openclaw":
            from eliza_adapter.mmau import OpenClawMMAUAgent  # type: ignore[import-not-found]

            return OpenClawMMAUAgent(self.config)
        raise ValueError(
            f"MMAU: unknown agent {agent_name!r}; expected one of "
            "mock/eliza/hermes/openclaw"
        )

    async def _run_sample(
        self, agent: MMAUAgentProtocol, sample: MMAUSample
    ) -> MMAUResult:
        started = time.time()
        timeout_s = max(1.0, self.config.timeout_ms / 1000)
        try:
            prediction = await asyncio.wait_for(agent.predict(sample), timeout=timeout_s)
        except asyncio.TimeoutError:
            prediction = MMAUPrediction(
                sample_id=sample.id,
                error="timeout",
                latency_ms=(time.time() - started) * 1000,
            )
        except Exception as exc:
            logger.exception("MMAU sample failed: %s", sample.id)
            prediction = MMAUPrediction(
                sample_id=sample.id,
                error=str(exc),
                latency_ms=(time.time() - started) * 1000,
            )
        return self.evaluator.evaluate(sample, prediction)

    def _build_report(self, results: list[MMAUResult]) -> MMAUReport:
        agg = self.evaluator.aggregate(results)
        return MMAUReport(
            total_samples=len(results),
            overall_accuracy=float(agg["overall_accuracy"]),
            accuracy_by_category=dict(agg["accuracy_by_category"]),  # type: ignore[arg-type]
            accuracy_by_skill=dict(agg["accuracy_by_skill"]),  # type: ignore[arg-type]
            accuracy_by_information_category=dict(
                agg["accuracy_by_information_category"]  # type: ignore[arg-type]
            ),
            accuracy_by_difficulty=dict(agg["accuracy_by_difficulty"]),  # type: ignore[arg-type]
            counts_by_category=dict(agg["counts_by_category"]),  # type: ignore[arg-type]
            counts_by_skill=dict(agg["counts_by_skill"]),  # type: ignore[arg-type]
            average_latency_ms=float(agg["average_latency_ms"]),
            error_count=int(agg["error_count"]),
            results=results,
            summary={
                "timestamp": datetime.now().isoformat(),
                "source": "huggingface" if self.config.use_huggingface else "fixture",
                "hf_repo": self.config.hf_repo,
                "split": self.config.split.value,
                "agent": self.config.agent,
                "provider": self.config.provider or "",
                "model": self.config.model or "",
                "stt_model": self.config.stt_model,
                "categories": [c.value for c in self.config.categories],
            },
        )

    def _save(self, report: MMAUReport) -> None:
        out = Path(self.config.output_dir)
        out.mkdir(parents=True, exist_ok=True)
        results_path = out / "mmau-results.json"
        with results_path.open("w", encoding="utf-8") as f:
            json.dump(_report_to_dict(report), f, indent=2, default=str)
        summary_path = out / "summary.md"
        with summary_path.open("w", encoding="utf-8") as f:
            f.write(_markdown_summary(report))
        if self.config.save_traces:
            trace_dir = out / "traces"
            trace_dir.mkdir(parents=True, exist_ok=True)
            for r in report.results:
                trace_path = trace_dir / f"{_safe_name(r.sample_id)}.json"
                with trace_path.open("w", encoding="utf-8") as f:
                    json.dump(_result_to_dict(r), f, indent=2, default=str)
        logger.info("MMAU results saved to %s", out)


def _report_to_dict(report: MMAUReport) -> dict[str, Any]:
    return {
        "benchmark": "mmau",
        "total_samples": report.total_samples,
        "overall_accuracy": report.overall_accuracy,
        "accuracy_by_category": report.accuracy_by_category,
        "accuracy_by_skill": report.accuracy_by_skill,
        "accuracy_by_information_category": report.accuracy_by_information_category,
        "accuracy_by_difficulty": report.accuracy_by_difficulty,
        "counts_by_category": report.counts_by_category,
        "counts_by_skill": report.counts_by_skill,
        "average_latency_ms": report.average_latency_ms,
        "error_count": report.error_count,
        "summary": report.summary,
        "metrics": {
            "overall_accuracy": report.overall_accuracy,
            "speech_accuracy": report.accuracy_by_category.get("speech", 0.0),
            "sound_accuracy": report.accuracy_by_category.get("sound", 0.0),
            "music_accuracy": report.accuracy_by_category.get("music", 0.0),
            "total_samples": report.total_samples,
            "error_count": report.error_count,
        },
        "results": [_result_to_dict(r) for r in report.results],
    }


def _result_to_dict(result: MMAUResult) -> dict[str, Any]:
    data = asdict(result)
    data["category"] = result.category.value
    return data


def _markdown_summary(report: MMAUReport) -> str:
    lines = [
        "# MMAU Results",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Agent | {report.summary.get('agent', 'unknown')} |",
        f"| Source | {report.summary.get('source', 'unknown')} |",
        f"| Split | {report.summary.get('split', 'unknown')} |",
        f"| Total Samples | {report.total_samples} |",
        f"| Overall Accuracy | {report.overall_accuracy * 100:.1f}% |",
        f"| Avg Latency (ms) | {report.average_latency_ms:.0f} |",
        f"| Errors | {report.error_count} |",
        "",
        "## By Category",
        "",
        "| Category | Samples | Accuracy |",
        "|---|---:|---:|",
    ]
    for cat in sorted(report.accuracy_by_category):
        acc = report.accuracy_by_category[cat]
        count = report.counts_by_category.get(cat, 0)
        lines.append(f"| {cat} | {count} | {acc * 100:.1f}% |")
    lines.extend(["", "## By Skill", "", "| Skill | Samples | Accuracy |", "|---|---:|---:|"])
    for skill in sorted(report.accuracy_by_skill):
        acc = report.accuracy_by_skill[skill]
        count = report.counts_by_skill.get(skill, 0)
        lines.append(f"| {skill} | {count} | {acc * 100:.1f}% |")
    lines.extend([
        "",
        "## Notes",
        "",
        "- Pure MCQ: scoring is exact match on the parsed answer letter.",
        "- Cascaded STT discards music / non-speech semantics; expect lower "
        "scores on sound and music categories than on speech.",
        "",
    ])
    return "\n".join(lines)


def _safe_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value)
