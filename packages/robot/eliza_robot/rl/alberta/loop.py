"""Online control loops that drive a gymnasium env with an Alberta controller.

The Alberta gymnasium bridge is prediction-only; control requires the agent's
own ``select_action`` in the act->update cycle. These helpers implement that
cycle as a *continuing* stream: the agent learns every step and survives
episode boundaries (it re-``start``s on the fresh observation but keeps its
weights), which is the whole point of continual learning.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from eliza_robot.rl.alberta.agent import AlbertaContinualController


@dataclass
class TrainStats:
    """Aggregate statistics from a training run."""

    total_steps: int
    episodes: int
    mean_episode_return: float
    last_episode_return: float
    episode_returns: list[float]


def train_online(
    controller: AlbertaContinualController,
    env,
    num_steps: int,
    *,
    max_episode_steps: int | None = None,
    seed: int | None = None,
) -> TrainStats:
    """Train ``controller`` on ``env`` for ``num_steps`` environment steps.

    The controller is *not* reset between episodes — only the env is — so
    learning accumulates across the whole stream. Returns per-episode returns
    for learning-curve plots.
    """
    obs, _info = env.reset(seed=seed)
    action = controller.start(np.asarray(obs, dtype=np.float32))

    episode_returns: list[float] = []
    ep_return = 0.0
    ep_len = 0
    steps = 0

    while steps < num_steps:
        next_obs, reward, terminated, truncated, _info = env.step(action)
        ep_return += float(reward)
        ep_len += 1
        steps += 1
        if max_episode_steps is not None and ep_len >= max_episode_steps:
            truncated = True

        action = controller.observe(
            float(reward),
            np.asarray(next_obs, dtype=np.float32),
            terminated=bool(terminated),
            truncated=bool(truncated),
        )

        if terminated or truncated:
            episode_returns.append(ep_return)
            ep_return = 0.0
            ep_len = 0
            obs, _info = env.reset()
            # Re-bootstrap on the fresh observation; weights are preserved.
            action = controller.start(np.asarray(obs, dtype=np.float32))

    mean_ret = float(np.mean(episode_returns)) if episode_returns else 0.0
    last_ret = episode_returns[-1] if episode_returns else 0.0
    return TrainStats(
        total_steps=steps,
        episodes=len(episode_returns),
        mean_episode_return=mean_ret,
        last_episode_return=last_ret,
        episode_returns=episode_returns,
    )


@dataclass
class EvalStats:
    """Aggregate statistics from a deterministic evaluation run."""

    episodes: int
    mean_return: float
    std_return: float
    mean_length: float
    returns: list[float]


def evaluate(
    controller: AlbertaContinualController,
    env,
    num_episodes: int,
    *,
    max_episode_steps: int | None = None,
    seed: int | None = None,
) -> EvalStats:
    """Evaluate the controller's greedy (mean) policy. No learning occurs."""
    returns: list[float] = []
    lengths: list[float] = []
    for ep in range(num_episodes):
        ep_seed = None if seed is None else seed + ep
        obs, _info = env.reset(seed=ep_seed)
        ep_return = 0.0
        ep_len = 0
        done = False
        while not done:
            action = controller.act_greedy(np.asarray(obs, dtype=np.float32))
            obs, reward, terminated, truncated, _info = env.step(action)
            ep_return += float(reward)
            ep_len += 1
            if max_episode_steps is not None and ep_len >= max_episode_steps:
                truncated = True
            done = bool(terminated or truncated)
        returns.append(ep_return)
        lengths.append(float(ep_len))
    return EvalStats(
        episodes=num_episodes,
        mean_return=float(np.mean(returns)) if returns else 0.0,
        std_return=float(np.std(returns)) if returns else 0.0,
        mean_length=float(np.mean(lengths)) if lengths else 0.0,
        returns=returns,
    )
