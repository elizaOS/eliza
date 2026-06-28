# mypy: disable-error-code="call-arg"
"""Production-facing Step 7 bounded Dyna planning facade."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.average_reward import (
    DifferentialSARSAAgent,
    DifferentialSARSAState,
    DifferentialSARSAUpdateResult,
)
from alberta_framework.core.world_model import (
    OneStepWorldModel,
    WorldModelState,
    WorldModelUpdateResult,
)
from alberta_framework.steps.step6 import (
    Step6DifferentialSARSAConfig,
    make_step6_differential_sarsa_agent,
)
from alberta_framework.steps.step8 import (
    Step8WorldModelConfig,
    make_step8_world_model,
)

Step7PlanningStrategy = Literal[
    "random",
    "reward",
    "surprise",
    "predecessor",
    "prioritized",
    "learned",
]


@dataclass(frozen=True)
class Step7DynaConfig:
    """Config for Step 7 one-step Dyna planning in continuing control.

    The real transition update always happens first. Planning then performs a
    fixed number of model-generated one-step backups, gated by model warmup.
    """

    control: Step6DifferentialSARSAConfig = field(
        default_factory=Step6DifferentialSARSAConfig
    )
    world_model: Step8WorldModelConfig = field(default_factory=Step8WorldModelConfig)
    planning_steps: int = 1
    planning_rollout_depth: int = 1
    planning_warmup_steps: int = 8
    planning_memory_size: int = 64
    planning_strategy: Step7PlanningStrategy = "random"
    planning_importance_ratio_clip: float = 10.0
    planning_apply_importance_correction: bool = True
    planning_priority_propagation: float = 1.0
    planning_utility_step_size: float = 0.2

    def __post_init__(self) -> None:
        """Validate planning hyperparameters and component compatibility."""
        if self.planning_steps < 0:
            raise ValueError("planning_steps must be non-negative")
        if self.planning_rollout_depth < 1:
            raise ValueError("planning_rollout_depth must be positive")
        if self.planning_warmup_steps < 0:
            raise ValueError("planning_warmup_steps must be non-negative")
        if self.planning_memory_size < 1:
            raise ValueError("planning_memory_size must be positive")
        if self.planning_importance_ratio_clip <= 0.0:
            raise ValueError("planning_importance_ratio_clip must be positive")
        if self.planning_priority_propagation < 0.0:
            raise ValueError("planning_priority_propagation must be non-negative")
        if not 0.0 <= self.planning_utility_step_size <= 1.0:
            raise ValueError("planning_utility_step_size must be in [0, 1]")
        if self.planning_strategy not in (
            "random",
            "reward",
            "surprise",
            "predecessor",
            "prioritized",
            "learned",
        ):
            raise ValueError(
                "planning_strategy must be random, reward, surprise, predecessor, "
                "prioritized, or learned"
            )
        if self.world_model.n_actions != self.control.n_actions:
            raise ValueError("world_model.n_actions must equal control.n_actions")

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["control"] = self.control.to_dict()
        payload["world_model"] = self.world_model.to_dict()
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step7DynaConfig:
        """Reconstruct from :meth:`to_dict` output."""
        data = dict(payload)
        data["control"] = Step6DifferentialSARSAConfig.from_dict(
            cast(dict[str, object], data["control"])
        )
        data["world_model"] = Step8WorldModelConfig.from_dict(
            cast(dict[str, object], data["world_model"])
        )
        return cls(**cast(Any, data))


@chex.dataclass(frozen=True)
class Step7DynaState:
    """Combined Step 7 state."""

    control_state: DifferentialSARSAState
    world_model_state: WorldModelState
    memory_observations: Array
    memory_actions: Array
    memory_rewards: Array
    memory_next_observations: Array
    memory_priorities: Array
    memory_utilities: Array
    memory_count: Array
    memory_position: Array
    step_count: Array


@chex.dataclass(frozen=True)
class Step7DynaUpdateResult:
    """Result from one real transition plus bounded planning."""

    state: Step7DynaState
    real_control_result: DifferentialSARSAUpdateResult
    real_model_result: WorldModelUpdateResult
    planning_td_errors: Array
    planning_rewards: Array
    planning_actions: Array
    planning_priorities: Array
    planning_anchor_indices: Array
    planning_behavior_probs: Array
    planning_target_probs: Array
    planning_importance_ratios: Array
    planning_accepted: Array


@chex.dataclass(frozen=True)
class Step7DynaArrayResult:
    """Scan result for Step 7 Dyna over real transition arrays."""

    state: Step7DynaState
    real_td_errors: Array
    average_rewards: Array
    actions: Array
    model_reward_errors: Array
    model_next_observation_errors: Array
    planning_td_errors: Array
    planning_priorities: Array
    planning_anchor_indices: Array
    planning_behavior_probs: Array
    planning_target_probs: Array
    planning_importance_ratios: Array
    planning_accepted: Array


@dataclass(frozen=True)
class Step7SmokeResult:
    """Summary returned by :func:`run_step7_smoke`."""

    config: Step7DynaConfig
    steps: int
    seed: int
    real_td_errors_shape: tuple[int, ...]
    planning_td_errors_shape: tuple[int, ...]
    planning_priorities_shape: tuple[int, ...]
    planning_anchor_indices_shape: tuple[int, ...]
    planning_importance_ratios_shape: tuple[int, ...]
    actions_shape: tuple[int, ...]
    finite: bool
    planning_acceptance_count: int
    control_config: dict[str, Any]
    world_model_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["real_td_errors_shape"] = list(self.real_td_errors_shape)
        payload["planning_td_errors_shape"] = list(self.planning_td_errors_shape)
        payload["planning_priorities_shape"] = list(self.planning_priorities_shape)
        payload["planning_anchor_indices_shape"] = list(
            self.planning_anchor_indices_shape
        )
        payload["planning_importance_ratios_shape"] = list(
            self.planning_importance_ratios_shape
        )
        payload["actions_shape"] = list(self.actions_shape)
        return payload


def make_step7_components(
    config: Step7DynaConfig | None = None,
) -> tuple[DifferentialSARSAAgent, OneStepWorldModel]:
    """Create the Step 7 continuing-control agent and world model."""
    cfg = config or Step7DynaConfig()
    return (
        make_step6_differential_sarsa_agent(cfg.control),
        make_step8_world_model(cfg.world_model),
    )


def init_step7_state(
    agent: DifferentialSARSAAgent,
    model: OneStepWorldModel,
    *,
    key: Array,
    initial_observation: Array,
    memory_size: int = 64,
) -> Step7DynaState:
    """Initialize and prime the Step 7 state."""
    if memory_size < 1:
        raise ValueError("memory_size must be positive")
    control_key, model_key = jr.split(key)
    feature_dim = int(jnp.ravel(initial_observation).shape[0])
    control_state = agent.init(feature_dim, control_key)
    control_state, _ = agent.start(control_state, initial_observation)
    return Step7DynaState(
        control_state=control_state,
        world_model_state=model.init(model_key),
        memory_observations=jnp.zeros(
            (memory_size, feature_dim),
            dtype=jnp.float32,
        ),
        memory_actions=jnp.zeros((memory_size,), dtype=jnp.int32),
        memory_rewards=jnp.zeros((memory_size,), dtype=jnp.float32),
        memory_next_observations=jnp.zeros(
            (memory_size, feature_dim),
            dtype=jnp.float32,
        ),
        memory_priorities=jnp.zeros((memory_size,), dtype=jnp.float32),
        memory_utilities=jnp.zeros((memory_size,), dtype=jnp.float32),
        memory_count=jnp.array(0, dtype=jnp.int32),
        memory_position=jnp.array(0, dtype=jnp.int32),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def _select_planning_action(
    state: DifferentialSARSAState,
    n_actions: int,
) -> tuple[Array, Array]:
    key, action_key = jr.split(state.rng_key)
    action = jr.randint(action_key, (), 0, n_actions).astype(jnp.int32)
    return action, key


def _score_planning_actions(
    model: OneStepWorldModel,
    model_state: WorldModelState,
    anchor_observation: Array,
    strategy: Step7PlanningStrategy,
    n_actions: int,
) -> tuple[Array, Array]:
    """Score all candidate actions for model-based search control."""
    actions = jnp.arange(n_actions, dtype=jnp.int32)

    def predict_action(action: Array) -> tuple[Array, Array]:
        prediction = model.predict(model_state, anchor_observation, action)
        transition_magnitude = jnp.sqrt(
            jnp.mean((prediction.next_observation - anchor_observation) ** 2)
        )
        reward_priority = jnp.abs(prediction.reward)
        priority = (
            reward_priority
            if strategy == "reward"
            else reward_priority + transition_magnitude
        )
        return priority, prediction.reward

    priorities, rewards = jax.vmap(predict_action)(actions)
    selected = jnp.argmax(priorities).astype(jnp.int32)
    return selected, priorities[selected] + 0.0 * rewards[selected]


def _store_real_transition(
    state: Step7DynaState,
    observation: Array,
    action: Array,
    reward: Array,
    next_observation: Array,
    priority: Array,
) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
    """Insert a real transition into the fixed-size planning memory."""
    index = state.memory_position
    memory_size = state.memory_actions.shape[0]
    observations = state.memory_observations.at[index].set(
        jnp.asarray(observation, dtype=jnp.float32).reshape(
            (state.memory_observations.shape[1],)
        )
    )
    actions = state.memory_actions.at[index].set(action.astype(jnp.int32))
    rewards = state.memory_rewards.at[index].set(jnp.asarray(reward, dtype=jnp.float32))
    next_observations = state.memory_next_observations.at[index].set(
        jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (state.memory_next_observations.shape[1],)
        )
    )
    priorities = state.memory_priorities.at[index].set(
        jnp.asarray(priority, dtype=jnp.float32)
    )
    utilities = state.memory_utilities.at[index].set(
        jnp.asarray(priority, dtype=jnp.float32)
    )
    count = jnp.minimum(state.memory_count + 1, memory_size)
    position = (state.memory_position + 1) % memory_size
    return (
        observations,
        actions,
        rewards,
        next_observations,
        priorities,
        utilities,
        count,
        position,
    )


def _select_planning_anchor(
    memory_observations: Array,
    memory_rewards: Array,
    memory_next_observations: Array,
    memory_priorities: Array,
    memory_utilities: Array,
    memory_count: Array,
    reference_observation: Array,
    key: Array,
    strategy: Step7PlanningStrategy,
) -> tuple[Array, Array, Array]:
    """Select a replay-memory anchor for search control."""
    memory_size = memory_rewards.shape[0]
    valid = jnp.arange(memory_size, dtype=jnp.int32) < memory_count
    safe_scores = jnp.where(valid, 0.0, -jnp.inf)
    random_index = jr.randint(key, (), 0, jnp.maximum(memory_count, 1)).astype(jnp.int32)

    reward_scores = jnp.where(valid, jnp.abs(memory_rewards), -jnp.inf)
    surprise_scores = jnp.where(valid, memory_priorities, -jnp.inf)
    learned_scores = jnp.where(
        valid,
        memory_utilities + 0.1 * memory_priorities,
        -jnp.inf,
    )
    predecessor_distance = jnp.mean(
        (memory_next_observations - reference_observation[None, :]) ** 2,
        axis=1,
    )
    predecessor_scores = jnp.where(
        valid,
        memory_priorities + 1.0 / (1.0 + predecessor_distance),
        -jnp.inf,
    )
    priority_scores = (
        reward_scores
        if strategy == "reward"
        else predecessor_scores
        if strategy in ("predecessor", "prioritized")
        else learned_scores
        if strategy == "learned"
        else surprise_scores
    )
    priority_index = jnp.argmax(priority_scores).astype(jnp.int32)
    index = jnp.where(strategy == "random", random_index, priority_index).astype(jnp.int32)
    score = jnp.where(
        strategy == "random",
        safe_scores[index],
        priority_scores[index],
    )
    anchor = memory_observations[index]
    return anchor, index, jnp.where(memory_count > 0, score, 0.0)


def _update_planning_utility(
    memory_utilities: Array,
    index: Array,
    td_signal: Array,
    step_size: float,
) -> Array:
    """Update learned search-control utility for a planned transition."""
    alpha = jnp.asarray(step_size, dtype=jnp.float32)
    old_utility = memory_utilities[index]
    new_utility = (1.0 - alpha) * old_utility + alpha * jnp.abs(td_signal)
    return memory_utilities.at[index].set(new_utility)


def _pop_prioritized_planning_anchor(
    memory_observations: Array,
    memory_priorities: Array,
    memory_count: Array,
) -> tuple[Array, Array, Array, Array]:
    """Pop the highest-priority replay item from the bounded planning queue."""
    memory_size = memory_priorities.shape[0]
    valid = jnp.arange(memory_size, dtype=jnp.int32) < memory_count
    scores = jnp.where(valid, memory_priorities, -jnp.inf)
    index = jnp.argmax(scores).astype(jnp.int32)
    priority = jnp.where(memory_count > 0, scores[index], 0.0)
    queue = memory_priorities.at[index].set(0.0)
    return memory_observations[index], index, priority, queue


def _propagate_predecessor_priorities(
    memory_next_observations: Array,
    memory_priorities: Array,
    memory_count: Array,
    anchor_observation: Array,
    td_error: Array,
    propagation_scale: float,
) -> Array:
    """Propagate backup priority to predecessor transitions in the queue."""
    memory_size = memory_priorities.shape[0]
    valid = jnp.arange(memory_size, dtype=jnp.int32) < memory_count
    predecessor_distance = jnp.mean(
        (memory_next_observations - anchor_observation[None, :]) ** 2,
        axis=1,
    )
    propagated = (
        jnp.asarray(propagation_scale, dtype=jnp.float32)
        * jnp.abs(td_error)
        / (1.0 + predecessor_distance)
    )
    return jnp.where(valid, jnp.maximum(memory_priorities, propagated), memory_priorities)


def _epsilon_greedy_action_probability(
    agent: DifferentialSARSAAgent,
    state: DifferentialSARSAState,
    observation: Array,
    action: Array,
) -> Array:
    """Return the current epsilon-greedy target-policy probability."""
    q_values = agent.q_values(state, observation)
    max_q = jnp.max(q_values)
    greedy_mask = jnp.isclose(q_values, max_q)
    greedy_count = jnp.maximum(jnp.sum(greedy_mask), 1)
    action_is_greedy = greedy_mask[action.astype(jnp.int32)]
    random_prob = state.epsilon / agent.config.n_actions
    greedy_prob = (1.0 - state.epsilon) / greedy_count
    return random_prob + jnp.where(action_is_greedy, greedy_prob, 0.0)


def _maybe_accept_planning_state(
    accepted: Array,
    new_state: DifferentialSARSAState,
    old_state: DifferentialSARSAState,
) -> DifferentialSARSAState:
    return cast(
        DifferentialSARSAState,
        jax.tree_util.tree_map(
            lambda new, old: jnp.where(accepted, new, old),
            new_state,
            old_state,
        ),
    )


def _apply_planning_importance_correction(
    old_state: DifferentialSARSAState,
    planned_state: DifferentialSARSAState,
    importance_ratio: Array,
) -> DifferentialSARSAState:
    """Scale imagined SARSA parameter and trace deltas by an IS ratio."""
    rho = jnp.asarray(importance_ratio, dtype=jnp.float32)
    return cast(
        DifferentialSARSAState,
        planned_state.replace(  # type: ignore[attr-defined]
            q_weights=old_state.q_weights
            + rho * (planned_state.q_weights - old_state.q_weights),
            q_bias=old_state.q_bias + rho * (planned_state.q_bias - old_state.q_bias),
            q_trace_weights=old_state.q_trace_weights
            + rho * (planned_state.q_trace_weights - old_state.q_trace_weights),
            q_trace_bias=old_state.q_trace_bias
            + rho * (planned_state.q_trace_bias - old_state.q_trace_bias),
            average_reward=old_state.average_reward
            + rho * (planned_state.average_reward - old_state.average_reward),
        ),
    )


def step7_update(
    config: Step7DynaConfig,
    agent: DifferentialSARSAAgent,
    model: OneStepWorldModel,
    state: Step7DynaState,
    reward: Array,
    next_observation: Array,
) -> Step7DynaUpdateResult:
    """Run one foreground real update plus bounded background planning."""
    real_observation = state.control_state.last_observation
    real_action = state.control_state.last_action
    real_model_result = model.update(
        state.world_model_state,
        real_observation,
        real_action,
        reward,
        next_observation,
    )
    real_control_result = agent.update(state.control_state, reward, next_observation)
    control_after_real = real_control_result.state
    model_state = cast(WorldModelState, real_model_result.state)
    planning_ready = model_state.step_count >= config.planning_warmup_steps
    (
        memory_observations,
        memory_actions,
        memory_rewards,
        memory_next_observations,
        memory_priorities,
        memory_utilities,
        memory_count,
        memory_position,
    ) = _store_real_transition(
        state,
        real_observation,
        real_action,
        reward,
        next_observation,
        real_model_result.prediction_error,
    )

    def planning_step(
        carry: tuple[DifferentialSARSAState, Array, Array],
        _: Array,
    ) -> tuple[tuple[DifferentialSARSAState, Array, Array], tuple[Array, ...]]:
        carry_state, queue_priorities, utility_values = carry
        random_action, key = _select_planning_action(
            carry_state,
            config.control.n_actions,
        )
        key, anchor_key = jr.split(key)
        replay_anchor, replay_index, replay_priority = _select_planning_anchor(
            memory_observations,
            memory_rewards,
            memory_next_observations,
            queue_priorities,
            utility_values,
            memory_count,
            control_after_real.last_observation,
            anchor_key,
            config.planning_strategy,
        )
        (
            prioritized_anchor,
            prioritized_index,
            prioritized_priority,
            popped_queue_priorities,
        ) = _pop_prioritized_planning_anchor(
            memory_observations,
            queue_priorities,
            memory_count,
        )
        anchor_observation = jnp.where(
            config.planning_strategy == "prioritized",
            prioritized_anchor,
            replay_anchor,
        )
        anchor_index = jnp.where(
            config.planning_strategy == "prioritized",
            prioritized_index,
            replay_index,
        )
        anchor_priority = jnp.where(
            config.planning_strategy == "prioritized",
            prioritized_priority,
            replay_priority,
        )
        ranked_action, priority = _score_planning_actions(
            model,
            model_state,
            anchor_observation,
            config.planning_strategy
            if config.planning_strategy != "random"
            else "surprise",
            config.control.n_actions,
        )
        action = jnp.where(
            config.planning_strategy == "random",
            random_action,
            ranked_action,
        ).astype(jnp.int32)
        behavior_prob = jnp.where(
            config.planning_strategy == "random",
            1.0 / config.control.n_actions,
            1.0,
        )
        target_prob = _epsilon_greedy_action_probability(
            agent,
            carry_state,
            anchor_observation,
            action,
        )
        importance_ratio = jnp.minimum(
            target_prob / jnp.maximum(behavior_prob, 1e-6),
            config.planning_importance_ratio_clip,
        )
        priority = jnp.where(
            config.planning_strategy == "random",
            anchor_priority,
            anchor_priority + priority,
        )
        def rollout_step(
            rollout_carry: tuple[DifferentialSARSAState, Array, Array, Array],
            _: Array,
        ) -> tuple[tuple[DifferentialSARSAState, Array, Array, Array], tuple[Array, Array]]:
            rollout_state, rollout_observation, rollout_action, rollout_key = (
                rollout_carry
            )
            prediction = model.predict(
                model_state,
                rollout_observation,
                rollout_action,
            )
            temp_state = rollout_state.replace(  # type: ignore[attr-defined]
                last_observation=rollout_observation,
                last_action=rollout_action,
                rng_key=rollout_key,
            )
            planned = agent.update(
                temp_state,
                prediction.reward,
                prediction.next_observation,
            )
            return (
                planned.state,
                prediction.next_observation,
                planned.action,
                planned.state.rng_key,
            ), (planned.td_error, prediction.reward)

        (
            (rollout_state, _rollout_observation, _rollout_action, _rollout_key),
            (rollout_td_errors, rollout_rewards),
        ) = jax.lax.scan(
            rollout_step,
            (carry_state, anchor_observation, action, key),
            jnp.arange(config.planning_rollout_depth, dtype=jnp.int32),
        )
        rollout_td_signal = jnp.sum(rollout_td_errors)
        root_reward = rollout_rewards[0]
        restored_state = cast(
            DifferentialSARSAState,
            rollout_state.replace(  # type: ignore[attr-defined]
                last_observation=control_after_real.last_observation,
                last_action=control_after_real.last_action,
            ),
        )
        corrected_state = jax.lax.cond(
            config.planning_apply_importance_correction,
            lambda: _apply_planning_importance_correction(
                carry_state,
                restored_state,
                importance_ratio,
            ),
            lambda: restored_state,
        )
        next_state = _maybe_accept_planning_state(
            planning_ready,
            corrected_state,
            carry_state,
        )
        propagated_queue_priorities = _propagate_predecessor_priorities(
            memory_next_observations,
            popped_queue_priorities,
            memory_count,
            anchor_observation,
            rollout_td_signal,
            config.planning_priority_propagation,
        )
        next_queue_priorities = jnp.where(
            planning_ready & (config.planning_strategy == "prioritized"),
            propagated_queue_priorities,
            queue_priorities,
        )
        updated_utility_values = _update_planning_utility(
            utility_values,
            anchor_index,
            rollout_td_signal,
            config.planning_utility_step_size,
        )
        next_utility_values = jnp.where(
            planning_ready & (config.planning_strategy == "learned"),
            updated_utility_values,
            utility_values,
        )
        return (next_state, next_queue_priorities, next_utility_values), (
            jnp.where(planning_ready, rollout_td_signal, 0.0),
            jnp.where(planning_ready, root_reward, 0.0),
            action,
            jnp.where(planning_ready, priority, 0.0),
            jnp.where(planning_ready, anchor_index, -1),
            jnp.where(planning_ready, behavior_prob, 0.0),
            jnp.where(planning_ready, target_prob, 0.0),
            jnp.where(planning_ready, importance_ratio, 0.0),
        )

    (
        (planned_state, planned_memory_priorities, planned_memory_utilities),
        (
            planning_td_errors,
            planning_rewards,
            planning_actions,
            planning_priorities,
            planning_anchor_indices,
            planning_behavior_probs,
            planning_target_probs,
            planning_importance_ratios,
        ),
    ) = jax.lax.scan(
        planning_step,
        (control_after_real, memory_priorities, memory_utilities),
        jnp.arange(config.planning_steps, dtype=jnp.int32),
    )
    planning_accepted = jnp.full(
        (config.planning_steps,),
        planning_ready,
        dtype=jnp.bool_,
    )
    new_state = Step7DynaState(
        control_state=planned_state,
        world_model_state=model_state,
        memory_observations=memory_observations,
        memory_actions=memory_actions,
        memory_rewards=memory_rewards,
        memory_next_observations=memory_next_observations,
        memory_priorities=planned_memory_priorities,
        memory_utilities=planned_memory_utilities,
        memory_count=memory_count,
        memory_position=memory_position,
        step_count=state.step_count + 1,
    )
    return Step7DynaUpdateResult(
        state=new_state,
        real_control_result=real_control_result,
        real_model_result=real_model_result,
        planning_td_errors=planning_td_errors,
        planning_rewards=planning_rewards,
        planning_actions=planning_actions,
        planning_priorities=planning_priorities,
        planning_anchor_indices=planning_anchor_indices,
        planning_behavior_probs=planning_behavior_probs,
        planning_target_probs=planning_target_probs,
        planning_importance_ratios=planning_importance_ratios,
        planning_accepted=planning_accepted,
    )


def run_step7_scan(
    config: Step7DynaConfig,
    agent: DifferentialSARSAAgent,
    model: OneStepWorldModel,
    state: Step7DynaState,
    rewards: Array,
    next_observations: Array,
) -> Step7DynaArrayResult:
    """Run Step 7 Dyna over real continuing transition arrays."""

    def scan_step(
        carry: Step7DynaState,
        inputs: tuple[Array, Array],
    ) -> tuple[Step7DynaState, tuple[Array, ...]]:
        reward, next_observation = inputs
        result = step7_update(config, agent, model, carry, reward, next_observation)
        return result.state, (
            result.real_control_result.td_error,
            result.real_control_result.average_reward,
            result.real_control_result.action,
            result.real_model_result.reward_error,
            result.real_model_result.next_observation_errors,
            result.planning_td_errors,
            result.planning_priorities,
            result.planning_anchor_indices,
            result.planning_behavior_probs,
            result.planning_target_probs,
            result.planning_importance_ratios,
            result.planning_accepted,
        )

    final_state, (
        real_td_errors,
        average_rewards,
        actions,
        model_reward_errors,
        model_next_observation_errors,
        planning_td_errors,
        planning_priorities,
        planning_anchor_indices,
        planning_behavior_probs,
        planning_target_probs,
        planning_importance_ratios,
        planning_accepted,
    ) = jax.lax.scan(scan_step, state, (rewards, next_observations))
    return Step7DynaArrayResult(
        state=final_state,
        real_td_errors=real_td_errors,
        average_rewards=average_rewards,
        actions=actions,
        model_reward_errors=model_reward_errors,
        model_next_observation_errors=model_next_observation_errors,
        planning_td_errors=planning_td_errors,
        planning_priorities=planning_priorities,
        planning_anchor_indices=planning_anchor_indices,
        planning_behavior_probs=planning_behavior_probs,
        planning_target_probs=planning_target_probs,
        planning_importance_ratios=planning_importance_ratios,
        planning_accepted=planning_accepted,
    )


def run_step7_smoke(
    config: Step7DynaConfig | None = None,
    *,
    steps: int = 32,
    seed: int = 0,
) -> Step7SmokeResult:
    """Run a tiny deterministic Step 7 Dyna integration probe."""
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config or Step7DynaConfig()
    agent, model = make_step7_components(cfg)
    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(
        data_key,
        (steps + 1, cfg.world_model.observation_dim),
        dtype=jnp.float32,
    )
    rewards = jnp.tanh(observations[1:, 0])
    state = init_step7_state(
        agent,
        model,
        key=state_key,
        initial_observation=observations[0],
        memory_size=cfg.planning_memory_size,
    )
    result = run_step7_scan(cfg, agent, model, state, rewards, observations[1:])
    result.real_td_errors.block_until_ready()
    finite = bool(
        jnp.all(jnp.isfinite(result.real_td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
        & jnp.all(jnp.isfinite(result.model_reward_errors))
        & jnp.all(jnp.isfinite(result.model_next_observation_errors))
        & jnp.all(jnp.isfinite(result.planning_td_errors))
        & jnp.all(jnp.isfinite(result.planning_priorities))
        & jnp.all(jnp.isfinite(result.planning_importance_ratios))
        & jnp.all(result.planning_anchor_indices < cfg.planning_memory_size)
        & jnp.all(result.actions >= 0)
        & jnp.all(result.actions < cfg.control.n_actions)
    )
    return Step7SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        real_td_errors_shape=tuple(int(dim) for dim in result.real_td_errors.shape),
        planning_td_errors_shape=tuple(int(dim) for dim in result.planning_td_errors.shape),
        planning_priorities_shape=tuple(
            int(dim) for dim in result.planning_priorities.shape
        ),
        planning_anchor_indices_shape=tuple(
            int(dim) for dim in result.planning_anchor_indices.shape
        ),
        planning_importance_ratios_shape=tuple(
            int(dim) for dim in result.planning_importance_ratios.shape
        ),
        actions_shape=tuple(int(dim) for dim in result.actions.shape),
        finite=finite,
        planning_acceptance_count=int(jnp.sum(result.planning_accepted)),
        control_config=agent.to_config(),
        world_model_config=model.to_config(),
    )
