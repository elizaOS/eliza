"""Orchestrated/direct-shell matrix runner for GAIA benchmark."""

from __future__ import annotations

import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_ROOT = Path(__file__).resolve().parents[4]
_ORCH_PKG = _ROOT / "plugins" / "plugin-agent-orchestrator" / "python"
if _ORCH_PKG.exists() and str(_ORCH_PKG) not in sys.path:
    sys.path.insert(0, str(_ORCH_PKG))

from elizaos_plugin_agent_orchestrator import (
    AgentOrchestratorPluginOptions,
    AgentOrchestratorService,
    TaskResult,
    configure_agent_orchestrator_plugin,
)

from elizaos_gaia.dataset import GAIADataset
from elizaos_gaia.evaluator import GAIAEvaluator
from elizaos_gaia.orchestrator.providers import (
    BaseGAIAProvider,
    ClaudeCodeGAIAProvider,
    CodexGAIAProvider,
    SWEAgentGAIAProvider,
)
from elizaos_gaia.orchestrator.trace import GAIATraceRecorder
from elizaos_gaia.orchestrator.types import (
    ExecutionMode,
    OrchestratedGAIAReport,
    ProviderQuestionResult,
    ProviderType,
)
from elizaos_gaia.types import GAIAConfig, GAIAQuestion, GAIAResult, GAIALevel

logger = logging.getLogger(__name__)


class _ServiceRuntimeStub:
    """Runtime stub for AgentOrchestratorService in benchmark-only mode."""

    def __init__(self) -> None:
        self.agent_id = "gaia-orchestrator-benchmark"

    async def create_task(self, task_input: dict[str, object]) -> str:
        _ = task_input
        raise RuntimeError("Database adapter not set")

    async def get_task(self, task_id: str) -> None:
        _ = task_id
        return None

    async def get_tasks(self, options: dict[str, object]) -> list[object]:
        _ = options
        return []

    async def update_task(self, task_id: str, updates: dict[str, object]) -> None:
        _ = task_id, updates

    async def delete_task(self, task_id: str) -> None:
        _ = task_id

    async def get_room(self, room_id: str) -> None:
        _ = room_id
        return None


class OrchestratedGAIARunner:
    """Runs GAIA with orchestrated and direct-shell control planes."""

    def __init__(self, config: GAIAConfig) -> None:
        self.config = config
        self.dataset = GAIADataset(cache_dir=config.cache_dir)
        self.evaluator = GAIAEvaluator()
        self.runtime = _ServiceRuntimeStub()
        self.service: AgentOrchestratorService | None = None
        self.providers: dict[str, BaseGAIAProvider] = {}

    def _provider_types(self) -> list[ProviderType]:
        selected: list[ProviderType] = []
        for raw in self.config.provider_set:
            try:
                selected.append(ProviderType(raw))
            except ValueError:
                logger.warning("Ignoring unsupported provider '%s' for GAIA matrix", raw)
        if not selected:
            return [ProviderType.CLAUDE_CODE, ProviderType.SWE_AGENT, ProviderType.CODEX]
        return selected

    def _required_capabilities(self) -> list[str]:
        if self.config.required_capabilities:
            return list(self.config.required_capabilities)
        required: list[str] = []
        if self.config.enable_web_search:
            required.append("research.web_search")
        if self.config.enable_web_browse:
            required.append("research.web_browse")
        required.append("research.docs_lookup")
        if self.config.enable_code_execution:
            required.append("research.code_exec")
        return required

    def _tool_to_capability(self, tool_name: str) -> str | None:
        mapping = {
            "web_search": "research.web_search",
            "web_browse": "research.web_browse",
            "file_read": "research.docs_lookup",
            "pdf_read": "research.docs_lookup",
            "spreadsheet_read": "research.docs_lookup",
            "code_exec": "research.code_exec",
            "calculator": "research.code_exec",
        }
        return mapping.get(tool_name.strip().lower())

    def _observed_capabilities(self, tool_names: list[str]) -> list[str]:
        observed: set[str] = set()
        for tool_name in tool_names:
            capability = self._tool_to_capability(tool_name)
            if capability:
                observed.add(capability)
        return sorted(observed)

    def _make_question_payload(self, question: GAIAQuestion) -> str:
        payload = {
            "task_id": question.task_id,
            "question": question.question,
            "level": question.level.value,
            "final_answer": question.final_answer,
            "file_name": question.file_name,
            "file_path": str(question.file_path) if question.file_path else None,
        }
        return json.dumps(payload)

    async def initialize(self) -> None:
        provider_map: dict[ProviderType, BaseGAIAProvider] = {
            ProviderType.CLAUDE_CODE: ClaudeCodeGAIAProvider(None, self.config),
            ProviderType.SWE_AGENT: SWEAgentGAIAProvider(None, self.config),
            ProviderType.CODEX: CodexGAIAProvider(None, self.config),
        }
        selected_types = self._provider_types()
        self.providers = {
            provider_type.value: provider_map[provider_type]
            for provider_type in selected_types
        }
        provider_list = list(self.providers.values())
        configure_agent_orchestrator_plugin(
            AgentOrchestratorPluginOptions(
                providers=provider_list,
                default_provider_id=provider_list[0].id,
                get_working_directory=lambda: self.config.files_dir or ".",
            )
        )
        self.service = await AgentOrchestratorService.start(self.runtime)

    async def run_benchmark(self, hf_token: str | None = None) -> OrchestratedGAIAReport:
        await self.initialize()
        questions = await self.dataset.load(
            split=self.config.split,
            hf_token=hf_token,
            source=self.config.dataset_source,
            dataset_path=self.config.dataset_path,
        )

        if self.config.levels:
            questions = [q for q in questions if q.level in self.config.levels]
        if self.config.max_questions:
            questions = questions[: self.config.max_questions]

        modes = (
            [ExecutionMode.ORCHESTRATED, ExecutionMode.DIRECT_SHELL]
            if self.config.matrix
            else [ExecutionMode(self.config.execution_mode)]
        )
        report = OrchestratedGAIAReport(config=self.config)

        for mode in modes:
            mode_results: dict[str, list[ProviderQuestionResult]] = {}
            for provider_type in self._provider_types():
                provider_results: list[ProviderQuestionResult] = []
                for question in questions:
                    result = await self._run_question(question, provider_type, mode)
                    provider_results.append(result)
                mode_results[provider_type.value] = provider_results
            report.matrix_results[mode.value] = mode_results

        primary_mode = ExecutionMode(self.config.execution_mode).value
        report.by_provider = report.matrix_results.get(
            primary_mode,
            next(iter(report.matrix_results.values()), {}),
        )
        report.compute_summaries()
        self._save_report(report)
        return report

    async def _run_question(
        self,
        question: GAIAQuestion,
        provider_type: ProviderType,
        mode: ExecutionMode,
    ) -> ProviderQuestionResult:
        provider = self.providers[provider_type.value]
        trace = GAIATraceRecorder(
            task_id=question.task_id,
            provider_id=provider_type.value,
            mode=mode.value,
            output_dir=str(Path(self.config.output_dir) / "traces"),
        )
        trace.add(
            "orchestrator",
            "question_start",
            {
                "task_id": question.task_id,
                "provider": provider_type.value,
                "mode": mode.value,
                "level": question.level.value,
            },
        )
        required = self._required_capabilities()
        declared = list(provider.capabilities)
        violations = [cap for cap in required if cap not in declared]
        trace.add(
            "orchestrator",
            "capability_preflight",
            {
                "required": required,
                "declared": declared,
                "violations": violations,
                "strict": self.config.strict_capabilities,
            },
        )

        if violations and self.config.strict_capabilities:
            result = GAIAResult(
                task_id=question.task_id,
                level=question.level,
                question=question.question,
                predicted_answer="",
                expected_answer=question.final_answer,
                is_correct=False,
                error="Missing required capabilities: " + ", ".join(violations),
            )
            trace.set_capabilities(
                required=required,
                declared=declared,
                observed=[],
                violations=violations,
            )
            trace_file = trace.save() if self.config.save_trajectories else None
            return ProviderQuestionResult(
                provider=provider_type,
                task_id=question.task_id,
                gaia_result=result,
                control_plane_mode=mode,
                delegation_successful=False,
                declared_capabilities=declared,
                observed_capabilities=[],
                capability_violations=violations,
                trace_file=trace_file,
            )

        task_description = self._make_question_payload(question)
        orchestration_start = time.time()
        provider_result: TaskResult

        if mode == ExecutionMode.ORCHESTRATED:
            if self.service is None:
                raise RuntimeError("Orchestrator service not initialized")
            task = await self.service.create_task(
                name=f"GAIA: {question.task_id}",
                description=task_description,
                provider_id=provider_type.value,
            )
            trace.add(
                "orchestrator",
                "task_created",
                {"task_id": task.id, "provider_id": provider_type.value},
            )
            orchestration_ms = max(0.0, (time.time() - orchestration_start) * 1000)
            provider_start = time.time()
            await self.service.start_task_execution(task.id)
            completed = await self.service.get_task(task.id)
            provider_execution_ms = max(0.0, (time.time() - provider_start) * 1000)
            if completed is None or completed.metadata.result is None:
                provider_result = TaskResult(
                    success=False,
                    summary="Missing provider result",
                    error="No provider result",
                )
            else:
                provider_result = completed.metadata.result
        else:
            orchestration_ms = 0.0
            provider_start = time.time()
            trace.add(
                "direct-shell",
                "provider_start",
                {"provider_id": provider_type.value},
            )

            async def append_output(_line: str) -> None:
                return None

            async def update_progress(_progress: int) -> None:
                return None

            async def update_step(_step_id: str, _status: object, _output: str | None) -> None:
                return None

            provider_result = await provider.execute_task(
                SimpleNamespace(
                    id=f"direct-{question.task_id}",
                    name=f"GAIA: {question.task_id}",
                    description=task_description,
                    metadata=SimpleNamespace(),
                    tags=[],
                    room_id=None,
                    world_id=None,
                ),
                SimpleNamespace(
                    runtime_agent_id=self.runtime.agent_id,
                    working_directory=self.config.files_dir or ".",
                    append_output=append_output,
                    update_progress=update_progress,
                    update_step=update_step,
                    is_cancelled=lambda: False,
                    is_paused=lambda: False,
                    room_id=None,
                    world_id=None,
                ),
            )
            provider_execution_ms = max(0.0, (time.time() - provider_start) * 1000)
            trace.add(
                "direct-shell",
                "provider_end",
                {
                    "provider_id": provider_type.value,
                    "success": provider_result.success,
                    "error": provider_result.error,
                },
            )

        predicted = str(provider_result.extra.get("predicted_answer") or "")
        token_usage = int(provider_result.extra.get("token_usage") or 0)
        latency_ms = float(provider_result.extra.get("latency_ms") or 0.0)
        tool_names_raw = provider_result.extra.get("tool_names")
        tool_names = (
            [str(name) for name in tool_names_raw]
            if isinstance(tool_names_raw, list)
            else []
        )
        observed = self._observed_capabilities(tool_names)
        if not self.config.strict_capabilities:
            violations.extend(sorted(set(required).difference(set(observed))))

        is_correct, norm_pred, norm_exp = self.evaluator.evaluate(
            predicted,
            question.final_answer,
        )
        gaia_result = GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=predicted,
            expected_answer=question.final_answer,
            is_correct=is_correct,
            tools_used=[],
            latency_ms=latency_ms,
            token_usage=token_usage,
            error=provider_result.error,
            normalized_predicted=norm_pred,
            normalized_expected=norm_exp,
        )

        trace.add(
            "orchestrator",
            "question_completed",
            {
                "is_correct": is_correct,
                "predicted_answer": predicted,
                "tool_names": tool_names,
                "token_usage": token_usage,
                "latency_ms": latency_ms,
                "error": provider_result.error,
            },
        )
        trace.set_capabilities(
            required=required,
            declared=declared,
            observed=observed,
            violations=sorted(set(violations)),
        )
        trace_file = trace.save() if self.config.save_trajectories else None

        return ProviderQuestionResult(
            provider=provider_type,
            task_id=question.task_id,
            gaia_result=gaia_result,
            control_plane_mode=mode,
            orchestration_time_ms=orchestration_ms,
            provider_execution_time_ms=provider_execution_ms,
            delegation_successful=provider_result.success,
            task_description_generated=task_description,
            declared_capabilities=declared,
            observed_capabilities=observed,
            capability_violations=sorted(set(violations)),
            trace_file=trace_file,
        )

    def _save_report(self, report: OrchestratedGAIAReport) -> None:
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_path = output_dir / f"gaia-orchestrated-{timestamp}.json"

        payload: dict[str, object] = {
            "metadata": {
                "timestamp": datetime.now().isoformat(),
                "dataset_source": self.config.dataset_source,
                "split": self.config.split,
                "providers": [p.value for p in self._provider_types()],
                "execution_mode": self.config.execution_mode,
                "matrix": bool(self.config.matrix),
                "required_capabilities": self._required_capabilities(),
                "strict_capabilities": bool(self.config.strict_capabilities),
                "model": self.config.model_name,
                "provider": self.config.provider,
            },
            "metrics": {
                "overall_accuracy": report.overall_accuracy,
                "provider_scores": {
                    provider_key: {
                        "accuracy": summary.accuracy,
                        "total_questions": summary.total_questions,
                        "correct_answers": summary.correct_answers,
                        "avg_latency_ms": summary.avg_latency_ms,
                        "avg_tokens": summary.avg_tokens,
                        "delegation_success_rate": summary.delegation_success_rate,
                        "capability_compliance_rate": summary.capability_compliance_rate,
                    }
                    for provider_key, summary in report.provider_summaries.items()
                },
            },
            "orchestrated": {},
            "matrix": {"execution_modes": [], "providers": [], "cells": {}},
        }

        orchestrated_block = payload["orchestrated"]
        if isinstance(orchestrated_block, dict):
            for provider_key, results in report.by_provider.items():
                orchestrated_block[provider_key] = {
                    "results": [
                        {
                            "task_id": result.task_id,
                            "is_correct": result.gaia_result.is_correct,
                            "predicted_answer": result.gaia_result.predicted_answer,
                            "expected_answer": result.gaia_result.expected_answer,
                            "latency_ms": result.gaia_result.latency_ms,
                            "token_usage": result.gaia_result.token_usage,
                            "delegation_successful": result.delegation_successful,
                            "control_plane_mode": result.control_plane_mode.value,
                            "declared_capabilities": result.declared_capabilities,
                            "observed_capabilities": result.observed_capabilities,
                            "capability_violations": result.capability_violations,
                            "trace_file": result.trace_file,
                        }
                        for result in results
                    ]
                }

        matrix_block = payload["matrix"]
        if isinstance(matrix_block, dict):
            matrix_block["execution_modes"] = list(report.matrix_results.keys())
            matrix_block["providers"] = [p.value for p in self._provider_types()]
            cells = matrix_block["cells"]
            if isinstance(cells, dict):
                for mode_key, mode_results in report.matrix_results.items():
                    for provider_key, results in mode_results.items():
                        count = len(results)
                        correct = sum(1 for r in results if r.gaia_result.is_correct)
                        cell_key = f"{mode_key}:{provider_key}"
                        cells[cell_key] = {
                            "mode": mode_key,
                            "provider": provider_key,
                            "total_questions": count,
                            "correct_answers": correct,
                            "accuracy": (correct / count) if count > 0 else 0.0,
                            "avg_latency_ms": (
                                sum(r.gaia_result.latency_ms for r in results) / count
                                if count > 0
                                else 0.0
                            ),
                            "capability_violations": sum(
                                1 for r in results if r.capability_violations
                            ),
                        }

        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        logger.info("Orchestrated GAIA report saved to %s", report_path)
