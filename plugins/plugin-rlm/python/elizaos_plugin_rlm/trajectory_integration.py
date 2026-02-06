"""
Integration with plugin-trajectory-logger for RLM trace capture.

Paper Section 4.1: "We select several examples of snippets from RLM trajectories
to understand how they solve long context problems"

This module provides:
- Conversion from RLM's internal trajectory format to elizaOS Trajectory format
- Automatic logging of RLM calls to the trajectory logger service
- Support for both standalone and integrated RLM usage
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import TYPE_CHECKING, Callable, List, Optional

from elizaos_plugin_rlm.client import (
    RLMClient,
    RLMConfig,
    RLMResult,
    RLMTrajectory,
    RLMTrajectoryStep,
)

if TYPE_CHECKING:
    from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
    from elizaos_plugin_trajectory_logger.types import (
        LLMCall,
        ProviderAccess,
        Trajectory,
    )

logger = logging.getLogger("elizaos.plugin-rlm.trajectory")


def convert_rlm_step_to_llm_call(
    step: RLMTrajectoryStep,
    *,
    model: str = "rlm",
    model_version: str = "1.0",
) -> "LLMCall":
    """
    Convert an RLM trajectory step to an LLMCall for the trajectory logger.
    
    Paper Algorithm 1: REPL state is captured in step data
    """
    # Import here to avoid circular imports
    from elizaos_plugin_trajectory_logger.types import LLMCall
    
    return LLMCall(
        call_id=step.step_id,
        timestamp=step.timestamp_ms,
        model=model,
        model_version=model_version,
        system_prompt="RLM recursive inference",
        user_prompt=step.code_executed,
        messages=None,
        response=step.repl_output,
        reasoning=f"Strategy: {step.strategy}" if step.strategy else None,
        temperature=0.0,
        max_tokens=0,
        top_p=None,
        prompt_tokens=step.input_tokens,
        completion_tokens=step.output_tokens,
        latency_ms=step.duration_ms,
        purpose="reasoning" if step.is_subcall else "action",
        action_type=step.strategy or "rlm_step",
    )


def convert_rlm_trajectory_to_provider_access(
    trajectory: RLMTrajectory,
) -> "ProviderAccess":
    """
    Convert an RLM trajectory to a ProviderAccess record.
    
    This captures the RLM call as a provider access for the trajectory logger.
    """
    from elizaos_plugin_trajectory_logger.types import ProviderAccess
    
    return ProviderAccess(
        provider_id="rlm",
        provider_name="Recursive Language Model",
        timestamp=trajectory.start_time_ms,
        query={
            "prompt_length": trajectory.prompt_length,
            "prompt_preview": trajectory.prompt_preview,
        },
        data={
            "trajectory_id": trajectory.trajectory_id,
            "total_iterations": trajectory.total_iterations,
            "subcall_count": trajectory.subcall_count,
            "max_depth": trajectory.max_depth_reached,
            "strategies_used": trajectory.strategies_used,
            "duration_ms": trajectory.duration_ms,
            "cost": trajectory.cost.to_dict() if trajectory.cost else None,
        },
        purpose="rlm_inference",
    )


class RLMTrajectoryIntegration:
    """
    Integration layer between RLM and the elizaOS trajectory logger.
    
    This class wraps an RLMClient and automatically logs RLM trajectories
    to the trajectory logger service for observability and training data.
    
    Example:
        >>> from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
        >>> logger_service = TrajectoryLoggerService()
        >>> integration = RLMTrajectoryIntegration(logger_service)
        >>> result = await integration.infer("Long context...")
        >>> # Trajectories are automatically logged to logger_service
    """
    
    def __init__(
        self,
        trajectory_logger: "TrajectoryLoggerService",
        rlm_config: Optional[RLMConfig] = None,
        *,
        agent_id: str = "rlm-agent",
        scenario_id: Optional[str] = None,
    ) -> None:
        """
        Initialize the RLM trajectory integration.
        
        Args:
            trajectory_logger: The trajectory logger service instance
            rlm_config: Optional RLM configuration
            agent_id: Agent ID for trajectory logging
            scenario_id: Optional scenario ID for grouping trajectories
        """
        # Force trajectory logging on
        config = rlm_config or RLMConfig()
        config.log_trajectories = True
        config.track_costs = True
        
        self._client = RLMClient(config)
        self._logger = trajectory_logger
        self._agent_id = agent_id
        self._scenario_id = scenario_id
        
        # Callbacks for custom handling
        self._on_trajectory_complete: Optional[
            Callable[[RLMTrajectory], None]
        ] = None
    
    @property
    def client(self) -> RLMClient:
        """Get the underlying RLM client."""
        return self._client
    
    @property
    def is_available(self) -> bool:
        """Check if the RLM backend is available."""
        return self._client.is_available
    
    def on_trajectory_complete(
        self, callback: Callable[[RLMTrajectory], None]
    ) -> None:
        """Register a callback for when trajectories complete."""
        self._on_trajectory_complete = callback
    
    async def infer(
        self,
        messages: str | List[dict[str, str]],
        *,
        episode_id: Optional[str] = None,
        metadata: Optional[dict[str, object]] = None,
    ) -> RLMResult:
        """
        Perform RLM inference with automatic trajectory logging.
        
        Args:
            messages: Input prompt or message list
            episode_id: Optional episode ID for trajectory grouping
            metadata: Optional metadata to attach to trajectory
            
        Returns:
            RLMResult with trajectory attached
        """
        # Start trajectory in logger
        trajectory_id = self._logger.start_trajectory(
            agent_id=self._agent_id,
            scenario_id=self._scenario_id,
            episode_id=episode_id,
            metadata=metadata or {},
        )
        
        try:
            # Run inference
            result = await self._client.infer_with_trajectory(messages)
            
            # Log RLM trajectory to the trajectory logger
            if result.trajectory:
                self._log_rlm_trajectory(trajectory_id, result.trajectory)
                
                # Fire callback if registered
                if self._on_trajectory_complete:
                    self._on_trajectory_complete(result.trajectory)
            
            # End trajectory
            await self._logger.end_trajectory(
                trajectory_id,
                status="completed" if not result.error else "error",
                final_metrics={
                    "rlm_iterations": result.iterations or 0,
                    "rlm_depth": result.depth or 0,
                    "rlm_cost_usd": result.cost.total_cost_usd if result.cost else 0.0,
                },
            )
            
            return result
            
        except Exception as e:
            # End trajectory with error status
            await self._logger.end_trajectory(
                trajectory_id,
                status="error",
                final_metrics={"error": str(e)},
            )
            raise
    
    def _log_rlm_trajectory(
        self,
        trajectory_id: str,
        rlm_trajectory: RLMTrajectory,
    ) -> None:
        """Log RLM trajectory steps to the trajectory logger."""
        from elizaos_plugin_trajectory_logger.types import (
            ActionAttempt,
            EnvironmentState,
        )
        
        # Log each RLM step as a trajectory step with LLM call
        for step in rlm_trajectory.steps:
            # Create environment state
            env_state = EnvironmentState(
                timestamp=step.timestamp_ms,
                agent_balance=0.0,
                agent_points=0.0,
                agent_pnl=0.0,
                open_positions=0,
                custom={
                    "rlm_strategy": step.strategy,
                    "rlm_is_subcall": step.is_subcall,
                    "rlm_variables_updated": step.variables_updated,
                },
            )
            
            # Start step
            step_id = self._logger.start_step(trajectory_id, env_state)
            
            # Log LLM call
            llm_call = convert_rlm_step_to_llm_call(
                step,
                model=self._client.config.backend,
                model_version=self._client.config.root_model or "default",
            )
            self._logger.log_llm_call(step_id, llm_call)
            
            # Complete step
            action = ActionAttempt(
                attempt_id=step.step_id,
                timestamp=step.timestamp_ms,
                action_type="rlm_step",
                action_name=step.strategy or "execute",
                parameters={
                    "code": step.code_executed,
                    "is_subcall": step.is_subcall,
                },
                reasoning=f"RLM strategy: {step.strategy}",
                llm_call_id=step.step_id,
                success=True,
                result={"output": step.repl_output[:500] if step.repl_output else ""},
            )
            
            self._logger.complete_step(
                trajectory_id,
                step_id,
                action=action,
                reward=0.0,  # RLM doesn't have explicit rewards
            )
        
        # Also log as provider access for summary view
        access = convert_rlm_trajectory_to_provider_access(rlm_trajectory)
        
        # Get current step to attach provider access
        current_step = self._logger.get_current_step_id(trajectory_id)
        if current_step:
            self._logger.log_provider_access(current_step, access)
    
    def get_cost_summary(self) -> dict[str, object]:
        """Get aggregate cost summary from the RLM client."""
        return self._client.get_cost_summary()
    
    def export_rlm_trajectories(self) -> List[dict[str, object]]:
        """Export all RLM trajectories."""
        return self._client.export_trajectories()
    
    async def close(self) -> None:
        """Clean up resources."""
        await self._client.close()


# Convenience function for one-off RLM calls with logging
async def infer_with_logging(
    trajectory_logger: "TrajectoryLoggerService",
    prompt: str,
    *,
    rlm_config: Optional[RLMConfig] = None,
    agent_id: str = "rlm-agent",
) -> RLMResult:
    """
    Convenience function for one-off RLM inference with trajectory logging.
    
    Args:
        trajectory_logger: The trajectory logger service
        prompt: The prompt to process
        rlm_config: Optional RLM configuration
        agent_id: Agent ID for logging
        
    Returns:
        RLMResult with trajectory attached
    """
    integration = RLMTrajectoryIntegration(
        trajectory_logger,
        rlm_config,
        agent_id=agent_id,
    )
    
    try:
        return await integration.infer(prompt)
    finally:
        await integration.close()
