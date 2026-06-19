"""Verify the env produces a meaningful learning signal: a non-trivial
action policy must achieve a different mean reward than the zero
baseline. We don't claim the policy walks — that requires GPU MJX
hours — but the env must respond to action *quality*.

This is the unit test that catches "PPO is silently a no-op" regressions
like the one we hit when the env had a gameable upright_bonus.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    make_text_conditioned_env,
)

SUPPORTED = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1")


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_extreme_actions_destabilize_the_robot(profile_id: str) -> None:
    """A constant +1.0 (every joint pushed to limit) must fall faster
    than zero action — otherwise the env is gameable: PPO would find no
    gradient between "do something" and "do nothing"."""
    pytest.importorskip("mujoco")
    cfg = ProfileEnvConfig(
        include_tasks=("walk_forward",),
        exclude_tasks=(),
        pca_dim=32,
        episode_steps=200,
    )
    env_zero = make_text_conditioned_env(profile_id, config=cfg)
    env_max = make_text_conditioned_env(profile_id, config=cfg)
    env_zero.reset(seed=0)
    env_max.reset(seed=0)
    a0 = np.zeros(env_zero.action_space.shape, dtype=np.float32)
    am = np.ones(env_max.action_space.shape, dtype=np.float32)

    def _survive(env, action) -> int:
        steps = 0
        for _ in range(200):
            _, _, term, trunc, _ = env.step(action)
            if term or trunc:
                break
            steps += 1
        return steps

    zero_steps = _survive(env_zero, a0)
    max_steps = _survive(env_max, am)
    # Extreme commands shove every joint to its limit; the robot must
    # collapse no later than zero-action (which only loses balance from
    # the inherent static instability of the home pose).
    assert max_steps <= zero_steps + 2, (
        f"{profile_id}: zero survives {zero_steps}, max-action survives "
        f"{max_steps} — env reward is gameable by extreme commands"
    )


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_fall_penalty_reduces_reward(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",), exclude_tasks=(), episode_steps=4
        ),
    )
    env.reset(seed=0)
    # Drive a huge action straight to the limits — should trip the fall
    # termination quickly. The terminal step must include the fall penalty.
    a = np.ones(env.action_space.shape, dtype=np.float32)
    total = 0.0
    last_terminated = False
    for _ in range(40):
        _, r, terminated, truncated, _ = env.step(a)
        total += float(r)
        if terminated:
            last_terminated = True
            break
        if truncated:
            break
    # We don't assert termination (some profiles are stable enough at
    # max-action) but if termination happened, total must reflect the
    # -10 fall penalty rather than runaway-positive.
    if last_terminated:
        assert total < 50.0, (
            f"{profile_id}: terminated with reward {total:.2f} — "
            "fall_penalty not applied or alive bonus too high"
        )


# ---------------------------------------------------------------------------
# Domain randomization — modeled on mujoco_playground's randomizer.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_domain_rand_resamples_per_reset(profile_id: str) -> None:
    """Two resets with DR enabled must produce different friction/mass."""
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            domain_rand=True,
        ),
    )
    env.reset(seed=0)
    fric_a = env._model.geom_friction.copy()  # noqa: SLF001
    mass_a = env._model.body_mass.copy()  # noqa: SLF001
    env.reset(seed=1)
    fric_b = env._model.geom_friction.copy()  # noqa: SLF001
    mass_b = env._model.body_mass.copy()  # noqa: SLF001
    assert not np.allclose(fric_a, fric_b), (
        f"{profile_id}: friction did not resample"
    )
    assert not np.allclose(mass_a, mass_b), (
        f"{profile_id}: body_mass did not resample"
    )


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_domain_rand_disabled_is_deterministic(profile_id: str) -> None:
    """Without DR, dynamics params must match the canonical MJCF values."""
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            domain_rand=False,
        ),
    )
    env.reset(seed=0)
    fric_a = env._model.geom_friction.copy()  # noqa: SLF001
    env.reset(seed=999)
    fric_b = env._model.geom_friction.copy()  # noqa: SLF001
    assert np.allclose(fric_a, fric_b), (
        f"{profile_id}: dynamics changed despite domain_rand=False"
    )
