from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


@dataclass
class TrajectoryProviderAccess:
    step_id: str
    provider_name: str
    purpose: str
    data: dict[str, str | int | float | bool | None] = field(default_factory=dict)
    query: dict[str, str | int | float | bool | None] | None = None
    timestamp_ms: int = 0


@dataclass
class TrajectoryLlmCall:
    step_id: str
    model: str
    system_prompt: str
    user_prompt: str
    response: str
    purpose: str
    action_type: str | None = None
    model_version: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048
    top_p: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None
    reasoning: str | None = None
    timestamp_ms: int = 0


class TrajectoriesService(Service):
    name = "trajectories"
    service_type = ServiceType.TRAJECTORIES

    @property
    def capability_description(self) -> str:
        return "Trajectory logging service for provider and model execution traces"

    def __init__(self) -> None:
        super().__init__()
        self._provider_access: list[TrajectoryProviderAccess] = []
        self._llm_calls: list[TrajectoryLlmCall] = []

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TrajectoriesService:
        service = cls()
        service.runtime = runtime
        runtime.logger.info(
            "Trajectories service started",
            src="service:trajectories",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        self.runtime.logger.info(
            "Trajectories service stopped",
            src="service:trajectories",
            agentId=str(self.runtime.agent_id),
        )
        self.clear_logs()

    def log_provider_access(
        self,
        *,
        step_id: str,
        provider_name: str,
        data: dict[str, str | int | float | bool | None],
        purpose: str,
        query: dict[str, str | int | float | bool | None] | None = None,
    ) -> None:
        self._provider_access.append(
            TrajectoryProviderAccess(
                step_id=step_id,
                provider_name=provider_name,
                purpose=purpose,
                data=dict(data),
                query=dict(query) if query is not None else None,
                timestamp_ms=self.runtime.get_current_time_ms(),
            )
        )

    def log_llm_call(
        self,
        *,
        step_id: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        response: str,
        purpose: str,
        action_type: str | None = None,
        model_version: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        top_p: float | None = None,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        latency_ms: int | None = None,
        reasoning: str | None = None,
    ) -> str:
        entry = TrajectoryLlmCall(
            step_id=step_id,
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response=response,
            purpose=purpose,
            action_type=action_type,
            model_version=model_version,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            reasoning=reasoning,
            timestamp_ms=self.runtime.get_current_time_ms(),
        )
        self._llm_calls.append(entry)
        return step_id

    def get_logs(self) -> dict[str, list[dict[str, object | None]]]:
        return {
            "provider_access": [asdict(entry) for entry in self._provider_access],
            "llm_calls": [asdict(entry) for entry in self._llm_calls],
        }

    def clear_logs(self) -> None:
        self._provider_access.clear()
        self._llm_calls.clear()
