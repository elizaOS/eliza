"""Continual behaviour-cloning of command skills: multi-head retains, finetune forgets.

Mechanism test on a synthetic command-conditioned teacher (no env / no GPU): each
command maps observations to a distinct action function. Learning the commands
sequentially, the per-command-head student must retain earlier commands while the
single-head finetune student forgets them.
"""

from __future__ import annotations

import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.rl.text_conditioned.walking_continual import (
    BCStudentConfig,
    run_continual_bc,
)


def _synthetic_teacher_data(n_commands=3, obs_dim=12, action_dim=4, n=1500, seed=0):
    """Each command c has a distinct teacher a_c(obs)=tanh(M_c obs + v_c)."""
    rng = np.random.default_rng(seed)
    Ms = [rng.standard_normal((action_dim, obs_dim)).astype(np.float32) * 0.7 for _ in range(n_commands)]
    vs = [rng.standard_normal(action_dim).astype(np.float32) * 0.3 for _ in range(n_commands)]
    commands = [f"cmd{c}" for c in range(n_commands)]

    def make(split_seed):
        r = np.random.default_rng(split_seed)
        data = {}
        for c in range(n_commands):
            obs = r.standard_normal((n, obs_dim)).astype(np.float32)
            acts = np.tanh(obs @ Ms[c].T + vs[c]).astype(np.float32)
            data[commands[c]] = (obs, acts)
        return data

    return commands, make(1), make(2)


def test_multihead_retains_finetune_forgets():
    commands, train, ev = _synthetic_teacher_data()
    common = dict(obs_dim=12, action_dim=4, n_commands=len(commands), hidden_sizes=(128, 128), lr=3e-3)

    mh = run_continual_bc(BCStudentConfig(mode="multihead", **common), commands, train, ev)
    ft = run_continual_bc(BCStudentConfig(mode="finetune", **common), commands, train, ev)

    # Multi-head: per-command heads over a frozen-after-phase0 trunk => earlier
    # commands are literally untouched by later phases => zero forgetting.
    assert mh.forgetting <= 0.05, f"multihead should retain, forgetting={mh.forgetting}"
    assert mh.bwt >= -0.05, f"multihead BWT should be ~0, got {mh.bwt}"

    # Finetune: one shared head retrained per command => catastrophic forgetting.
    assert ft.forgetting > mh.forgetting + 0.05, (
        f"finetune ({ft.forgetting}) should forget far more than multihead ({mh.forgetting})"
    )
    # Concretely, command 0's retained performance collapses under finetune.
    T = len(commands)
    mh_cmd0 = mh.perf_matrix[T - 1][0] - mh.perf_matrix[0][0]
    ft_cmd0 = ft.perf_matrix[T - 1][0] - ft.perf_matrix[0][0]
    assert ft_cmd0 < mh_cmd0 - 0.05, f"finetune must degrade command0 more (mh={mh_cmd0}, ft={ft_cmd0})"


def test_multihead_actually_learns_each_command():
    # Sanity: the multi-head student fits each command above a trivial baseline
    # (final-phase performance, i.e. negative MSE, beats predicting zeros).
    commands, train, ev = _synthetic_teacher_data()
    mh = run_continual_bc(
        BCStudentConfig(mode="multihead", obs_dim=12, action_dim=4, n_commands=len(commands),
                        hidden_sizes=(128, 128), lr=3e-3),
        commands, train, ev,
    )
    # baseline negative-MSE of predicting zeros ~ -mean(a^2) ~ -0.2..-0.5 for tanh targets
    zero_baseline = -float(np.mean([np.mean(ev[c][1] ** 2) for c in commands]))
    final = float(np.mean(mh.perf_matrix[-1]))
    assert final > zero_baseline + 0.02, f"multihead final {final} should beat zero-baseline {zero_baseline}"
