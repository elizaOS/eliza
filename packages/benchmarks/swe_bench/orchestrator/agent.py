"""
Orchestrating agent for SWE-bench.

Uses the actual Python agent-orchestrator service and records a full trace
of orchestration + provider execution so runs are fully auditable.
"""

from __future__ import annotations

import logging
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING

from elizaos_plugin_agent_orchestrator import (
    AgentOrchestratorPluginOptions,
    AgentOrchestratorService,
    TaskEvent,
    TaskResult,
    configure_agent_orchestrator_plugin,
)

from ..repo_manager import RepositoryManager
from ..types import PatchStatus, SWEBenchInstance, SWEBenchResult
from .providers import (
    BaseSWEBenchProvider,
    ClaudeCodeProvider,
    CodexProvider,
    ElizaCodeProvider,
    SWEAgentProvider,
)
from .trace import RunTraceRecorder
from .types import (
    ExecutionMode,
    OrchestratedBenchmarkConfig,
    ProviderBenchmarkResult,
    ProviderType,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class OrchestratingAgent:
    """
    Orchestrates SWE-bench tasks through sub-agent providers.

    Flow:
    1. Analyze issue and generate a provider task description
    2. Create task via AgentOrchestratorService
    3. Execute provider via orchestrator lifecycle
    4. Persist full trace (requests/responses/actions/tool outputs/events)
    """

    def __init__(
        self,
        runtime: AgentRuntime,
        repo_manager: RepositoryManager,
        config: OrchestratedBenchmarkConfig,
    ) -> None:
        self.runtime = runtime
        self.repo_manager = repo_manager
        self.config = config
        self._providers: dict[str, BaseSWEBenchProvider] = {}
        self._service: AgentOrchestratorService | None = None

    async def initialize(self) -> None:
        """Initialize providers and orchestrator service."""
        for provider_type in self.config.providers:
            provider = self._create_provider(provider_type)
            self._providers[provider_type.value] = provider

        if not self._providers:
            raise ValueError("No providers configured")

        provider_list = list(self._providers.values())
        default_provider = provider_list[0]
        configure_agent_orchestrator_plugin(
            AgentOrchestratorPluginOptions(
                providers=provider_list,
                default_provider_id=default_provider.id,
                get_working_directory=lambda: self.config.workspace_dir,
            )
        )
        self._service = await AgentOrchestratorService.start(self.runtime)

        logger.info(
            "Orchestrating agent initialized with providers: %s",
            [provider.id for provider in provider_list],
        )

    def _create_provider(self, provider_type: ProviderType) -> BaseSWEBenchProvider:
        """Create a provider instance for the given type."""
        if provider_type == ProviderType.CLAUDE_CODE:
            model = self.config.provider_models.get("claude-code", "claude-sonnet-4-20250514")
            return ClaudeCodeProvider(
                repo_manager=self.repo_manager,
                max_steps=self.config.provider_max_steps,
                model=model,
                api_key=self.config.anthropic_api_key,
            )
        if provider_type == ProviderType.SWE_AGENT:
            model = self.config.provider_models.get("swe-agent", self.config.model_name)
            return SWEAgentProvider(
                runtime=self.runtime,
                repo_manager=self.repo_manager,
                max_steps=self.config.provider_max_steps,
                model=model,
            )
        if provider_type == ProviderType.CODEX:
            model = self.config.provider_models.get("codex", self.config.model_name)
            return CodexProvider(
                runtime=self.runtime,
                repo_manager=self.repo_manager,
                max_steps=self.config.provider_max_steps,
                model=model,
            )
        if provider_type == ProviderType.ELIZA_CODE:
            model = self.config.provider_models.get("eliza-code", self.config.model_name)
            return ElizaCodeProvider(
                runtime=self.runtime,
                repo_manager=self.repo_manager,
                max_steps=self.config.provider_max_steps,
                model=model,
            )
        raise ValueError(f"Unknown provider type: {provider_type}")

    def _capability_for_tool(self, tool_name: str) -> str | None:
        normalized = tool_name.upper().strip()
        mapping = {
            "SEARCH_CODE": "code.search",
            "READ_FILE": "code.read",
            "LIST_FILES": "code.read",
            "EDIT_FILE": "code.edit",
            "SHELL": "code.shell",
            "SUBMIT": "code.write",
        }
        return mapping.get(normalized)

    def _observed_capabilities_from_trace(self, trace: RunTraceRecorder) -> list[str]:
        observed: set[str] = set()
        for event in trace.events:
            if event.event not in {"tool_call", "tool_result"}:
                continue
            tool_name = event.data.get("tool_name")
            if tool_name is None:
                tool_name = event.data.get("action")
            if not isinstance(tool_name, str):
                continue
            capability = self._capability_for_tool(tool_name)
            if capability:
                observed.add(capability)
        return sorted(observed)

    def _build_direct_task_description(self, instance: SWEBenchInstance) -> str:
        parts = [
            f"Repository: {instance.repo}",
            "",
            "Issue:",
            instance.problem_statement,
        ]
        if instance.hints_text:
            parts.extend(["", "Hints:", instance.hints_text])
        parts.extend(
            [
                "",
                "Fix the source code (not tests), then submit.",
            ]
        )
        return "\n".join(parts).strip()

    async def execute_instance(
        self,
        instance: SWEBenchInstance,
        provider_type: ProviderType,
        mode: ExecutionMode | None = None,
    ) -> ProviderBenchmarkResult:
        selected_mode = mode or self.config.execution_mode
        if selected_mode == ExecutionMode.DIRECT_SHELL:
            return await self.direct_execute_instance(instance, provider_type)
        return await self.orchestrate_instance(instance, provider_type)

    async def orchestrate_instance(
        self,
        instance: SWEBenchInstance,
        provider_type: ProviderType,
    ) -> ProviderBenchmarkResult:
        """Orchestrate a single SWE-bench instance through the selected provider."""
        if self._service is None:
            raise RuntimeError("Agent not initialized. Call initialize() first.")

        start_time = time.time()
        provider = self._providers.get(provider_type.value)
        if provider is None:
            raise ValueError(f"Provider not configured: {provider_type.value}")

        declared_capabilities = list(provider.capabilities)
        required_capabilities = list(self.config.required_capabilities)
        capability_violations = [
            cap for cap in required_capabilities if cap not in declared_capabilities
        ]

        trace_output_dir = self.config.trace_dir or f"{self.config.output_dir}/traces"
        trace = RunTraceRecorder(
            instance_id=instance.instance_id,
            provider_id=provider_type.value,
            output_dir=trace_output_dir,
        )
        trace.add(
            actor="orchestrator",
            event="instance_start",
            data={
                "provider": provider_type.value,
                "control_plane_mode": ExecutionMode.ORCHESTRATED.value,
                "repo": instance.repo,
                "base_commit": instance.base_commit,
            },
        )
        trace.add(
            actor="orchestrator",
            event=(
                "capability_preflight_fail"
                if capability_violations
                else "capability_preflight_pass"
            ),
            data={
                "required_capabilities": required_capabilities,
                "declared_capabilities": declared_capabilities,
                "violations": capability_violations,
                "strict": self.config.strict_capabilities,
            },
        )

        if capability_violations and self.config.strict_capabilities:
            trace_file: str | None = None
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=[],
                violations=capability_violations,
            )
            if self.config.save_full_trace:
                trace_file = trace.save()
            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.ORCHESTRATED,
                swe_result=SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch="",
                    patch_status=PatchStatus.NOT_GENERATED,
                    tests_passed=[],
                    tests_failed=[],
                    success=False,
                    duration_seconds=max(0.0, time.time() - start_time),
                    tokens_used=0,
                    error=(
                        "Missing required capabilities: "
                        + ", ".join(capability_violations)
                    ),
                ),
                orchestration_time_seconds=0.0,
                task_description_generated="",
                delegation_successful=False,
                provider_execution_time_seconds=0.0,
                declared_capabilities=declared_capabilities,
                observed_capabilities=[],
                capability_violations=capability_violations,
                trace_file=trace_file,
            )

        async def provider_trace_hook(actor: str, event: str, data: dict[str, object]) -> None:
            await trace.add_async(actor=actor, event=event, data=data)

        provider.set_trace_hook(provider_trace_hook)

        try:
            await self.repo_manager.setup_repo(instance)
            trace.add(
                actor="orchestrator",
                event="repo_ready",
                data={"workspace_dir": self.config.workspace_dir},
            )

            orchestration_start = time.time()
            task_description, orchestrator_token_estimate = (
                await self._analyze_and_create_task_description(instance, trace)
            )

            task = await self._service.create_task(
                name=f"Fix: {instance.instance_id}",
                description=task_description,
                provider_id=provider_type.value,
            )
            trace.add(
                actor="orchestrator",
                event="task_created",
                data={
                    "task_id": task.id,
                    "task_name": task.name,
                    "provider_id": provider_type.value,
                },
            )
            orchestration_time = max(0.0, time.time() - orchestration_start)

            def on_task_event(event: TaskEvent) -> None:
                if event.task_id != task.id:
                    return
                payload: dict[str, object] = {}
                if event.data:
                    payload = {str(key): value for key, value in event.data.items()}
                trace.add(
                    actor="orchestrator-service",
                    event=event.type.value,
                    data=payload,
                )

            self._service.on("task", on_task_event)
            provider_execution_start = time.time()
            try:
                execution = self._service.start_task_execution(task.id)
                await execution
            finally:
                self._service.off("task", on_task_event)
            provider_execution_time = max(0.0, time.time() - provider_execution_start)

            completed_task = await self._service.get_task(task.id)
            if completed_task is None:
                raise RuntimeError("Task disappeared before completion")

            provider_result: TaskResult
            if completed_task.metadata.result is None:
                provider_result = TaskResult(
                    success=False,
                    summary="Orchestrator task completed without provider result",
                    error=completed_task.metadata.error or "Missing provider result",
                )
            else:
                provider_result = completed_task.metadata.result

            generated_patch = await self.repo_manager.get_diff()
            total_time = time.time() - start_time

            provider_tokens = 0
            extra_tokens = provider_result.extra.get("estimated_tokens")
            if isinstance(extra_tokens, int):
                provider_tokens = extra_tokens
            elif isinstance(extra_tokens, float):
                provider_tokens = int(extra_tokens)

            swe_result = SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=generated_patch,
                patch_status=(
                    PatchStatus.GENERATED
                    if generated_patch.strip()
                    else PatchStatus.NOT_GENERATED
                ),
                tests_passed=[],
                tests_failed=[],
                success=False,  # Evaluator decides final success
                duration_seconds=total_time,
                tokens_used=max(0, orchestrator_token_estimate + provider_tokens),
                error=provider_result.error,
            )

            trace.add(
                actor="orchestrator",
                event="instance_end",
                data={
                    "duration_seconds": total_time,
                    "provider_success": provider_result.success,
                    "patch_bytes": len(generated_patch.encode("utf-8", errors="replace")),
                    "provider_error": provider_result.error,
                },
            )

            trace_file: str | None = None
            observed_capabilities = self._observed_capabilities_from_trace(trace)
            if not self.config.strict_capabilities:
                capability_violations.extend(
                    sorted(
                        set(required_capabilities).difference(
                            set(observed_capabilities)
                        )
                    )
                )
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=observed_capabilities,
                violations=sorted(set(capability_violations)),
            )
            if self.config.save_full_trace:
                trace_file = trace.save()

            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.ORCHESTRATED,
                swe_result=swe_result,
                orchestration_time_seconds=orchestration_time,
                task_description_generated=task_description,
                delegation_successful=provider_result.success,
                provider_execution_time_seconds=provider_execution_time,
                declared_capabilities=declared_capabilities,
                observed_capabilities=observed_capabilities,
                capability_violations=sorted(set(capability_violations)),
                trace_file=trace_file,
            )
        except Exception as e:
            trace.add(
                actor="orchestrator",
                event="instance_exception",
                data={"error": str(e)},
            )
            trace_file: str | None = None
            observed_capabilities = self._observed_capabilities_from_trace(trace)
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=observed_capabilities,
                violations=sorted(set(capability_violations)),
            )
            if self.config.save_full_trace:
                trace_file = trace.save()

            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.ORCHESTRATED,
                swe_result=SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch="",
                    patch_status=PatchStatus.NOT_GENERATED,
                    tests_passed=[],
                    tests_failed=[],
                    success=False,
                    duration_seconds=max(0.0, time.time() - start_time),
                    tokens_used=0,
                    error=str(e),
                ),
                orchestration_time_seconds=0.0,
                task_description_generated="",
                delegation_successful=False,
                provider_execution_time_seconds=max(0.0, time.time() - start_time),
                declared_capabilities=declared_capabilities,
                observed_capabilities=observed_capabilities,
                capability_violations=sorted(set(capability_violations)),
                trace_file=trace_file,
            )
        finally:
            provider.set_trace_hook(None)

    async def direct_execute_instance(
        self,
        instance: SWEBenchInstance,
        provider_type: ProviderType,
    ) -> ProviderBenchmarkResult:
        """Execute a single instance directly through provider (no orchestrator service)."""
        start_time = time.time()
        provider = self._providers.get(provider_type.value)
        if provider is None:
            raise ValueError(f"Provider not configured: {provider_type.value}")

        declared_capabilities = list(provider.capabilities)
        required_capabilities = list(self.config.required_capabilities)
        capability_violations = [
            cap for cap in required_capabilities if cap not in declared_capabilities
        ]

        trace_output_dir = self.config.trace_dir or f"{self.config.output_dir}/traces"
        trace = RunTraceRecorder(
            instance_id=instance.instance_id,
            provider_id=provider_type.value,
            output_dir=trace_output_dir,
        )
        trace.add(
            actor="orchestrator",
            event="instance_start",
            data={
                "provider": provider_type.value,
                "control_plane_mode": ExecutionMode.DIRECT_SHELL.value,
                "repo": instance.repo,
                "base_commit": instance.base_commit,
            },
        )
        trace.add(
            actor="orchestrator",
            event=(
                "capability_preflight_fail"
                if capability_violations
                else "capability_preflight_pass"
            ),
            data={
                "required_capabilities": required_capabilities,
                "declared_capabilities": declared_capabilities,
                "violations": capability_violations,
                "strict": self.config.strict_capabilities,
            },
        )

        if capability_violations and self.config.strict_capabilities:
            trace_file: str | None = None
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=[],
                violations=capability_violations,
            )
            if self.config.save_full_trace:
                trace_file = trace.save()
            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.DIRECT_SHELL,
                swe_result=SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch="",
                    patch_status=PatchStatus.NOT_GENERATED,
                    tests_passed=[],
                    tests_failed=[],
                    success=False,
                    duration_seconds=max(0.0, time.time() - start_time),
                    tokens_used=0,
                    error=(
                        "Missing required capabilities: "
                        + ", ".join(capability_violations)
                    ),
                ),
                orchestration_time_seconds=0.0,
                task_description_generated="",
                delegation_successful=False,
                provider_execution_time_seconds=0.0,
                declared_capabilities=declared_capabilities,
                observed_capabilities=[],
                capability_violations=capability_violations,
                trace_file=trace_file,
            )

        async def provider_trace_hook(actor: str, event: str, data: dict[str, object]) -> None:
            await trace.add_async(actor=actor, event=event, data=data)

        provider.set_trace_hook(provider_trace_hook)
        try:
            await self.repo_manager.setup_repo(instance)
            trace.add(
                actor="orchestrator",
                event="repo_ready",
                data={"workspace_dir": self.config.workspace_dir},
            )

            task_description = self._build_direct_task_description(instance)
            orchestrator_token_estimate = len(task_description.split())

            output_lines: list[str] = []
            progress = 0

            async def append_output(line: str) -> None:
                output_lines.append(line)
                await trace.add_async(
                    actor="direct-shell",
                    event="provider_output",
                    data={"line": line},
                )

            async def update_progress(value: int) -> None:
                nonlocal progress
                progress = value
                await trace.add_async(
                    actor="direct-shell",
                    event="provider_progress",
                    data={"progress": value},
                )

            async def update_step(
                _step_id: str,
                _status: object,
                _output: str | None,
            ) -> None:
                return None

            ctx = SimpleNamespace(
                runtime_agent_id=str(self.runtime.agent_id),
                working_directory=self.config.workspace_dir,
                append_output=append_output,
                update_progress=update_progress,
                update_step=update_step,
                is_cancelled=lambda: False,
                is_paused=lambda: False,
                room_id=None,
                world_id=None,
            )

            provider_execution_start = time.time()
            provider_result = await provider.execute_task(
                SimpleNamespace(
                    id=f"direct-{instance.instance_id}",
                    name=f"Fix: {instance.instance_id}",
                    description=task_description,
                    metadata=SimpleNamespace(),
                    tags=[],
                    room_id=None,
                    world_id=None,
                ),
                ctx,
            )
            provider_execution_time = max(0.0, time.time() - provider_execution_start)

            generated_patch = await self.repo_manager.get_diff()
            total_time = time.time() - start_time

            provider_tokens = 0
            extra_tokens = provider_result.extra.get("estimated_tokens")
            if isinstance(extra_tokens, int):
                provider_tokens = extra_tokens
            elif isinstance(extra_tokens, float):
                provider_tokens = int(extra_tokens)

            swe_result = SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=generated_patch,
                patch_status=(
                    PatchStatus.GENERATED
                    if generated_patch.strip()
                    else PatchStatus.NOT_GENERATED
                ),
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=total_time,
                tokens_used=max(0, orchestrator_token_estimate + provider_tokens),
                error=provider_result.error,
            )

            trace.add(
                actor="orchestrator",
                event="instance_end",
                data={
                    "duration_seconds": total_time,
                    "provider_success": provider_result.success,
                    "patch_bytes": len(generated_patch.encode("utf-8", errors="replace")),
                    "provider_error": provider_result.error,
                    "progress": progress,
                },
            )

            trace_file: str | None = None
            observed_capabilities = self._observed_capabilities_from_trace(trace)
            if not self.config.strict_capabilities:
                capability_violations.extend(
                    sorted(
                        set(required_capabilities).difference(
                            set(observed_capabilities)
                        )
                    )
                )
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=observed_capabilities,
                violations=sorted(set(capability_violations)),
            )
            if self.config.save_full_trace:
                trace_file = trace.save()

            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.DIRECT_SHELL,
                swe_result=swe_result,
                orchestration_time_seconds=0.0,
                task_description_generated=task_description,
                delegation_successful=provider_result.success,
                provider_execution_time_seconds=provider_execution_time,
                declared_capabilities=declared_capabilities,
                observed_capabilities=observed_capabilities,
                capability_violations=sorted(set(capability_violations)),
                trace_file=trace_file,
            )
        except Exception as e:
            trace.add(
                actor="orchestrator",
                event="instance_exception",
                data={"error": str(e)},
            )
            trace_file: str | None = None
            observed_capabilities = self._observed_capabilities_from_trace(trace)
            trace.set_capability_evidence(
                required=required_capabilities,
                declared=declared_capabilities,
                observed=observed_capabilities,
                violations=sorted(set(capability_violations)),
            )
            if self.config.save_full_trace:
                trace_file = trace.save()
            return ProviderBenchmarkResult(
                provider=provider_type,
                instance_id=instance.instance_id,
                control_plane_mode=ExecutionMode.DIRECT_SHELL,
                swe_result=SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch="",
                    patch_status=PatchStatus.NOT_GENERATED,
                    tests_passed=[],
                    tests_failed=[],
                    success=False,
                    duration_seconds=max(0.0, time.time() - start_time),
                    tokens_used=0,
                    error=str(e),
                ),
                orchestration_time_seconds=0.0,
                task_description_generated="",
                delegation_successful=False,
                provider_execution_time_seconds=max(0.0, time.time() - start_time),
                declared_capabilities=declared_capabilities,
                observed_capabilities=observed_capabilities,
                capability_violations=sorted(set(capability_violations)),
                trace_file=trace_file,
            )
        finally:
            provider.set_trace_hook(None)

    async def _analyze_and_create_task_description(
        self,
        instance: SWEBenchInstance,
        trace: RunTraceRecorder,
    ) -> tuple[str, int]:
        """
        Use the orchestration model to generate an actionable provider task.

        By default this fails hard when orchestration model execution fails,
        so a run cannot silently degrade into non-orchestrated behavior.
        """
        from elizaos.types.model import ModelType

        system_prompt = (
            "You are an expert software engineering manager. Your job is to analyze "
            "a GitHub issue and create a clear, actionable task description for a "
            "coding agent. The coding agent will use this description to fix the bug.\n\n"
            "Your task description should include:\n"
            "1. A clear summary of the problem\n"
            "2. The likely root cause (if you can determine it)\n"
            "3. Which files are most likely affected\n"
            "4. Step-by-step instructions for fixing the issue\n"
            "5. How to verify the fix works\n\n"
            "CRITICAL: The coding agent MUST edit the actual source code to fix the bug. "
            "The agent should NOT just create test scripts or reproduction scripts. "
            "Focus on identifying the specific line(s) of code that need to change "
            "and provide concrete guidance on what the fix should be.\n\n"
            "Be specific and actionable. The coding agent only has access to "
            "search, read, edit, list files, shell, and submit tools."
        )

        prompt = (
            f"## Repository: {instance.repo}\n\n"
            f"## Issue Description\n{instance.problem_statement}\n\n"
        )
        if instance.hints_text:
            prompt += f"## Hints\n{instance.hints_text}\n\n"
        prompt += (
            "Please analyze this issue and create a structured task description "
            "for the coding agent to follow."
        )

        trace.add(
            actor="orchestrator",
            event="analysis_request",
            data={"prompt": prompt, "system_prompt": system_prompt},
        )

        try:
            response = await self.runtime.use_model(
                ModelType.TEXT_LARGE,
                {
                    "prompt": prompt,
                    "system": system_prompt,
                    "temperature": 0.2,
                    "maxTokens": 2000,
                    "model_name": self.config.orchestrator_model,
                },
            )
        except Exception as e:
            if not self.config.allow_task_description_fallback:
                raise RuntimeError(f"Orchestrator model failed: {e}") from e
            fallback = f"Fix this issue in {instance.repo}:\n\n{instance.problem_statement}"
            trace.add(
                actor="orchestrator",
                event="analysis_fallback",
                data={"error": str(e), "fallback_description": fallback},
            )
            token_estimate = len(system_prompt.split()) + len(prompt.split()) + len(
                fallback.split()
            )
            return fallback, token_estimate

        task_description = str(response).strip() if response is not None else ""
        if not task_description:
            raise RuntimeError("Orchestrator model returned an empty task description")

        trace.add(
            actor="orchestrator",
            event="analysis_response",
            data={"task_description": task_description},
        )
        token_estimate = len(system_prompt.split()) + len(prompt.split()) + len(
            task_description.split()
        )
        return task_description, token_estimate
