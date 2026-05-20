"""
Babylon Fast Rollout Generator

Generates high-quality rollouts at maximum speed for RL training.
Captures the COMPLETE agent tick including all thinking, planning, and execution.

A complete agent tick consists of:
1. Environment Observation - What the agent sees
2. Thinking/Reasoning - Internal deliberation
3. Planning - What actions to take
4. Action Execution - The actual action
5. Feedback - Result and reward

We need to capture ALL of this for training.
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from ..models import (
    Action,
    BabylonTrajectory,
    EnvironmentState,
    LLMCall,
)
from .quality_utils import (
    build_trajectory_from_ticks,
    calculate_detailed_tick_quality,
    calculate_trajectory_quality_score,
    state_to_env_state,
    state_to_observation,
)
from .rewards import TrajectoryRewardInputs, calculate_risk_reward, composite_reward

logger = logging.getLogger(__name__)


@dataclass
class AgentTickData:
    """
    Complete data for a single agent tick.

    This captures EVERYTHING the agent does in one tick:
    - All observations received
    - All LLM calls made (thinking, planning, action)
    - The final action taken
    - Feedback received
    """

    tick_number: int
    timestamp: int

    # Environment observation
    observation: dict
    environment_state: EnvironmentState

    # All LLM calls during this tick
    llm_calls: list[LLMCall] = field(default_factory=list)

    # The reasoning chain (concatenated thinking)
    reasoning_chain: str = ""

    # Final action
    action: Action | None = None

    # Feedback from environment
    feedback: dict = field(default_factory=dict)
    reward: float = 0.0

    def get_full_context(self) -> str:
        """Get the complete context string for this tick"""
        parts = []

        # Observation
        parts.append(f"=== OBSERVATION (Tick {self.tick_number}) ===")
        parts.append(json.dumps(self.observation, indent=2))

        # All LLM calls in order
        for i, call in enumerate(self.llm_calls, 1):
            parts.append(f"\n=== LLM CALL {i} ({call.purpose}) ===")
            parts.append(f"System: {call.system_prompt}")
            parts.append(f"User: {call.user_prompt}")
            parts.append(f"Response: {call.response}")
            if call.reasoning:
                parts.append(f"Reasoning: {call.reasoning}")

        # Action
        if self.action:
            parts.append("\n=== ACTION ===")
            parts.append(f"Type: {self.action.action_type}")
            parts.append(f"Parameters: {json.dumps(self.action.parameters)}")
            if self.action.reasoning:
                parts.append(f"Reasoning: {self.action.reasoning}")

        # Feedback
        if self.feedback:
            parts.append("\n=== FEEDBACK ===")
            parts.append(json.dumps(self.feedback, indent=2))
            parts.append(f"Reward: {self.reward}")

        return "\n".join(parts)


@dataclass
class RolloutConfig:
    """Configuration for rollout generation"""

    # Speed settings
    fast_forward: bool = True
    parallel_agents: int = 4
    max_ticks_per_agent: int = 100

    # Quality settings
    min_llm_calls_per_tick: int = 1
    require_action: bool = True

    # Database settings
    database_url: str = ""


@dataclass
class RolloutResult:
    """Result of a rollout generation run"""

    agent_id: str
    trajectory_id: str
    ticks_completed: int
    total_duration_ms: int
    avg_tick_duration_ms: float
    total_llm_calls: int
    total_reward: float
    final_pnl: float
    quality_score: float  # 0-1 based on completeness
    trajectory: BabylonTrajectory | None = None


class AgentRunner(Protocol):
    """Protocol for agent implementations - consistent with FastSimulator"""

    async def run_tick(
        self,
        agent_id: str,
        observation: dict,
        env_state: EnvironmentState,
    ) -> AgentTickData:
        """Run a single tick and return complete tick data"""
        ...


class FastRolloutGenerator:
    """
    Generates rollouts at maximum speed while maintaining quality.

    Key features:
    - Fast-forward mode skips all waiting
    - Parallel agent execution
    - Complete tick capture (observation → thinking → action → feedback)
    - Quality validation
    """

    def __init__(self, config: RolloutConfig):
        self.config = config
        self.rollouts_generated = 0
        self.total_ticks = 0
        self.start_time: float | None = None

    async def generate_rollout(
        self,
        agent: AgentRunner,
        agent_id: str,
        simulation,  # SimulationEngine instance
    ) -> RolloutResult:
        """
        Generate a single rollout from an agent running through simulation.

        Args:
            agent: Agent implementation
            agent_id: Unique agent identifier
            simulation: Simulation engine providing environment

        Returns:
            RolloutResult with complete trajectory data
        """
        start_time = time.time()
        tick_durations: list[float] = []
        all_ticks: list[AgentTickData] = []
        total_llm_calls = 0
        total_reward = 0.0

        trajectory_id = f"rollout-{agent_id}-{int(start_time * 1000)}"

        logger.info(f"Starting rollout generation for agent {agent_id}")

        # Run through simulation
        tick_number = 0
        while not simulation.isComplete() and tick_number < self.config.max_ticks_per_agent:
            tick_start = time.time()

            # Get observation from simulation
            game_state = simulation.getGameState()
            observation = state_to_observation(game_state)
            env_state = state_to_env_state(game_state, agent_id)

            # Agent processes tick (captures all LLM calls)
            tick_data = await agent.run_tick(agent_id, observation, env_state)
            tick_data.tick_number = tick_number
            tick_data.timestamp = int(time.time() * 1000)

            # Execute action in simulation if provided
            if tick_data.action and tick_data.action.action_type != "wait":
                result = await simulation.performAction(
                    tick_data.action.action_type,
                    tick_data.action.parameters,
                )
                tick_data.feedback = result
                tick_data.action.success = result.get("success", False)
                tick_data.action.result = result.get("result")
                tick_data.action.error = result.get("error")

            # Calculate reward for this tick using The Judge logic
            tick_data.reward = self._calculate_tick_reward(tick_data, env_state)
            total_reward += tick_data.reward

            # Validate tick quality
            if not self._validate_tick_quality(tick_data):
                logger.warning(f"Tick {tick_number} failed quality check")

            # Store tick
            all_ticks.append(tick_data)
            total_llm_calls += len(tick_data.llm_calls)

            # Track timing
            tick_duration = time.time() - tick_start
            tick_durations.append(tick_duration)

            # Advance simulation (no artificial delay in fast-forward mode)
            simulation.advanceTick()
            tick_number += 1

            # Log progress periodically
            if tick_number % 50 == 0:
                avg_tick = sum(tick_durations[-50:]) / min(50, len(tick_durations))
                logger.info(f"Tick {tick_number}: avg {avg_tick * 1000:.1f}ms/tick")

        total_duration_ms = int((time.time() - start_time) * 1000)
        avg_tick_duration = sum(tick_durations) / len(tick_durations) if tick_durations else 0

        # Build trajectory from ticks
        trajectory = build_trajectory_from_ticks(
            trajectory_id=trajectory_id,
            agent_id=agent_id,
            ticks=all_ticks,
            min_steps=1,
        )

        # Calculate quality score
        quality_score = calculate_trajectory_quality_score(all_ticks)

        result = RolloutResult(
            agent_id=agent_id,
            trajectory_id=trajectory_id,
            ticks_completed=tick_number,
            total_duration_ms=total_duration_ms,
            avg_tick_duration_ms=avg_tick_duration * 1000,
            total_llm_calls=total_llm_calls,
            total_reward=total_reward,
            final_pnl=trajectory.final_pnl if trajectory else 0.0,
            quality_score=quality_score,
            trajectory=trajectory,
        )

        self.rollouts_generated += 1
        self.total_ticks += tick_number

        logger.info(
            f"Rollout complete: {tick_number} ticks in {total_duration_ms}ms "
            f"({avg_tick_duration * 1000:.1f}ms/tick), quality={quality_score:.2f}"
        )

        return result

    async def generate_parallel_rollouts(
        self,
        agents: list[tuple[AgentRunner, str]],  # (agent, agent_id)
        simulation_factory: Callable,
    ) -> list[RolloutResult]:
        """
        Generate multiple rollouts in parallel.

        Args:
            agents: List of (agent, agent_id) tuples
            simulation_factory: Factory to create simulation instances

        Returns:
            List of RolloutResults
        """
        self.start_time = time.time()

        logger.info(f"Starting parallel rollout generation for {len(agents)} agents")

        # Create tasks for each agent
        tasks = []
        for agent, agent_id in agents:
            simulation = simulation_factory()
            simulation.initialize()
            tasks.append(self.generate_rollout(agent, agent_id, simulation))

        # Run all in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter out errors
        valid_results = []
        for r in results:
            if isinstance(r, Exception):
                logger.error(f"Rollout failed: {r}")
            else:
                valid_results.append(r)

        total_time = time.time() - self.start_time
        logger.info(
            f"Parallel rollout generation complete: "
            f"{len(valid_results)}/{len(agents)} succeeded, "
            f"{self.total_ticks} total ticks in {total_time:.1f}s "
            f"({self.total_ticks / total_time:.1f} ticks/s)"
        )

        return valid_results

    def _calculate_tick_reward(
        self,
        tick_data: AgentTickData,
        env_state: EnvironmentState,
    ) -> float:
        """
        Calculate reward for a single tick.

        Combines:
        1. Financial Performance (PnL)
        2. Format Compliance (XML validation)
        3. Reasoning Alignment (Financial Literacy)
        4. Risk Management (Exposure penalties)
        """
        # 1. Quality Scores (Format & Reasoning)
        fmt_score, rsn_score = calculate_detailed_tick_quality(
            tick_data.llm_calls, tick_data.action, tick_data.feedback
        )

        # 2. Risk Calculation
        # Exposure proxy: active positions / max reasonable positions (e.g. 10)
        # Or ideally use a dedicated exposure field if available in env_state
        exposure = min(1.0, env_state.open_positions / 10.0)

        action_type = "wait"
        if tick_data.action:
            action_type = tick_data.action.action_type

        risk_penalty_count = 0
        if calculate_risk_reward(exposure, action_type) < 0:
            risk_penalty_count = 1

        # 3. Financials (PnL for this tick)
        pnl = tick_data.feedback.get("pnl_delta", 0.0)

        # Build Inputs for Composite Reward
        inputs = TrajectoryRewardInputs(
            final_pnl=pnl,
            starting_balance=env_state.agent_balance,
            end_balance=env_state.agent_balance + pnl,
            format_score=fmt_score,
            reasoning_score=rsn_score,
            risky_actions_count=risk_penalty_count,
            total_actions=1 if tick_data.action else 0,
            successful_actions=1 if tick_data.action and tick_data.action.success else 0,
        )

        return composite_reward(inputs)

    def _validate_tick_quality(self, tick_data: AgentTickData) -> bool:
        """Validate that tick data meets quality requirements"""
        # Must have LLM calls if configured
        if self.config.min_llm_calls_per_tick > 0:
            if len(tick_data.llm_calls) < self.config.min_llm_calls_per_tick:
                return False

        # Must have action if configured
        if self.config.require_action and tick_data.action is None:
            return False

        # LLM calls must have non-empty responses
        for call in tick_data.llm_calls:
            if not call.response or len(call.response.strip()) == 0:
                return False

        return True


class RolloutQualityValidator:
    """
    Validates that rollouts meet quality standards for training.
    """

    @staticmethod
    def validate_rollout(result: RolloutResult) -> tuple[bool, list[str]]:
        """
        Validate a rollout result.

        Returns:
            (is_valid, list of issues)
        """
        issues = []

        # Must have trajectory
        if result.trajectory is None:
            issues.append("No trajectory data")
            return False, issues

        # Minimum ticks
        if result.ticks_completed < 5:
            issues.append(f"Too few ticks: {result.ticks_completed} < 5")

        # Must have LLM calls
        if result.total_llm_calls < result.ticks_completed:
            issues.append(
                f"Low LLM call rate: {result.total_llm_calls} calls for {result.ticks_completed} ticks"
            )

        # Quality score threshold
        if result.quality_score < 0.5:
            issues.append(f"Quality score too low: {result.quality_score:.2f} < 0.5")

        # Check trajectory steps
        traj = result.trajectory
        for i, step in enumerate(traj.steps):
            # Each step should have LLM calls
            if not step.llm_calls:
                issues.append(f"Step {i} has no LLM calls")

            # Each LLM call should have content
            for j, call in enumerate(step.llm_calls):
                if not call.user_prompt or not call.response:
                    issues.append(f"Step {i}, call {j}: missing prompt or response")
                if not call.system_prompt:
                    issues.append(f"Step {i}, call {j}: missing system prompt")

        is_valid = len(issues) == 0
        return is_valid, issues

    @staticmethod
    def print_quality_report(results: list[RolloutResult]) -> None:
        """Print a quality report for a batch of rollouts"""
        print("\n" + "=" * 60)
        print("  ROLLOUT QUALITY REPORT")
        print("=" * 60)

        total = len(results)
        valid_count = 0
        total_ticks = 0
        total_llm_calls = 0
        total_quality = 0.0
        all_issues: list[str] = []

        for result in results:
            is_valid, issues = RolloutQualityValidator.validate_rollout(result)
            if is_valid:
                valid_count += 1
            all_issues.extend(issues)

            total_ticks += result.ticks_completed
            total_llm_calls += result.total_llm_calls
            total_quality += result.quality_score

        print(f"\nValid rollouts: {valid_count}/{total} ({valid_count / total * 100:.1f}%)")
        print(f"Total ticks: {total_ticks}")
        print(f"Total LLM calls: {total_llm_calls}")
        print(f"Average quality score: {total_quality / total:.2f}")
        print(f"LLM calls per tick: {total_llm_calls / total_ticks:.1f}")

        if all_issues:
            print(f"\nIssues found ({len(all_issues)} total):")
            # Group and count issues
            issue_counts: dict[str, int] = {}
            for issue in all_issues:
                # Normalize issue text
                key = issue.split(":")[0] if ":" in issue else issue
                issue_counts[key] = issue_counts.get(key, 0) + 1

            for issue, count in sorted(issue_counts.items(), key=lambda x: -x[1])[:10]:
                print(f"  - {issue}: {count} occurrences")

        print("=" * 60 + "\n")
