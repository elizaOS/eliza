# mypy: disable-error-code="attr-defined,call-arg"
"""Production-facing Step 9 guarded-dreaming facade.

Step 9 extends Step 7's one-step Dyna planning to error-gated, real-state-
anchored multi-step dreaming.  Key additions over Step 7:

* Uses :class:`ActionConditionedWorldModel` which adds a learned discount/
  termination head, enabling clean multi-step rollout support.
* Dream transitions are accepted only when the world model has accumulated
  sufficient experience *and* its running prediction-error EMA is below a
  configurable threshold.  This prevents model-bias corruption from a poorly
  calibrated environment model.
* A :class:`RecentObservationBuffer` (ring buffer of recent real observations)
  anchors each dream at a genuine past state rather than always the current
  state, improving state-space coverage of imagined experience.

The control learner is the same :class:`DifferentialSARSAAgent` from Step 6,
preserving the continuing / average-reward formulation.
"""

from __future__ import annotations

import functools
from dataclasses import asdict, dataclass, field
from typing import Any, cast

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
from alberta_framework.core.behavior_model import (
    BehaviorModel,
    BehaviorModelConfig,
    BehaviorModelState,
)
from alberta_framework.core.dreaming import (
    DreamSelectionConfig,
    RecentObservationBuffer,
    RecentObservationBufferState,
    score_dream_candidates,
)
from alberta_framework.core.world_model import (
    ActionConditionedWorldModel,
    ActionConditionedWorldModelConfig,
    ActionConditionedWorldModelState,
    WorldModelUpdateResult,
)
from alberta_framework.steps.step6 import (
    Step6DifferentialSARSAConfig,
    make_step6_differential_sarsa_agent,
)


@dataclass(frozen=True)
class Step9DreamingConfig:
    """Config for Step 9 guarded-dreaming continuing control.

    The world model learns from every real transition.  Each real step also
    fires a fixed dreaming budget: for each dream the agent samples a recent
    anchor observation, picks a random action, queries the world model, and
    applies the imagined update **only** when the model passes two guards:
    sufficient warm-up data and a low running prediction-error EMA.

    Args:
        control: Step 6 differential SARSA configuration.
        observation_dim: Flat observation dimensionality.
        n_actions: Number of discrete actions (must match
            ``control.n_actions``).
        model_hidden_sizes: MLP trunk widths for the world model. ``()``
            gives a linear model.
        model_step_size: Step-size for the world model learner.
        model_sparsity: Sparse-init fraction for the world model.
        model_use_layer_norm: Enable layer normalisation in the world model.
        model_gamma: Maximum discount (clips the predicted discount head).
        dreaming_warmup_steps: Real transitions required before any dream can
            be accepted.
        dreaming_max_model_error: Maximum allowed model prediction-error EMA
            for dream acceptance.  Set high (e.g. 1e30) to disable the error
            gate.
        model_error_decay: EMA decay for the model prediction-error tracker.
            Smaller values (e.g. 0.9) react faster to distribution shifts at
            the cost of higher variance.  Default 0.99 (slow, smooth).
        planning_budget: Number of dream steps per real transition.
        buffer_capacity: Number of recent real observations to retain for
            anchor sampling.
    """

    control: Step6DifferentialSARSAConfig = field(
        default_factory=Step6DifferentialSARSAConfig
    )
    observation_dim: int = 4
    n_actions: int = 2
    model_hidden_sizes: tuple[int, ...] = (64,)
    model_step_size: float = 0.03
    model_sparsity: float = 0.9
    model_use_layer_norm: bool = True
    model_gamma: float = 0.99
    dreaming_warmup_steps: int = 100
    dreaming_max_model_error: float = 1.0
    model_error_decay: float = 0.99
    behavior_model_step_size: float = 0.05
    planning_budget: int = 1
    dream_rollout_horizon: int = 1
    dream_candidate_count: int = 1
    dream_surprise_weight: float = 1.0
    dream_utility_weight: float = 1.0
    buffer_capacity: int = 64

    def __post_init__(self) -> None:
        """Validate hyperparameters."""
        if self.control.n_actions != self.n_actions:
            raise ValueError(
                f"control.n_actions ({self.control.n_actions}) must equal "
                f"n_actions ({self.n_actions})"
            )
        if self.planning_budget < 0:
            raise ValueError("planning_budget must be non-negative")
        if self.dreaming_warmup_steps < 0:
            raise ValueError("dreaming_warmup_steps must be non-negative")
        if self.dreaming_max_model_error < 0.0:
            raise ValueError("dreaming_max_model_error must be non-negative")
        if self.buffer_capacity < 1:
            raise ValueError("buffer_capacity must be positive")
        if self.behavior_model_step_size < 0.0:
            raise ValueError("behavior_model_step_size must be non-negative")
        if self.dream_rollout_horizon < 1:
            raise ValueError("dream_rollout_horizon must be positive")
        if self.dream_candidate_count < 1:
            raise ValueError("dream_candidate_count must be positive")

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["control"] = self.control.to_dict()
        payload["model_hidden_sizes"] = list(self.model_hidden_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step9DreamingConfig:
        """Reconstruct from :meth:`to_dict` output."""
        data = dict(payload)
        data["control"] = Step6DifferentialSARSAConfig.from_dict(
            cast(dict[str, object], data["control"])
        )
        hs = data.get("model_hidden_sizes", (64,))
        if isinstance(hs, list):
            data["model_hidden_sizes"] = tuple(int(v) for v in hs)
        return cls(**cast(Any, data))

    def to_world_model_config(self) -> ActionConditionedWorldModelConfig:
        """Return the core world-model config."""
        return ActionConditionedWorldModelConfig(
            observation_dim=self.observation_dim,
            n_actions=self.n_actions,
            hidden_sizes=self.model_hidden_sizes,
            step_size=self.model_step_size,
            sparsity=self.model_sparsity,
            use_layer_norm=self.model_use_layer_norm,
            gamma=self.model_gamma,
            error_decay=self.model_error_decay,
        )


@chex.dataclass(frozen=True)
class Step9DreamingState:
    """Combined Step 9 state."""

    control_state: DifferentialSARSAState
    world_model_state: ActionConditionedWorldModelState
    behavior_model_state: BehaviorModelState
    buffer_state: RecentObservationBufferState
    step_count: Array


@chex.dataclass(frozen=True)
class Step9DreamingUpdateResult:
    """Result from one real transition plus guarded dreaming."""

    state: Step9DreamingState
    real_control_result: DifferentialSARSAUpdateResult
    real_model_result: WorldModelUpdateResult
    dream_td_errors: Array
    dream_accepted: Array


@chex.dataclass(frozen=True)
class Step9ArrayResult:
    """Scan result for Step 9 dreaming over real transition arrays."""

    state: Step9DreamingState
    real_td_errors: Array
    average_rewards: Array
    actions: Array
    model_prediction_errors: Array
    dream_td_errors: Array
    dream_accepted: Array


@dataclass(frozen=True)
class Step9SmokeResult:
    """Summary returned by :func:`run_step9_smoke`."""

    config: Step9DreamingConfig
    steps: int
    seed: int
    real_td_errors_shape: tuple[int, ...]
    dream_td_errors_shape: tuple[int, ...]
    actions_shape: tuple[int, ...]
    finite: bool
    dream_acceptance_count: int
    control_config: dict[str, Any]
    world_model_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["real_td_errors_shape"] = list(self.real_td_errors_shape)
        payload["dream_td_errors_shape"] = list(self.dream_td_errors_shape)
        payload["actions_shape"] = list(self.actions_shape)
        return payload


def make_step9_components(
    config: Step9DreamingConfig | None = None,
) -> tuple[DifferentialSARSAAgent, ActionConditionedWorldModel, RecentObservationBuffer]:
    """Create the Step 9 control agent, world model, and observation buffer."""
    cfg = config or Step9DreamingConfig()
    agent = make_step6_differential_sarsa_agent(cfg.control)
    model = ActionConditionedWorldModel(cfg.to_world_model_config())
    buffer = RecentObservationBuffer(cfg.buffer_capacity, cfg.observation_dim)
    return agent, model, buffer


def init_step9_state(
    agent: DifferentialSARSAAgent,
    model: ActionConditionedWorldModel,
    buffer: RecentObservationBuffer,
    *,
    key: Array,
    initial_observation: Array,
) -> Step9DreamingState:
    """Initialize and prime the Step 9 state."""
    control_key, model_key, behavior_key = jr.split(key, 3)
    feature_dim = int(jnp.ravel(initial_observation).shape[0])
    control_state = agent.init(feature_dim, control_key)
    control_state, _ = agent.start(control_state, initial_observation)
    behavior_model = BehaviorModel(
        BehaviorModelConfig(
            n_actions=agent.config.n_actions,
        )
    )
    buffer_state = buffer.init()
    buffer_state = buffer.add(buffer_state, initial_observation)
    return Step9DreamingState(
        control_state=control_state,
        world_model_state=model.init(model_key),
        behavior_model_state=behavior_model.init(feature_dim, behavior_key),
        buffer_state=buffer_state,
        step_count=jnp.array(0, dtype=jnp.int32),
    )


@functools.partial(jax.jit, static_argnums=(0, 1, 2, 3))
def step9_update(
    config: Step9DreamingConfig,
    agent: DifferentialSARSAAgent,
    model: ActionConditionedWorldModel,
    buffer: RecentObservationBuffer,
    state: Step9DreamingState,
    reward: Array,
    next_observation: Array,
) -> Step9DreamingUpdateResult:
    """Run one foreground real update plus error-gated dreaming.

    The real model update always executes first.  The freshly updated model
    error EMA then gates each dream in the planning budget: a dream is
    accepted when ``model_state.step_count >= dreaming_warmup_steps`` AND
    ``model_state.model_error_ema <= dreaming_max_model_error`` AND the
    predicted transition is numerically finite.
    """
    real_model_result = model.update(
        state.world_model_state,
        state.control_state.last_observation,
        state.control_state.last_action,
        reward,
        jnp.asarray(config.model_gamma, dtype=jnp.float32),
        next_observation,
    )
    real_control_result = agent.update(state.control_state, reward, next_observation)
    control_after_real = real_control_result.state
    model_state = cast(ActionConditionedWorldModelState, real_model_result.state)
    behavior_model = BehaviorModel(
        BehaviorModelConfig(
            n_actions=config.n_actions,
            step_size=config.behavior_model_step_size,
        )
    )
    behavior_after_real = behavior_model.update(
        state.behavior_model_state,
        state.control_state.last_observation,
        state.control_state.last_action,
    ).state

    buffer_state = buffer.add(state.buffer_state, next_observation)

    warmup_ready = model_state.step_count >= config.dreaming_warmup_steps
    error_ok = (
        model_state.model_error_ema
        <= jnp.asarray(config.dreaming_max_model_error, dtype=jnp.float32)
    )
    dream_gate = warmup_ready & error_ok

    def dream_step(
        carry: tuple[DifferentialSARSAState, BehaviorModelState, Array],
        _: Array,
    ) -> tuple[tuple[DifferentialSARSAState, BehaviorModelState, Array], tuple[Array, Array]]:
        ctrl_state, behavior_state, key = carry
        key, candidate_key = jr.split(key)
        candidate_keys = jr.split(candidate_key, config.dream_candidate_count)

        def candidate_step(candidate_item: tuple[Array, Array]) -> tuple[Array, ...]:
            index, cand_key = candidate_item
            del index
            anchor_key, sample_key = jr.split(cand_key)
            anchor_obs, _ = buffer.sample(buffer_state, anchor_key)
            behavior_for_sample = behavior_state.replace(
                rng_key=sample_key
            )
            behavior_sample = behavior_model.sample_action(
                behavior_for_sample,
                anchor_obs,
            )
            prediction = model.predict(model_state, anchor_obs, behavior_sample.action)
            transition_magnitude = jnp.mean(
                (prediction.next_observation - anchor_obs) ** 2
            )
            surprise = transition_magnitude + jnp.abs(prediction.reward)
            utility = jnp.abs(prediction.reward)
            return (
                anchor_obs,
                behavior_sample.action,
                behavior_sample.action_probability,
                surprise,
                utility,
                prediction.discount,
                prediction.reward,
            )

        (
            candidate_anchors,
            candidate_actions,
            candidate_probabilities,
            candidate_surprises,
            candidate_utilities,
            candidate_discounts,
            _candidate_rewards,
        ) = jax.vmap(candidate_step)(
            (
                jnp.arange(config.dream_candidate_count, dtype=jnp.int32),
                candidate_keys,
            )
        )
        selection = score_dream_candidates(
            candidate_surprises,
            candidate_utilities,
            confidences=candidate_probabilities,
            model_errors=jnp.full(
                (config.dream_candidate_count,),
                model_state.model_error_ema,
                dtype=jnp.float32,
            ),
            config=DreamSelectionConfig(
                max_items=1,
                surprise_weight=config.dream_surprise_weight,
                utility_weight=config.dream_utility_weight,
                confidence_weight=0.0,
                model_error_weight=1.0,
                max_model_error=config.dreaming_max_model_error,
            ),
        )
        selected_index = selection.selected_indices[0]
        anchor_obs = candidate_anchors[selected_index]
        action = candidate_actions[selected_index]
        initial_behavior_state = behavior_state.replace(
            rng_key=key
        )

        def rollout_step(
            rollout_carry: tuple[
                DifferentialSARSAState,
                BehaviorModelState,
                Array,
                Array,
            ],
            _: Array,
        ) -> tuple[
            tuple[DifferentialSARSAState, BehaviorModelState, Array, Array],
            tuple[Array, Array],
        ]:
            rollout_ctrl, rollout_behavior, rollout_obs, rollout_action = (
                rollout_carry
            )
            prediction = model.predict(model_state, rollout_obs, rollout_action)
            temp_state = rollout_ctrl.replace(
                last_observation=rollout_obs,
                last_action=rollout_action,
            )
            dream_result = agent.update(
                temp_state,
                prediction.reward,
                prediction.next_observation,
            )
            next_behavior = behavior_model.sample_action(
                rollout_behavior,
                prediction.next_observation,
            )
            return (
                dream_result.state,
                next_behavior.state,
                prediction.next_observation,
                next_behavior.action,
            ), (
                dream_result.td_error,
                prediction.discount,
            )

        (
            (rollout_ctrl, rollout_behavior, _rollout_obs, _rollout_action),
            (rollout_td_errors, rollout_discounts),
        ) = jax.lax.scan(
            rollout_step,
            (ctrl_state, initial_behavior_state, anchor_obs, action),
            jnp.arange(config.dream_rollout_horizon, dtype=jnp.int32),
        )
        rollout_td_signal = jnp.sum(rollout_td_errors)
        finite = jnp.all(jnp.isfinite(rollout_td_errors)) & jnp.all(
            jnp.isfinite(rollout_discounts)
        )
        selected_discount = candidate_discounts[selected_index]
        selected_accepted = selection.accepted[selected_index]
        accepted = (
            dream_gate
            & finite
            & selected_accepted
            & (selected_discount >= 0.0)
        )

        restored = rollout_ctrl.replace(
            last_observation=control_after_real.last_observation,
            last_action=control_after_real.last_action,
            rng_key=rollout_ctrl.rng_key,
        )
        next_ctrl = cast(
            DifferentialSARSAState,
            jax.tree_util.tree_map(
                lambda new, old: jnp.where(accepted, new, old),
                restored,
                ctrl_state,
            ),
        )
        next_behavior = cast(
            BehaviorModelState,
            jax.tree_util.tree_map(
                lambda new, old: jnp.where(accepted, new, old),
                rollout_behavior,
                behavior_state,
            ),
        )
        return (next_ctrl, next_behavior, key), (
            jnp.where(accepted, rollout_td_signal, jnp.array(0.0, dtype=jnp.float32)),
            accepted,
        )

    (final_ctrl, final_behavior, _), (dream_td_errors, dream_accepted) = jax.lax.scan(
        dream_step,
        (control_after_real, behavior_after_real, control_after_real.rng_key),
        jnp.arange(config.planning_budget, dtype=jnp.int32),
    )

    new_state = Step9DreamingState(
        control_state=final_ctrl,
        world_model_state=model_state,
        behavior_model_state=final_behavior,
        buffer_state=buffer_state,
        step_count=state.step_count + 1,
    )
    return Step9DreamingUpdateResult(
        state=new_state,
        real_control_result=real_control_result,
        real_model_result=real_model_result,
        dream_td_errors=dream_td_errors,
        dream_accepted=dream_accepted,
    )


def run_step9_scan(
    config: Step9DreamingConfig,
    agent: DifferentialSARSAAgent,
    model: ActionConditionedWorldModel,
    buffer: RecentObservationBuffer,
    state: Step9DreamingState,
    rewards: Array,
    next_observations: Array,
) -> Step9ArrayResult:
    """Run Step 9 dreaming over real continuing transition arrays."""

    def scan_step(
        carry: Step9DreamingState,
        inputs: tuple[Array, Array],
    ) -> tuple[Step9DreamingState, tuple[Array, ...]]:
        reward, next_observation = inputs
        result = step9_update(config, agent, model, buffer, carry, reward, next_observation)
        return result.state, (
            result.real_control_result.td_error,
            result.real_control_result.average_reward,
            result.real_control_result.action,
            result.real_model_result.prediction_error,
            result.dream_td_errors,
            result.dream_accepted,
        )

    final_state, (
        real_td_errors,
        average_rewards,
        actions,
        model_prediction_errors,
        dream_td_errors,
        dream_accepted,
    ) = jax.lax.scan(scan_step, state, (rewards, next_observations))
    return Step9ArrayResult(
        state=final_state,
        real_td_errors=real_td_errors,
        average_rewards=average_rewards,
        actions=actions,
        model_prediction_errors=model_prediction_errors,
        dream_td_errors=dream_td_errors,
        dream_accepted=dream_accepted,
    )


def run_step9_smoke(
    config: Step9DreamingConfig | None = None,
    *,
    steps: int = 32,
    seed: int = 0,
) -> Step9SmokeResult:
    """Run a tiny deterministic Step 9 dreaming integration probe."""
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config or Step9DreamingConfig()
    agent, model, buffer = make_step9_components(cfg)
    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(
        data_key,
        (steps + 1, cfg.observation_dim),
        dtype=jnp.float32,
    )
    rewards = jnp.tanh(observations[1:, 0])

    state = init_step9_state(
        agent,
        model,
        buffer,
        key=state_key,
        initial_observation=observations[0],
    )
    result = run_step9_scan(cfg, agent, model, buffer, state, rewards, observations[1:])
    result.real_td_errors.block_until_ready()
    finite = bool(
        jnp.all(jnp.isfinite(result.real_td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
        & jnp.all(jnp.isfinite(result.model_prediction_errors))
        & jnp.all(jnp.isfinite(result.dream_td_errors))
        & jnp.all(result.actions >= 0)
        & jnp.all(result.actions < cfg.n_actions)
    )
    return Step9SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        real_td_errors_shape=tuple(int(d) for d in result.real_td_errors.shape),
        dream_td_errors_shape=tuple(int(d) for d in result.dream_td_errors.shape),
        actions_shape=tuple(int(d) for d in result.actions.shape),
        finite=finite,
        dream_acceptance_count=int(jnp.sum(result.dream_accepted)),
        control_config=agent.to_config(),
        world_model_config=model.to_config(),
    )
