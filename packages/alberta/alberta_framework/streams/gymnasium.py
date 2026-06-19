"""Gymnasium environment wrappers as experience streams.

This module wraps Gymnasium environments to provide temporally-uniform experience
streams compatible with the Alberta Framework's learners.

Gymnasium environments cannot be JIT-compiled, so this module provides:
1. Trajectory collection: Collect data using Python loop, then learn with scan
2. Online learning: Python loop for cases requiring real-time env interaction

Supports multiple prediction modes:
- REWARD: Predict immediate reward from (state, action)
- NEXT_STATE: Predict next state from (state, action)
- VALUE: Predict cumulative return via TD learning
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from enum import Enum
from typing import TYPE_CHECKING, Any

import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.learners import LinearLearner
from alberta_framework.core.types import LearnerState, TimeStep

if TYPE_CHECKING:
    import gymnasium


class PredictionMode(Enum):
    """Mode for what the stream predicts.

    REWARD: Predict immediate reward from (state, action)
    NEXT_STATE: Predict next state from (state, action)
    VALUE: Predict cumulative return (TD learning with bootstrap)
    """

    REWARD = "reward"
    NEXT_STATE = "next_state"
    VALUE = "value"


def _flatten_space(space: gymnasium.spaces.Space[Any]) -> int:
    """Get the flattened dimension of a Gymnasium space.

    Args:
        space: A Gymnasium space (Box, Discrete, MultiDiscrete)

    Returns:
        Integer dimension of the flattened space

    Raises:
        ValueError: If space type is not supported
    """
    import gymnasium

    if isinstance(space, gymnasium.spaces.Box):
        return int(jnp.prod(jnp.array(space.shape)))
    elif isinstance(space, gymnasium.spaces.Discrete):
        return 1
    elif isinstance(space, gymnasium.spaces.MultiDiscrete):
        return len(space.nvec)
    else:
        raise ValueError(
            f"Unsupported space type: {type(space).__name__}. "
            "Supported types: Box, Discrete, MultiDiscrete"
        )


def _flatten_observation(obs: Any, space: gymnasium.spaces.Space[Any]) -> Array:
    """Flatten an observation to a 1D JAX array.

    Args:
        obs: Observation from the environment
        space: The observation space

    Returns:
        Flattened observation as a 1D JAX array
    """
    import gymnasium

    if isinstance(space, gymnasium.spaces.Box):
        return jnp.asarray(obs, dtype=jnp.float32).flatten()
    elif isinstance(space, gymnasium.spaces.Discrete):
        return jnp.array([float(obs)], dtype=jnp.float32)
    elif isinstance(space, gymnasium.spaces.MultiDiscrete):
        return jnp.asarray(obs, dtype=jnp.float32)
    else:
        raise ValueError(f"Unsupported space type: {type(space).__name__}")


def _flatten_action(action: Any, space: gymnasium.spaces.Space[Any]) -> Array:
    """Flatten an action to a 1D JAX array.

    Args:
        action: Action for the environment
        space: The action space

    Returns:
        Flattened action as a 1D JAX array
    """
    import gymnasium

    if isinstance(space, gymnasium.spaces.Box):
        return jnp.asarray(action, dtype=jnp.float32).flatten()
    elif isinstance(space, gymnasium.spaces.Discrete):
        return jnp.array([float(action)], dtype=jnp.float32)
    elif isinstance(space, gymnasium.spaces.MultiDiscrete):
        return jnp.asarray(action, dtype=jnp.float32)
    else:
        raise ValueError(f"Unsupported space type: {type(space).__name__}")


def make_random_policy(env: gymnasium.Env[Any, Any], seed: int = 0) -> Callable[[Array], Any]:
    """Create a random action policy for an environment.

    Args:
        env: Gymnasium environment
        seed: Random seed

    Returns:
        A callable that takes an observation and returns a random action
    """
    import gymnasium

    rng = jr.key(seed)
    action_space = env.action_space

    def policy(_obs: Array) -> Any:
        nonlocal rng
        rng, key = jr.split(rng)

        if isinstance(action_space, gymnasium.spaces.Discrete):
            return int(jr.randint(key, (), 0, int(action_space.n)))
        elif isinstance(action_space, gymnasium.spaces.Box):
            # Sample uniformly between low and high
            low = jnp.asarray(action_space.low, dtype=jnp.float32)
            high = jnp.asarray(action_space.high, dtype=jnp.float32)
            return jr.uniform(key, action_space.shape, minval=low, maxval=high)
        elif isinstance(action_space, gymnasium.spaces.MultiDiscrete):
            nvec = action_space.nvec
            return [int(jr.randint(jr.fold_in(key, i), (), 0, n)) for i, n in enumerate(nvec)]
        else:
            raise ValueError(f"Unsupported action space: {type(action_space).__name__}")

    return policy


def make_epsilon_greedy_policy(
    base_policy: Callable[[Array], Any],
    env: gymnasium.Env[Any, Any],
    epsilon: float = 0.1,
    seed: int = 0,
) -> Callable[[Array], Any]:
    """Wrap a policy with epsilon-greedy exploration.

    Args:
        base_policy: The greedy policy to wrap
        env: Gymnasium environment (for random action sampling)
        epsilon: Probability of taking a random action
        seed: Random seed

    Returns:
        Epsilon-greedy policy
    """
    random_policy = make_random_policy(env, seed + 1)
    rng = jr.key(seed)

    def policy(obs: Array) -> Any:
        nonlocal rng
        rng, key = jr.split(rng)

        if jr.uniform(key) < epsilon:
            return random_policy(obs)
        return base_policy(obs)

    return policy


def collect_trajectory(
    env: gymnasium.Env[Any, Any],
    policy: Callable[[Array], Any] | None,
    num_steps: int,
    mode: PredictionMode = PredictionMode.REWARD,
    include_action_in_features: bool = True,
    seed: int = 0,
) -> tuple[Array, Array]:
    """Collect a trajectory from a Gymnasium environment.

    This uses a Python loop to interact with the environment and collects
    observations and targets into JAX arrays that can be used with scan-based
    learning.

    Args:
        env: Gymnasium environment instance
        policy: Action selection function. If None, uses random policy
        num_steps: Number of steps to collect
        mode: What to predict (REWARD, NEXT_STATE, VALUE)
        include_action_in_features: If True, features = concat(obs, action)
        seed: Random seed for environment resets and random policy

    Returns:
        Tuple of (observations, targets) as JAX arrays with shape
        (num_steps, feature_dim) and (num_steps, target_dim)
    """
    if policy is None:
        policy = make_random_policy(env, seed)

    observations = []
    targets = []

    reset_count = 0
    raw_obs, _ = env.reset(seed=seed + reset_count)
    reset_count += 1
    current_obs = _flatten_observation(raw_obs, env.observation_space)

    for _ in range(num_steps):
        action = policy(current_obs)
        flat_action = _flatten_action(action, env.action_space)

        raw_next_obs, reward, terminated, truncated, _ = env.step(action)
        next_obs = _flatten_observation(raw_next_obs, env.observation_space)

        # Construct features
        if include_action_in_features:
            features = jnp.concatenate([current_obs, flat_action])
        else:
            features = current_obs

        # Construct target based on mode
        if mode == PredictionMode.REWARD:
            target = jnp.atleast_1d(jnp.array(reward, dtype=jnp.float32))
        elif mode == PredictionMode.NEXT_STATE:
            target = next_obs
        else:  # VALUE mode
            # TD target with 0 bootstrap (simple version)
            target = jnp.atleast_1d(jnp.array(reward, dtype=jnp.float32))

        observations.append(features)
        targets.append(target)

        if terminated or truncated:
            raw_obs, _ = env.reset(seed=seed + reset_count)
            reset_count += 1
            current_obs = _flatten_observation(raw_obs, env.observation_space)
        else:
            current_obs = next_obs

    return jnp.stack(observations), jnp.stack(targets)


def learn_from_trajectory(
    learner: LinearLearner,
    observations: Array,
    targets: Array,
    learner_state: LearnerState | None = None,
) -> tuple[LearnerState, Array]:
    """Learn from a pre-collected trajectory using jax.lax.scan.

    This is a JIT-compiled learning function that processes a trajectory
    collected from a Gymnasium environment.

    Args:
        learner: The learner to train
        observations: Array of observations with shape (num_steps, feature_dim)
        targets: Array of targets with shape (num_steps, target_dim)
        learner_state: Initial state (if None, will be initialized)

    Returns:
        Tuple of (final_state, metrics_array) where metrics_array has shape
        (num_steps, 3) with columns [squared_error, error, mean_step_size]
    """
    if learner_state is None:
        learner_state = learner.init(observations.shape[1])

    def step_fn(state: LearnerState, inputs: tuple[Array, Array]) -> tuple[LearnerState, Array]:
        obs, target = inputs
        result = learner.update(state, obs, target)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, learner_state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]

    return final_state, metrics


def learn_from_trajectory_normalized(
    learner: LinearLearner,
    observations: Array,
    targets: Array,
    learner_state: LearnerState | None = None,
) -> tuple[LearnerState, Array]:
    """Learn from a pre-collected trajectory with normalization using jax.lax.scan.

    This is equivalent to ``learn_from_trajectory`` for a learner constructed
    with a normalizer (e.g. ``LinearLearner(optimizer=..., normalizer=EMANormalizer())``).
    Retained for backward compatibility.

    Args:
        learner: The learner to train (should have a normalizer configured)
        observations: Array of observations with shape (num_steps, feature_dim)
        targets: Array of targets with shape (num_steps, target_dim)
        learner_state: Initial state (if None, will be initialized)

    Returns:
        Tuple of (final_state, metrics_array) where metrics_array has shape
        (num_steps, 4) with columns [squared_error, error, mean_step_size, normalizer_mean_var]
    """
    return learn_from_trajectory(learner, observations, targets, learner_state)


class GymnasiumStream:
    """Experience stream from a Gymnasium environment using Python loop.

    This class maintains iterator-based access for online learning scenarios
    where you need to interact with the environment in real-time.

    For batch learning, use collect_trajectory() followed by learn_from_trajectory().

    Attributes:
        mode: Prediction mode (REWARD, NEXT_STATE, VALUE)
        gamma: Discount factor for VALUE mode
        include_action_in_features: Whether to include action in features
        episode_count: Number of completed episodes
    """

    def __init__(
        self,
        env: gymnasium.Env[Any, Any],
        mode: PredictionMode = PredictionMode.REWARD,
        policy: Callable[[Array], Any] | None = None,
        gamma: float = 0.99,
        include_action_in_features: bool = True,
        seed: int = 0,
    ):
        """Initialize the Gymnasium stream.

        Args:
            env: Gymnasium environment instance
            mode: What to predict (REWARD, NEXT_STATE, VALUE)
            policy: Action selection function. If None, uses random policy
            gamma: Discount factor for VALUE mode
            include_action_in_features: If True, features = concat(obs, action).
                If False, features = obs only
            seed: Random seed for environment resets and random policy
        """
        self._env = env
        self._mode = mode
        self._gamma = gamma
        self._include_action_in_features = include_action_in_features
        self._seed = seed
        self._reset_count = 0

        if policy is None:
            self._policy = make_random_policy(env, seed)
        else:
            self._policy = policy

        self._obs_dim = _flatten_space(env.observation_space)
        self._action_dim = _flatten_space(env.action_space)

        if include_action_in_features:
            self._feature_dim = self._obs_dim + self._action_dim
        else:
            self._feature_dim = self._obs_dim

        if mode == PredictionMode.NEXT_STATE:
            self._target_dim = self._obs_dim
        else:
            self._target_dim = 1

        self._current_obs: Array | None = None
        self._episode_count = 0
        self._step_count = 0
        self._value_estimator: Callable[[Array], float] | None = None

    @property
    def feature_dim(self) -> int:
        """Return the dimension of feature vectors."""
        return self._feature_dim

    @property
    def target_dim(self) -> int:
        """Return the dimension of target vectors."""
        return self._target_dim

    @property
    def episode_count(self) -> int:
        """Return the number of completed episodes."""
        return self._episode_count

    @property
    def step_count(self) -> int:
        """Return the total number of steps taken."""
        return self._step_count

    @property
    def mode(self) -> PredictionMode:
        """Return the prediction mode."""
        return self._mode

    def set_value_estimator(self, estimator: Callable[[Array], float]) -> None:
        """Set the value estimator for proper TD learning in VALUE mode."""
        self._value_estimator = estimator

    def _get_reset_seed(self) -> int:
        """Get the seed for the next environment reset."""
        seed = self._seed + self._reset_count
        self._reset_count += 1
        return seed

    def _construct_features(self, obs: Array, action: Array) -> Array:
        """Construct feature vector from observation and action."""
        if self._include_action_in_features:
            return jnp.concatenate([obs, action])
        return obs

    def _construct_target(
        self,
        reward: float,
        next_obs: Array,
        terminated: bool,
    ) -> Array:
        """Construct target based on prediction mode."""
        if self._mode == PredictionMode.REWARD:
            return jnp.atleast_1d(jnp.array(reward, dtype=jnp.float32))

        elif self._mode == PredictionMode.NEXT_STATE:
            return next_obs

        elif self._mode == PredictionMode.VALUE:
            if terminated:
                return jnp.atleast_1d(jnp.array(reward, dtype=jnp.float32))

            if self._value_estimator is not None:
                next_value = self._value_estimator(next_obs)
            else:
                next_value = 0.0

            target = reward + self._gamma * next_value
            return jnp.atleast_1d(jnp.array(target, dtype=jnp.float32))

        else:
            raise ValueError(f"Unknown mode: {self._mode}")

    def __iter__(self) -> Iterator[TimeStep]:
        """Return self as iterator."""
        return self

    def __next__(self) -> TimeStep:
        """Generate the next time step."""
        if self._current_obs is None:
            raw_obs, _ = self._env.reset(seed=self._get_reset_seed())
            self._current_obs = _flatten_observation(raw_obs, self._env.observation_space)

        action = self._policy(self._current_obs)
        flat_action = _flatten_action(action, self._env.action_space)

        raw_next_obs, reward, terminated, truncated, _ = self._env.step(action)
        next_obs = _flatten_observation(raw_next_obs, self._env.observation_space)

        features = self._construct_features(self._current_obs, flat_action)
        target = self._construct_target(float(reward), next_obs, terminated)

        self._step_count += 1

        if terminated or truncated:
            self._episode_count += 1
            self._current_obs = None
        else:
            self._current_obs = next_obs

        return TimeStep(observation=features, target=target)


class TDStream:
    """Experience stream for proper TD learning with value function bootstrap.

    This stream integrates with a learner to use its predictions for
    bootstrapping in TD targets.

    Usage:
        stream = TDStream(env)
        learner = LinearLearner(optimizer=IDBD())
        state = learner.init(stream.feature_dim)

        for step, timestep in enumerate(stream):
            result = learner.update(state, timestep.observation, timestep.target)
            state = result.state
            stream.update_value_function(lambda x: learner.predict(state, x))
    """

    def __init__(
        self,
        env: gymnasium.Env[Any, Any],
        policy: Callable[[Array], Any] | None = None,
        gamma: float = 0.99,
        include_action_in_features: bool = False,
        seed: int = 0,
    ):
        """Initialize the TD stream.

        Args:
            env: Gymnasium environment instance
            policy: Action selection function. If None, uses random policy
            gamma: Discount factor
            include_action_in_features: If True, learn Q(s,a). If False, learn V(s)
            seed: Random seed
        """
        self._env = env
        self._gamma = gamma
        self._include_action_in_features = include_action_in_features
        self._seed = seed
        self._reset_count = 0

        if policy is None:
            self._policy = make_random_policy(env, seed)
        else:
            self._policy = policy

        self._obs_dim = _flatten_space(env.observation_space)
        self._action_dim = _flatten_space(env.action_space)

        if include_action_in_features:
            self._feature_dim = self._obs_dim + self._action_dim
        else:
            self._feature_dim = self._obs_dim

        self._current_obs: Array | None = None
        self._episode_count = 0
        self._step_count = 0
        self._value_fn: Callable[[Array], float] = lambda x: 0.0

    @property
    def feature_dim(self) -> int:
        """Return the dimension of feature vectors."""
        return self._feature_dim

    @property
    def episode_count(self) -> int:
        """Return the number of completed episodes."""
        return self._episode_count

    @property
    def step_count(self) -> int:
        """Return the total number of steps taken."""
        return self._step_count

    def update_value_function(self, value_fn: Callable[[Array], float]) -> None:
        """Update the value function used for TD bootstrapping."""
        self._value_fn = value_fn

    def _get_reset_seed(self) -> int:
        """Get the seed for the next environment reset."""
        seed = self._seed + self._reset_count
        self._reset_count += 1
        return seed

    def _construct_features(self, obs: Array, action: Array) -> Array:
        """Construct feature vector from observation and action."""
        if self._include_action_in_features:
            return jnp.concatenate([obs, action])
        return obs

    def __iter__(self) -> Iterator[TimeStep]:
        """Return self as iterator."""
        return self

    def __next__(self) -> TimeStep:
        """Generate the next time step with TD target."""
        if self._current_obs is None:
            raw_obs, _ = self._env.reset(seed=self._get_reset_seed())
            self._current_obs = _flatten_observation(raw_obs, self._env.observation_space)

        action = self._policy(self._current_obs)
        flat_action = _flatten_action(action, self._env.action_space)

        raw_next_obs, reward, terminated, truncated, _ = self._env.step(action)
        next_obs = _flatten_observation(raw_next_obs, self._env.observation_space)

        features = self._construct_features(self._current_obs, flat_action)
        next_features = self._construct_features(next_obs, flat_action)

        if terminated:
            target = jnp.atleast_1d(jnp.array(reward, dtype=jnp.float32))
        else:
            bootstrap = self._value_fn(next_features)
            target_val = float(reward) + self._gamma * float(bootstrap)
            target = jnp.atleast_1d(jnp.array(target_val, dtype=jnp.float32))

        self._step_count += 1

        if terminated or truncated:
            self._episode_count += 1
            self._current_obs = None
        else:
            self._current_obs = next_obs

        return TimeStep(observation=features, target=target)


def make_gymnasium_stream(
    env_id: str,
    mode: PredictionMode = PredictionMode.REWARD,
    policy: Callable[[Array], Any] | None = None,
    gamma: float = 0.99,
    include_action_in_features: bool = True,
    seed: int = 0,
    **env_kwargs: Any,
) -> GymnasiumStream:
    """Factory function to create a GymnasiumStream from an environment ID.

    Args:
        env_id: Gymnasium environment ID (e.g., "CartPole-v1")
        mode: What to predict (REWARD, NEXT_STATE, VALUE)
        policy: Action selection function. If None, uses random policy
        gamma: Discount factor for VALUE mode
        include_action_in_features: If True, features = concat(obs, action)
        seed: Random seed
        **env_kwargs: Additional arguments passed to gymnasium.make()

    Returns:
        GymnasiumStream wrapping the environment
    """
    import gymnasium

    env = gymnasium.make(env_id, **env_kwargs)
    return GymnasiumStream(
        env=env,
        mode=mode,
        policy=policy,
        gamma=gamma,
        include_action_in_features=include_action_in_features,
        seed=seed,
    )
