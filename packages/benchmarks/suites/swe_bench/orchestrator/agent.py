"""Minimal orchestrating agent used by SWE-bench tests."""

from __future__ import annotations

from benchmarks.swe_bench.orchestrator.types import OrchestratedBenchmarkConfig


class OrchestratingAgent:
    def __init__(
        self,
        *,
        runtime: object,
        repo_manager: object,
        config: OrchestratedBenchmarkConfig,
    ) -> None:
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.config = config

    async def _analyze_and_create_task_description(
        self,
        instance: object,
        trace: object,
    ) -> tuple[str, int]:
        prompt = (
            f"Create a concise implementation task for {instance.repo}:\n"
            f"{instance.problem_statement}\n\nHints:\n{instance.hints_text}"
        )
        try:
            description = await self.runtime.use_model("TEXT_LARGE", {"prompt": prompt})
        except Exception as exc:
            if not self.config.allow_task_description_fallback:
                raise RuntimeError("Orchestrator model failed") from exc
            description = (
                f"Fix this issue in {instance.repo}:\n"
                f"{instance.problem_statement}\n\nHints:\n{instance.hints_text}"
            )
        if hasattr(trace, "add"):
            trace.add("orchestrator", "task_description", {"description": description})
        return str(description), max(1, len(str(description).split()))
